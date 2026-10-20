"""FastAPI server wrapping the ADK Runner, Google Maps grounding metadata, and BigQuery Admin Explorer."""

import asyncio
import base64
import datetime as dt
import json
import math
import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from google import genai
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.cloud import bigquery
from google.genai import types

from evacuation_agent.agent import root_agent
from evacuation_agent.prompts import SYSTEM_INSTRUCTION
from evacuation_agent.schemas import (
    ActionDecisionRequest,
    ActionDecisionResponse,
    ActionOption,
    ActionSeverity,
    ActionType,
    AgentSchemaOutput,
    ApprovalDetails,
    AttentionItem,
    ChatRequest,
    ChatResponse,
    InteractionMode,
    LocationInfo,
    MapsGroundingChunk,
    RecommendedAction,
)
from evacuation_agent.tools import (
    analyze_shelter_readiness,
    get_power_and_medical_gaps,
    get_vulnerable_tracts,
)

# Load .env from either agent/.env or the repository root .env
_AGENT_DIR = Path(__file__).resolve().parent
load_dotenv(_AGENT_DIR / ".env")
load_dotenv(_AGENT_DIR.parent / ".env")

DEPLOYED_AGENT_URL = os.environ.get(
    "DEPLOYED_AGENT_URL",
    "https://evac-readiness-agent-861336771001.us-east1.run.app",
).rstrip("/")
DEPLOYED_AGENT_APP = os.environ.get("DEPLOYED_AGENT_APP", "evac_agent")

app = FastAPI(
    title="Adaptive Evacuation Readiness ADK API",
    description="Backend API for Challenge 4: ADK Agent + BigQuery + Grounding with Google Maps",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

APP_NAME = "evacuation_readiness_app"
session_service = InMemorySessionService()
runner = Runner(agent=root_agent, app_name=APP_NAME, session_service=session_service)

ALLOWED_TABLES: Dict[str, Dict[str, str]] = {
    "shelters": {
        "role": "Places",
        "source": "FEMA ESF#6 National Shelter System",
        "description": "Every registered shelter in the state with coordinates, capacity, wheelchair_accessible, generator_onsite, and surge flags.",
    },
    "vulnerability_tracts": {
        "role": "People",
        "source": "Census ACS + CDC SVI 2022 + CDC PLACES 2025",
        "description": "One row per 2020 census tract: no-vehicle households, 65+, disability, mobility prevalence, and mobile homes.",
    },
    "hazard_tracts": {
        "role": "Places",
        "source": "FEMA National Risk Index (NRI)",
        "description": "Hurricane (HRCN_*) and coastal-flooding (CFLD_*) frequency, exposure, and expected annual loss per tract.",
    },
    "care_facilities": {
        "role": "People",
        "source": "CMS Nursing Home Provider Information",
        "description": "Medicare-certified nursing homes with coordinates, address, ownership type, and certified bed counts.",
    },
    "power_dependent_counties": {
        "role": "People",
        "source": "HHS emPOWER",
        "description": "County-level Medicare beneficiaries relying on electricity-dependent durable medical equipment (11 = 1-10 censored).",
    },
}


def _get_bq_client() -> tuple[Optional[bigquery.Client], str, str]:
    project = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("BQ_PROJECT") or ""
    dataset = os.environ.get("BQ_DATASET", "evacuation_readiness")
    try:
        client = bigquery.Client(project=project if project and project != "your-gcp-project-id" else None)
        resolved_project = client.project or project or "(unset)"
        return client, resolved_project, dataset
    except Exception:
        return None, project or "(unset)", dataset


def _sanitize_value(val: Any) -> Any:
    if val is None:
        return None
    if isinstance(val, float) and (math.isnan(val) or math.isinf(val)):
        return None
    return val


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "agent": root_agent.name,
        "model": root_agent.model,
        "project": os.environ.get("GOOGLE_CLOUD_PROJECT", "(unset)"),
        "state": os.environ.get("STATE", "FL"),
    }


@app.get("/api/admin/tables")
async def list_bigquery_tables():
    """Return metadata, row counts, schemas, and data-quality diagnostics for all 5 BigQuery tables."""
    client, project, dataset = _get_bq_client()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="BigQuery client not initialized. Set GOOGLE_CLOUD_PROJECT and run `gcloud auth application-default login`.",
        )

    tables_info = []
    for table_name, meta in ALLOWED_TABLES.items():
        table_ref = f"{project}.{dataset}.{table_name}"
        try:
            tbl = client.get_table(table_ref)
            schema_cols = [
                {
                    "name": field.name,
                    "type": field.field_type,
                    "mode": field.mode,
                }
                for field in tbl.schema
            ]
            tables_info.append(
                {
                    "table_name": table_name,
                    "role": meta["role"],
                    "source": meta["source"],
                    "description": meta["description"],
                    "status": "LOADED",
                    "row_count": tbl.num_rows,
                    "num_bytes": tbl.num_bytes,
                    "columns": schema_cols,
                }
            )
        except Exception as exc:
            tables_info.append(
                {
                    "table_name": table_name,
                    "role": meta["role"],
                    "source": meta["source"],
                    "description": meta["description"],
                    "status": "MISSING",
                    "row_count": 0,
                    "num_bytes": 0,
                    "columns": [],
                    "error": str(exc)[:200],
                }
            )

    return {
        "connected": True,
        "project": project,
        "dataset": dataset,
        "tables": tables_info,
    }


@app.get("/api/admin/tables/{table_name}/rows")
async def query_bigquery_table_rows(
    table_name: str,
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    county: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    quick_filter: Optional[str] = Query(default=None),
):
    """Query actual rows from one of the 5 BigQuery tables with optional filters and pagination."""
    if table_name not in ALLOWED_TABLES:
        raise HTTPException(status_code=400, detail=f"Invalid table: {table_name}")

    client, project, dataset = _get_bq_client()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="BigQuery client not initialized. Set GOOGLE_CLOUD_PROJECT and authenticate.",
        )

    table_ref = f"`{project}.{dataset}.{table_name}`"
    where_clauses: List[str] = []
    params: List[bigquery.ScalarQueryParameter] = []

    if county and county.strip() and county.strip().upper() != "ALL":
        c_val = f"%{county.strip().upper()}%"
        if table_name == "shelters":
            where_clauses.append("(UPPER(IFNULL(county_name, '')) LIKE @county OR UPPER(IFNULL(county_parish, '')) LIKE @county OR county_fips = @county_exact)")
        elif table_name == "vulnerability_tracts":
            where_clauses.append("(county_fips = @county_exact OR geo_id LIKE CONCAT(@county_exact, '%'))")
        elif table_name == "hazard_tracts":
            where_clauses.append("geo_id LIKE CONCAT(@county_exact, '%')")
        elif table_name == "power_dependent_counties":
            where_clauses.append("(UPPER(IFNULL(county, '')) LIKE @county OR fips_code = @county_exact)")
        elif table_name == "care_facilities":
            where_clauses.append("UPPER(IFNULL(citytown, '')) LIKE @county")
        params.append(bigquery.ScalarQueryParameter("county", "STRING", c_val))
        params.append(bigquery.ScalarQueryParameter("county_exact", "STRING", county.strip()))

    if search and search.strip():
        s_val = f"%{search.strip().upper()}%"
        if table_name == "shelters":
            where_clauses.append(
                "(UPPER(IFNULL(shelter_name, '')) LIKE @search OR UPPER(IFNULL(city, '')) LIKE @search OR UPPER(IFNULL(county_name, '')) LIKE @search OR UPPER(IFNULL(address_1, '')) LIKE @search)"
            )
        elif table_name in ("vulnerability_tracts", "hazard_tracts"):
            where_clauses.append("UPPER(CAST(geo_id AS STRING)) LIKE @search")
        elif table_name == "care_facilities":
            where_clauses.append(
                "(UPPER(IFNULL(provider_name, '')) LIKE @search OR UPPER(IFNULL(citytown, '')) LIKE @search OR UPPER(IFNULL(provider_address, '')) LIKE @search)"
            )
        elif table_name == "power_dependent_counties":
            where_clauses.append(
                "(UPPER(IFNULL(county, '')) LIKE @search OR UPPER(IFNULL(fips_code, '')) LIKE @search)"
            )
        params.append(bigquery.ScalarQueryParameter("search", "STRING", s_val))

    if quick_filter:
        if table_name == "shelters":
            if quick_filter == "ada_unrecorded":
                where_clauses.append("wheelchair_accessible IS NULL")
            elif quick_filter == "ada_yes":
                where_clauses.append("wheelchair_accessible IS TRUE")
            elif quick_filter == "ada_no":
                where_clauses.append("wheelchair_accessible IS FALSE")
            elif quick_filter == "medical":
                where_clauses.append("is_medical IS TRUE")
            elif quick_filter == "surge":
                where_clauses.append("in_surge_slosh_area IS TRUE")
        elif table_name == "vulnerability_tracts":
            if quick_filter == "high_no_vehicle":
                where_clauses.append("pct_no_vehicle >= 15.0")
            elif quick_filter == "high_disability":
                where_clauses.append("pct_disability >= 20.0")
        elif table_name == "power_dependent_counties":
            if quick_filter == "censored":
                where_clauses.append("power_dependent_is_censored IS TRUE")

    where_sql = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""

    count_sql = f"SELECT COUNT(*) AS total FROM {table_ref} {where_sql}"
    data_sql = f"SELECT * FROM {table_ref} {where_sql} LIMIT {int(limit)} OFFSET {int(offset)}"

    job_config = bigquery.QueryJobConfig(query_parameters=params)

    try:
        total_rows = list(client.query(count_sql, job_config=job_config).result())[0].total
        query_job = client.query(data_sql, job_config=job_config)
        result = query_job.result()
        schema_cols = [{"name": f.name, "type": f.field_type} for f in result.schema]
        rows = [
            {k: _sanitize_value(v) for k, v in dict(row.items()).items()}
            for row in result
        ]
        return {
            "connected": True,
            "table_name": table_name,
            "project": project,
            "dataset": dataset,
            "total_matching_rows": total_rows,
            "limit": limit,
            "offset": offset,
            "executed_sql": data_sql,
            "columns": schema_cols,
            "rows": rows,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc



_MAPS_LINE = re.compile(r"Google Maps\s*[—–-]+\s*\[([^\]]*)\]\((https?://[^)\s]+)\)")


def _extract_maps_sources_from_text(text: str, seen_uris: set, out: List[MapsGroundingChunk]) -> None:
    """The multi-agent coordinator passes sources up as 'Google Maps — [name](link)' lines."""
    for title, uri in _MAPS_LINE.findall(text or ""):
        if uri not in seen_uris:
            seen_uris.add(uri)
            out.append(MapsGroundingChunk(place_id=None, title=title or "Google Maps place", uri=uri))


def _extract_maps_sources_recursive(
    obj: Any, seen_uris: set, out: List[MapsGroundingChunk]
) -> None:
    """Recursively find google_maps_sources or maps grounding chunks in ADK event dicts."""
    if isinstance(obj, dict):
        if "google_maps_sources" in obj and isinstance(obj["google_maps_sources"], list):
            for src in obj["google_maps_sources"]:
                if isinstance(src, dict) and src.get("uri"):
                    uri = str(src["uri"])
                    if uri not in seen_uris:
                        seen_uris.add(uri)
                        out.append(
                            MapsGroundingChunk(
                                place_id=src.get("place_id") or src.get("placeId"),
                                title=src.get("title") or "Google Maps Place",
                                uri=uri,
                            )
                        )
        if "maps" in obj and isinstance(obj["maps"], dict):
            m = obj["maps"]
            uri = m.get("uri")
            if uri and uri not in seen_uris:
                seen_uris.add(uri)
                out.append(
                    MapsGroundingChunk(
                        place_id=m.get("placeId") or m.get("place_id"),
                        title=m.get("title") or "Google Maps Place",
                        uri=str(uri),
                    )
                )
        for v in obj.values():
            _extract_maps_sources_recursive(v, seen_uris, out)
    elif isinstance(obj, list):
        for item in obj:
            _extract_maps_sources_recursive(item, seen_uris, out)


_TOOL_SCHEMA_MAP: Dict[str, tuple[str, str]] = {
    "rank_priority_tracts": ("prioritization_agent", "RankPriorityTractsOutput"),
    "priority_weights": ("prioritization_agent", "PriorityWeightsOutput"),
    "equity_audit": ("prioritization_agent", "EquityAuditOutput"),
    "get_vulnerable_tracts": ("prioritization_agent", "RankPriorityTractsOutput"),
    "plan_evacuation_destinations": ("destination_agent", "PlanDestinationsOutput"),
    "reachability_rules": ("destination_agent", "ReachabilityRulesOutput"),
    "verify_shelters_live": ("verification_agent", "VerifySheltersLiveOutput"),
    "data_quality_report": ("verification_agent", "DataQualityReportOutput"),
    "record_shelter_assessment": ("verification_agent", "RecordShelterAssessmentOutput"),
    "county_gap_report": ("evac_readiness_coordinator", "CountyGapReportOutput"),
    "find_shelters": ("evac_readiness_coordinator", "FindSheltersOutput"),
    "analyze_shelter_readiness": ("evac_readiness_coordinator", "FindSheltersOutput"),
    "get_power_and_medical_gaps": ("evac_readiness_coordinator", "CountyGapReportOutput"),
    "generate_readiness_brief": ("evac_readiness_coordinator", "ReadinessBriefOutput"),
}

# In-memory decision ledger keyed by session_id -> action_id -> decision dict
_ACTION_DECISIONS: Dict[str, Dict[str, Dict[str, Any]]] = {}


def _extract_recommended_actions_recursive(
    obj: Any, actions_by_id: Dict[str, RecommendedAction]
) -> None:
    """Recursively find `recommended_actions` or `recommended_action` in ADK tool responses and stateDelta."""
    if isinstance(obj, dict):
        if "recommended_actions" in obj and isinstance(obj["recommended_actions"], list):
            for raw_act in obj["recommended_actions"]:
                if isinstance(raw_act, dict) and raw_act.get("action_id"):
                    try:
                        act = RecommendedAction(**raw_act)
                        actions_by_id[act.action_id] = act
                    except Exception:
                        pass
        if "recommended_action" in obj and isinstance(obj["recommended_action"], dict):
            raw_act = obj["recommended_action"]
            if raw_act.get("action_id"):
                try:
                    act = RecommendedAction(**raw_act)
                    actions_by_id[act.action_id] = act
                except Exception:
                    pass
        for v in obj.values():
            _extract_recommended_actions_recursive(v, actions_by_id)
    elif isinstance(obj, list):
        for item in obj:
            _extract_recommended_actions_recursive(item, actions_by_id)


def _extract_agent_outputs_recursive(
    obj: Any, outputs: List[AgentSchemaOutput], seen_keys: set
) -> None:
    """Extract structured tool outputs (`functionResponse`) and tag with specialist agent + schema name."""
    if isinstance(obj, dict):
        fn_resp = obj.get("functionResponse")
        if isinstance(fn_resp, dict):
            fn_name = str(fn_resp.get("name") or "")
            raw_data = fn_resp.get("response")
            if isinstance(raw_data, dict) and "result" in raw_data and isinstance(raw_data["result"], dict):
                raw_data = raw_data["result"]
            if fn_name in _TOOL_SCHEMA_MAP and isinstance(raw_data, dict):
                agent_name, schema_name = _TOOL_SCHEMA_MAP[fn_name]
                dedup_key = f"{fn_name}:{len(str(raw_data))}"
                if dedup_key not in seen_keys:
                    seen_keys.add(dedup_key)
                    outputs.append(
                        AgentSchemaOutput(
                            agent_name=agent_name,
                            tool_name=fn_name,
                            schema_name=schema_name,
                            data=raw_data,
                        )
                    )
        for v in obj.values():
            _extract_agent_outputs_recursive(v, outputs, seen_keys)
    elif isinstance(obj, list):
        for item in obj:
            _extract_agent_outputs_recursive(item, outputs, seen_keys)


def _synthesize_fallback_actions(
    county: str,
    tools_called: List[str],
    agent_outputs: List[AgentSchemaOutput],
    grounding_chunks: List[MapsGroundingChunk],
    actions_by_id: Dict[str, RecommendedAction],
) -> None:
    """Ensure every specialist agent turn has interactive RecommendedAction items (Approve/Reject/Select)
    even if a remote Cloud Run container or live tool returns raw tool dicts without `recommended_actions`."""
    if actions_by_id:
        return

    county_clean = (county or "Lee").strip()
    for out in agent_outputs:
        data = out.data or {}
        t_name = out.tool_name

        # Q1: Prioritization Agent (rank_priority_tracts / get_vulnerable_tracts)
        if t_name in ("rank_priority_tracts", "get_vulnerable_tracts"):
            tracts = data.get("tracts") or []
            for idx, tr in enumerate(tracts[:3]):
                gid = str(tr.get("geo_id") or f"tract_{idx+1}")
                hh_nv = int(tr.get("hh_no_vehicle") or tr.get("households_no_vehicle") or 0)
                pop = int(tr.get("total_pop") or 0)
                walk_n = int(tr.get("n_within_walk") or 0)
                near_mi = tr.get("nearest_shelter_miles") or tr.get("nearest_any_shelter_km")
                loc = LocationInfo(
                    lat=tr.get("lat"),
                    lon=tr.get("lon"),
                    label=f"Census Tract {gid}",
                    county=county_clean,
                    tract_geoid=gid,
                )
                act_id = f"q1_bus_pickup_{gid}"
                actions_by_id[act_id] = RecommendedAction(
                    action_id=act_id,
                    action_type=ActionType.ORGANIZE_BUS_PICKUP,
                    interaction_mode=InteractionMode.APPROVAL_REQUIRED,
                    severity=ActionSeverity.CRITICAL if idx == 0 else ActionSeverity.HIGH,
                    title=f"Stage transit pickup for Tract {gid} ({hh_nv:,} no-vehicle households)",
                    summary=f"Rank #{idx+1} priority tract in {county_clean} County with {hh_nv:,} vehicle-less households and {walk_n} walkable shelters <=1 mi.",
                    rationale="Households without personal vehicles beyond walking distance of a shelter require pre-staged municipal bus pickup points.",
                    source_agent="prioritization_agent",
                    source_tool=t_name,
                    location=loc,
                    affected_households=hh_nv,
                    affected_residents=pop,
                    attention_items=[
                        AttentionItem(label="No-Vehicle Households", value=f"{hh_nv:,} HH", badge="📊 ACS", is_warning=True),
                        AttentionItem(label="Nearest Shelter Distance", value=f"{near_mi} mi" if near_mi is not None else "Unknown", badge="🕰️ FEMA", is_warning=(walk_n == 0)),
                    ],
                    requires_approval=True,
                    approval=ApprovalDetails(
                        confirm_label="Approve Bus Staging",
                        reject_label="Defer",
                        proposed_change=f"Assign transit evacuation staging for Tract {gid} ({hh_nv:,} households)",
                        target_entity_type="tract",
                        target_entity_id=gid,
                        payload={"tract_geoid": gid, "hh_no_vehicle": hh_nv},
                        irreversible_or_high_impact=True,
                    ),
                )

        # Q2: Destination Agent (plan_evacuation_destinations)
        elif t_name == "plan_evacuation_destinations":
            plans = data.get("tract_plans") or []
            for p in plans[:3]:
                gid = str(p.get("tract_geoid") or "")
                cands = (p.get("walk_tier_shelters_1mi") or []) + (p.get("short_drive_shelters_5mi") or [])
                if not gid or not cands:
                    continue
                opts: List[ActionOption] = []
                for c_idx, c in enumerate(cands[:3]):
                    sid = int(c.get("shelter_id") or (c_idx + 1))
                    sname = str(c.get("shelter_name") or f"Shelter #{sid}")
                    cap = int(c.get("evacuation_capacity") or 0)
                    wc = str(c.get("wheelchair_accessible") or "UNRECORDED")
                    dist_mi = c.get("live_driving_distance_miles") or c.get("straight_line_miles")
                    dur_min = c.get("live_driving_duration_minutes")
                    opts.append(
                        ActionOption(
                            option_id=f"shelter_{sid}",
                            label=f"{sname} ({c.get('city') or county_clean})",
                            description=f"{dist_mi} mi" + (f" ({dur_min} min drive)" if dur_min else "") + f" · Cap {cap:,} · ADA: {wc}",
                            recommended=(c_idx == 0),
                            location=LocationInfo(
                                lat=c.get("latitude"),
                                lon=c.get("longitude"),
                                label=sname,
                                address=c.get("address"),
                                city=c.get("city"),
                                county=county_clean,
                                shelter_id=sid,
                            ),
                            metrics={"capacity": cap, "wheelchair": wc, "distance_miles": dist_mi},
                            warnings=(["Wheelchair access UNRECORDED"] if wc == "UNRECORDED" else []),
                        )
                    )
                act_id = f"q2_select_dest_{gid}"
                actions_by_id[act_id] = RecommendedAction(
                    action_id=act_id,
                    action_type=ActionType.SELECT_TRACT_DESTINATION,
                    interaction_mode=InteractionMode.SELECT_BETWEEN_OPTIONS,
                    severity=ActionSeverity.HIGH,
                    title=f"Select primary receiving shelter for Tract {gid}",
                    summary=f"Choose between {len(opts)} candidate shelters within reach of Tract {gid}.",
                    rationale="Assigning a primary receiving shelter balances evacuation capacity and ADA accessibility.",
                    source_agent="destination_agent",
                    source_tool=t_name,
                    location=LocationInfo(lat=p.get("tract_lat"), lon=p.get("tract_lon"), label=f"Tract {gid}", county=county_clean, tract_geoid=gid),
                    requires_selection=True,
                    requires_approval=True,
                    options=opts,
                    selected_option_id=opts[0].option_id,
                    approval=ApprovalDetails(
                        confirm_label="Approve Selected Destination",
                        reject_label="Reject Assignment",
                        proposed_change=f"Lock primary receiving shelter for Tract {gid}",
                        target_entity_type="tract",
                        target_entity_id=gid,
                    ),
                )

        # Q3: Verification Agent (verify_shelters_live / data_quality_report)
        elif t_name in ("verify_shelters_live", "data_quality_report"):
            findings = data.get("verified_shelters") or []
            for f in findings[:4]:
                sname = str(f.get("fema_shelter_name") or "Candidate Shelter")
                vstat = str(f.get("verified_status") or "OPEN")
                act_id = f"q3_verify_{re.sub(r'[^a-zA-Z0-9]+', '_', sname.lower())[:28]}"
                actions_by_id[act_id] = RecommendedAction(
                    action_id=act_id,
                    action_type=ActionType.DROP_CLOSED_SHELTER if vstat == "CLOSED" else ActionType.UPDATE_SHELTER_REGISTRY_NAME,
                    interaction_mode=InteractionMode.APPROVAL_REQUIRED,
                    severity=ActionSeverity.CRITICAL if vstat == "CLOSED" else ActionSeverity.MEDIUM,
                    title=f"Reconcile FEMA vs Google Maps record for {sname} ({vstat})",
                    summary=str(f.get("live_finding") or f"Google Maps verification status: {vstat}"),
                    rationale="FEMA's historical shelter table must be reconciled with live Google Maps place verification prior to storm season.",
                    source_agent="verification_agent",
                    source_tool=t_name,
                    location=LocationInfo(label=sname, address=f.get("address"), city=f.get("city"), county=county_clean),
                    attention_items=[
                        AttentionItem(
                            label="FEMA Wheelchair / Capacity",
                            value=f"ADA: {f.get('fema_wheelchair_accessible', 'UNRECORDED')} · Cap: {f.get('fema_evacuation_capacity', 0)}",
                            badge="🕰️ FEMA",
                            is_warning=f.get("fema_wheelchair_accessible") == "UNRECORDED",
                        ),
                        AttentionItem(
                            label="Live Google Maps Status",
                            value=vstat,
                            badge="🟢 Google Maps",
                            is_warning=(vstat != "OPEN"),
                            maps_title=f.get("maps_place_title"),
                            maps_uri=f.get("maps_place_uri"),
                        ),
                    ],
                    requires_approval=True,
                    approval=ApprovalDetails(
                        confirm_label="Approve Registry Update",
                        reject_label="Keep Existing Record",
                        proposed_change=f"Update status of {sname} to {vstat} in county operational plan",
                        target_entity_type="shelter",
                        target_entity_id=sname,
                    ),
                )

        # Coordinator: find_shelters / analyze_shelter_readiness / county_gap_report
        elif t_name in ("find_shelters", "analyze_shelter_readiness", "county_gap_report", "get_power_and_medical_gaps"):
            shelters = data.get("shelters") or data.get("candidate_shelters") or []
            if shelters:
                opts = []
                for s_idx, s in enumerate(shelters[:4]):
                    sid = s.get("shelter_id") or (s_idx + 1)
                    sname = str(s.get("shelter_name") or f"Shelter #{sid}")
                    wc = str(s.get("wheelchair_accessible") or s.get("wheelchair_status") or "UNRECORDED")
                    cap = int(s.get("evacuation_capacity") or 0)
                    opts.append(
                        ActionOption(
                            option_id=f"audit_shelter_{sid}",
                            label=f"{sname} ({s.get('city') or county_clean})",
                            description=f"Evac Cap: {cap:,} · Wheelchair: {wc} · Generator: {s.get('generator_onsite') or s.get('generator_status') or 'UNRECORDED'}",
                            recommended=(s_idx == 0),
                            location=LocationInfo(
                                lat=s.get("latitude"),
                                lon=s.get("longitude"),
                                label=sname,
                                address=s.get("address") or s.get("address_1"),
                                city=s.get("city"),
                                county=county_clean,
                                shelter_id=int(sid) if str(sid).isdigit() else None,
                            ),
                            metrics={"evacuation_capacity": cap, "wheelchair": wc},
                        )
                    )
                act_id = f"coord_shelter_select_{county_clean.lower()}"
                actions_by_id[act_id] = RecommendedAction(
                    action_id=act_id,
                    action_type=ActionType.AUDIT_UNASSESSED_NEARBY_SHELTERS,
                    interaction_mode=InteractionMode.SELECT_BETWEEN_OPTIONS,
                    severity=ActionSeverity.HIGH,
                    title=f"Select priority shelter in {county_clean} County for operator accessibility & generator audit",
                    summary=f"{len(shelters)} candidate shelters returned; select which facility to prioritize for pre-season verification.",
                    rationale="Closing UNRECORDED wheelchair and generator fields on high-capacity shelters expands verified accessible capacity.",
                    source_agent="evac_readiness_coordinator",
                    source_tool=t_name,
                    location=opts[0].location,
                    requires_selection=True,
                    requires_approval=True,
                    options=opts,
                    selected_option_id=opts[0].option_id,
                    approval=ApprovalDetails(
                        confirm_label="Approve Shelter Audit Assignment",
                        reject_label="Defer Audit",
                        proposed_change=f"Dispatch operator accessibility & generator check in {county_clean} County",
                        target_entity_type="shelter",
                        target_entity_id=opts[0].option_id,
                    ),
                )


@app.post("/api/chat/action-decision", response_model=ActionDecisionResponse)
async def record_action_decision(req: ActionDecisionRequest) -> ActionDecisionResponse:
    """Record an emergency manager's Approve, Reject, or Select-Between-Options decision from the Chat Widget."""
    session_id = req.session_id or "default-session"
    now_iso = dt.datetime.now(dt.timezone.utc).isoformat()
    sess_bucket = _ACTION_DECISIONS.setdefault(session_id, {})

    action_title = (req.action or {}).get("title") or req.action_id
    proposed_change = ((req.action or {}).get("approval") or {}).get("proposed_change") or action_title

    if req.decision == "APPROVED":
        opt_suffix = f" with option '{req.selected_option_label or req.selected_option_id}'" if req.selected_option_id else ""
        applied_summary = f"Approved: {proposed_change}{opt_suffix}."
        follow_up = (
            f"I have APPROVED action `{req.action_id}` ({action_title}){opt_suffix} for {req.county or 'Lee'} County."
            + (f" Note: {req.note}." if req.note else "")
            + " Please update the readiness plan and advise the next step."
        )
    elif req.decision == "REJECTED":
        applied_summary = f"Rejected / Deferred: {action_title}."
        follow_up = (
            f"I have REJECTED / DEFERRED action `{req.action_id}` ({action_title}) for {req.county or 'Lee'} County."
            + (f" Reason: {req.note}." if req.note else "")
            + " Please suggest an alternative mitigation or next priority."
        )
    else:
        opt_label = req.selected_option_label or req.selected_option_id or "selected option"
        applied_summary = f"Selected option '{opt_label}' for {action_title}."
        follow_up = (
            f"For action `{req.action_id}` ({action_title}) in {req.county or 'Lee'} County, "
            f"I selected option `{opt_label}`."
            + (f" Note: {req.note}." if req.note else "")
            + " Please proceed with this selected option."
        )

    record = {
        "action_id": req.action_id,
        "decision": req.decision,
        "selected_option_id": req.selected_option_id,
        "selected_option_label": req.selected_option_label,
        "decided_at": now_iso,
        "note": req.note,
        "county": req.county or "Lee",
        "applied_summary": applied_summary,
        "follow_up_prompt": follow_up,
    }
    sess_bucket[req.action_id] = record

    return ActionDecisionResponse(
        status="recorded",
        action_id=req.action_id,
        decision=req.decision,
        selected_option_id=req.selected_option_id,
        selected_option_label=req.selected_option_label,
        decided_at=now_iso,
        note=req.note,
        applied_summary=applied_summary,
        follow_up_prompt=follow_up,
    )


@app.get("/api/chat/action-decisions")
async def list_action_decisions(session_id: str = Query("default-session")) -> Dict[str, Any]:
    """Return all recorded action decisions for a chat session."""
    return {
        "session_id": session_id,
        "decisions": _ACTION_DECISIONS.get(session_id, {}),
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat_endpoint(req: ChatRequest) -> ChatResponse:
    """Forward chat turns to the deployed Cloud Run ADK service (`evac_agent`) and extract tools + Maps sources."""
    user_id = "emergency-manager"
    session_id = req.session_id or "default-session"
    t0 = time.time()

    tools_called: List[str] = []
    texts: List[str] = []
    grounding_chunks: List[MapsGroundingChunk] = []
    seen_uris: set = set()
    actions_by_id: Dict[str, RecommendedAction] = {}
    agent_outputs: List[AgentSchemaOutput] = []
    seen_output_keys: set = set()

    try:
        async with httpx.AsyncClient(timeout=600.0) as client:
            # Ensure session exists on Cloud Run ADK server (ignore 400/409 if already created)
            sess_url = f"{DEPLOYED_AGENT_URL}/apps/{DEPLOYED_AGENT_APP}/users/{user_id}/sessions/{session_id}"
            await client.post(sess_url, json={})

            run_resp = await client.post(
                f"{DEPLOYED_AGENT_URL}/run",
                json={
                    "appName": DEPLOYED_AGENT_APP,
                    "userId": user_id,
                    "sessionId": session_id,
                    "newMessage": {
                        "role": "user",
                        "parts": [{"text": req.message}],
                    },
                },
            )
            if run_resp.status_code != 200:
                raise HTTPException(
                    status_code=run_resp.status_code,
                    detail=f"Cloud Run ADK error ({run_resp.status_code}): {run_resp.text[:400]}",
                )

            events = run_resp.json()
            for ev in events:
                content = ev.get("content") or {}
                for part in content.get("parts") or []:
                    if "functionCall" in part and part["functionCall"]:
                        fn_name = part["functionCall"].get("name")
                        if fn_name and fn_name not in tools_called:
                            tools_called.append(fn_name)
                    elif part.get("text") and not part.get("thought"):
                        texts.append(part["text"])

                _extract_maps_sources_recursive(ev, seen_uris, grounding_chunks)
                _extract_recommended_actions_recursive(ev, actions_by_id)
                _extract_agent_outputs_recursive(ev, agent_outputs, seen_output_keys)

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    elapsed = round(time.time() - t0, 1)
    reply_text = texts[-1].strip() if texts else "No response generated."
    _extract_maps_sources_from_text(reply_text, seen_uris, grounding_chunks)
    _synthesize_fallback_actions(
        req.county or "Lee", tools_called, agent_outputs, grounding_chunks, actions_by_id
    )

    return ChatResponse(
        reply=reply_text,
        county=req.county or "Lee",
        state=req.state or "FL",
        tools_called=tools_called,
        elapsed_seconds=elapsed,
        agent_url=DEPLOYED_AGENT_URL,
        grounding_chunks=grounding_chunks,
        recommended_actions=list(actions_by_id.values()),
        agent_outputs=agent_outputs,
    )


# ---------------------------------------------------------------------------------------------
# Story endpoints for the main page: the same Python tools the agent uses, called directly, so the
# page loads in seconds and its numbers match what the assistant says.
# ---------------------------------------------------------------------------------------------
# Import the agent's tools once at startup. Importing them lazily inside handlers raced when the page
# fired several requests at once on a fresh instance (KeyError: 'evac_agent').
try:
    import evac_agent as _evac_pkg  # noqa: F401, E402
except Exception:
    import sys as _sys  # noqa: E402
    import types as _types  # noqa: E402

    _evac_pkg = _types.ModuleType("evac_agent")
    _evac_pkg.__path__ = [str(_AGENT_DIR / "evac_agent")]
    _sys.modules["evac_agent"] = _evac_pkg

from evac_agent import data as _evac_data  # noqa: E402
from evac_agent import destination as _evac_destination  # noqa: E402
from evac_agent import prioritize as _evac_prioritize  # noqa: E402
from evac_agent import quality as _evac_quality  # noqa: E402
from evac_agent import verify as _evac_verify  # noqa: E402


class _PageContext:
    """Stand-in for ADK's ToolContext: default weights and reachability rules."""

    def __init__(self) -> None:
        self.state: Dict[str, Any] = {}


@app.get("/api/story/priorities")
def story_priorities(county: str = "Lee", top_n: int = 6) -> Dict[str, Any]:
    return _evac_prioritize.rank_priority_tracts(_PageContext(), county, top_n)


@app.get("/api/story/destinations")
def story_destinations(geo_id: str, live: bool = True) -> Dict[str, Any]:
    if not geo_id.isdigit():
        raise HTTPException(status_code=400, detail="geo_id must be a census tract id")
    return _evac_destination.plan_destinations(_PageContext(), [geo_id], check_drive_times=live)


@app.get("/api/story/quality")
def story_quality(county: str = "Lee") -> Dict[str, Any]:
    return _evac_quality.data_quality_report(county)


@app.get("/api/story/gaps")
def story_gaps(county: str = "Lee") -> Dict[str, Any]:
    return _evac_data.county_gap_report(county)


class _VerifyRequest(BaseModel):
    shelter_ids: List[int]


@app.post("/api/story/verify")
def story_verify(req: _VerifyRequest) -> Dict[str, Any]:
    # Results are shown on screen only: Google Maps content may not be stored (only place_id is kept,
    # which verify_shelters_live does).
    return _evac_verify.verify_shelters_live(req.shelter_ids[:8])


def _sse(payload: Dict[str, Any]) -> str:
    return f"data: {json.dumps(payload)}\n\n"


@app.post("/api/chat/stream")
async def chat_stream_endpoint(req: ChatRequest):
    """Same as /api/chat, but streams progress so the UI can show what the agent is doing:
    {"type":"step","tool":...} when a specialist/tool starts, {"type":"step_done",...} when it returns,
    then {"type":"final", ...ChatResponse fields}."""
    user_id = "emergency-manager"
    session_id = req.session_id or "default-session"

    async def events():
        t0 = time.time()
        tools_called: List[str] = []
        texts: List[str] = []
        grounding_chunks: List[MapsGroundingChunk] = []
        seen_uris: set = set()
        actions_by_id: Dict[str, RecommendedAction] = {}
        agent_outputs: List[AgentSchemaOutput] = []
        seen_output_keys: set = set()
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(600.0)) as client:
                await client.post(
                    f"{DEPLOYED_AGENT_URL}/apps/{DEPLOYED_AGENT_APP}/users/{user_id}/sessions/{session_id}", json={})
                body = {"appName": DEPLOYED_AGENT_APP, "userId": user_id, "sessionId": session_id,
                        "newMessage": {"role": "user", "parts": [{"text": req.message}]}}
                async with client.stream("POST", f"{DEPLOYED_AGENT_URL}/run_sse", json=body) as resp:
                    if resp.status_code != 200:
                        detail = (await resp.aread()).decode(errors="replace")[:300]
                        yield _sse({"type": "error", "message": f"Agent error ({resp.status_code}): {detail}"})
                        return
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        try:
                            ev = json.loads(line[5:].strip())
                        except json.JSONDecodeError:
                            continue
                        for part in (ev.get("content") or {}).get("parts") or []:
                            if part.get("functionCall"):
                                name = part["functionCall"].get("name")
                                if name and name not in tools_called:
                                    tools_called.append(name)
                                yield _sse({"type": "step", "tool": name})
                            elif part.get("functionResponse"):
                                yield _sse({"type": "step_done", "tool": part["functionResponse"].get("name")})
                            elif part.get("text") and not part.get("thought") and not ev.get("partial"):
                                texts.append(part["text"])
                        _extract_maps_sources_recursive(ev, seen_uris, grounding_chunks)
                        _extract_recommended_actions_recursive(ev, actions_by_id)
                        _extract_agent_outputs_recursive(ev, agent_outputs, seen_output_keys)
            reply_text = texts[-1].strip() if texts else "I couldn't produce an answer that time. Please try again."
            _extract_maps_sources_from_text(reply_text, seen_uris, grounding_chunks)
            _synthesize_fallback_actions(
                req.county or "Lee", tools_called, agent_outputs, grounding_chunks, actions_by_id
            )
            yield _sse({
                "type": "final",
                "reply": reply_text,
                "tools_called": tools_called,
                "elapsed_seconds": round(time.time() - t0, 1),
                "grounding_chunks": [c.model_dump() for c in grounding_chunks],
                "recommended_actions": [a.model_dump() for a in actions_by_id.values()],
                "agent_outputs": [o.model_dump() for o in agent_outputs],
            })
        except Exception as exc:  # surface any failure to the UI instead of hanging
            yield _sse({"type": "error", "message": str(exc)[:300]})

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


_LIVE_TOOL_DECLARATIONS = [
    types.FunctionDeclaration(
        name="get_vulnerable_tracts",
        description=(
            "Rank census tracts in a county by self-evacuation vulnerability (no-vehicle households, "
            "65+, disability, mobility, mobile homes) and straight-line distance to nearest shelters."
        ),
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "county_name_or_fips": types.Schema(
                    type="STRING",
                    description="County name (e.g. 'Lee', 'Miami-Dade', 'Pinellas') or 5-digit county FIPS.",
                ),
                "max_reachable_km": types.Schema(
                    type="NUMBER",
                    description="Distance threshold in km (default 10.0).",
                ),
                "limit": types.Schema(
                    type="INTEGER",
                    description="Max number of priority tracts to return (default 10).",
                ),
            },
            required=["county_name_or_fips"],
        ),
    ),
    types.FunctionDeclaration(
        name="analyze_shelter_readiness",
        description=(
            "Analyze shelter capacity, wheelchair accessibility (Recorded YES vs Recorded NO vs UNRECORDED), "
            "generator status, and storm surge risk in a county."
        ),
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "county_name_or_fips": types.Schema(
                    type="STRING",
                    description="County name (e.g. 'Lee', 'Miami-Dade', 'Pinellas') or 5-digit county FIPS.",
                ),
                "limit": types.Schema(
                    type="INTEGER",
                    description="Max candidate shelters to return (default 15).",
                ),
            },
            required=["county_name_or_fips"],
        ),
    ),
    types.FunctionDeclaration(
        name="get_power_and_medical_gaps",
        description=(
            "Retrieve county-level electricity-dependent Medicare beneficiaries (HHS emPOWER), "
            "nursing homes (CMS care_facilities), and medical shelters."
        ),
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "county_name_or_fips": types.Schema(
                    type="STRING",
                    description="County name (e.g. 'Lee', 'Miami-Dade', 'Pinellas') or 5-digit county FIPS.",
                ),
                "limit": types.Schema(
                    type="INTEGER",
                    description="Max nursing home care facilities to return (default 10).",
                ),
            },
            required=["county_name_or_fips"],
        ),
    ),
    types.FunctionDeclaration(
        name="ask_evacuation_specialist",
        description=(
            "Run a deep multi-agent evacuation query or live Google Maps shelter verification and drive-time "
            "routing check for a specific question."
        ),
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "question": types.Schema(
                    type="STRING",
                    description="The specific evacuation, routing, equity audit, or live Google Maps shelter verification question.",
                ),
                "county": types.Schema(
                    type="STRING",
                    description="County name (e.g. 'Lee').",
                ),
            },
            required=["question"],
        ),
    ),
]


async def _execute_live_tool(
    name: str,
    args: Dict[str, Any],
    default_county: str,
    session_id: str,
    websocket: WebSocket,
    turn_tools: List[str],
    turn_grounding: List[MapsGroundingChunk],
    seen_uris: set,
    turn_actions: Dict[str, RecommendedAction],
    turn_outputs: List[AgentSchemaOutput],
) -> Dict[str, Any]:
    """Execute a tool requested during a Gemini Live voice session and stream step progress to the UI."""
    county_arg = str(args.get("county_name_or_fips") or args.get("county") or default_county or "Lee")
    step_name = name
    if name == "get_vulnerable_tracts":
        step_name = "prioritization_agent"
    elif name == "analyze_shelter_readiness":
        step_name = "find_shelters"
    elif name == "get_power_and_medical_gaps":
        step_name = "county_gap_report"
    elif name == "ask_evacuation_specialist":
        step_name = "verification_agent"

    if step_name not in turn_tools:
        turn_tools.append(step_name)
    await websocket.send_json({"type": "step", "tool": step_name})

    try:
        if name == "get_vulnerable_tracts":
            res = await asyncio.to_thread(
                get_vulnerable_tracts,
                county_name_or_fips=county_arg,
                max_reachable_km=float(args.get("max_reachable_km", 10.0)),
                limit=int(args.get("limit", 10)),
            )
            if isinstance(res, dict) and res.get("status") == "success":
                out = AgentSchemaOutput(
                    agent_name="prioritization_agent",
                    tool_name="get_vulnerable_tracts",
                    schema_name="RankPriorityTractsOutput",
                    data=res,
                )
                turn_outputs.append(out)
                _synthesize_fallback_actions(county_arg, turn_tools, [out], turn_grounding, turn_actions)
        elif name == "analyze_shelter_readiness":
            res = await asyncio.to_thread(
                analyze_shelter_readiness,
                county_name_or_fips=county_arg,
                limit=int(args.get("limit", 15)),
            )
            if isinstance(res, dict) and res.get("status") == "success":
                out = AgentSchemaOutput(
                    agent_name="evac_readiness_coordinator",
                    tool_name="analyze_shelter_readiness",
                    schema_name="FindSheltersOutput",
                    data=res,
                )
                turn_outputs.append(out)
                _synthesize_fallback_actions(county_arg, turn_tools, [out], turn_grounding, turn_actions)
        elif name == "get_power_and_medical_gaps":
            res = await asyncio.to_thread(
                get_power_and_medical_gaps,
                county_name_or_fips=county_arg,
                limit=int(args.get("limit", 10)),
            )
            if isinstance(res, dict) and res.get("status") == "success":
                out = AgentSchemaOutput(
                    agent_name="evac_readiness_coordinator",
                    tool_name="get_power_and_medical_gaps",
                    schema_name="CountyGapReportOutput",
                    data=res,
                )
                turn_outputs.append(out)
                _synthesize_fallback_actions(county_arg, turn_tools, [out], turn_grounding, turn_actions)
        elif name == "ask_evacuation_specialist":
            question = str(args.get("question") or f"Check evacuation readiness for {county_arg} County")
            chat_res = await chat_endpoint(
                ChatRequest(
                    message=question,
                    county=county_arg,
                    state="FL",
                    session_id=session_id,
                )
            )
            for t in chat_res.tools_called:
                if t not in turn_tools:
                    turn_tools.append(t)
            for g in chat_res.grounding_chunks:
                if g.uri not in seen_uris:
                    seen_uris.add(g.uri)
                    turn_grounding.append(g)
            for act in chat_res.recommended_actions:
                turn_actions[act.action_id] = act
            for out in chat_res.agent_outputs:
                turn_outputs.append(out)
            res = {
                "status": "success",
                "specialist_report": chat_res.reply,
                "tools_called": chat_res.tools_called,
                "google_maps_sources": [g.model_dump() for g in chat_res.grounding_chunks],
            }
        else:
            res = {"status": "error", "error": f"Unknown tool: {name}"}
    except Exception as exc:
        res = {"status": "error", "error": str(exc)[:300]}
    finally:
        await websocket.send_json({"type": "step_done", "tool": step_name})

    return res


@app.websocket("/api/live")
async def gemini_live_websocket(
    websocket: WebSocket,
    county: str = Query("Lee"),
    state: str = Query("FL"),
    session_id: str = Query("live-session"),
):
    """Bidirectional Gemini Live API voice talk endpoint (16kHz PCM in, 24kHz PCM + transcripts + tools out)."""
    await websocket.accept()

    project = os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("BQ_PROJECT") or ""
    live_location = os.environ.get("GEMINI_LIVE_LOCATION", "us-central1")
    candidate_models = [
        os.environ.get("GEMINI_LIVE_MODEL", "gemini-2.0-flash-live-preview-04-09"),
        "gemini-live-2.5-flash-preview-native-audio",
        "gemini-2.0-flash-exp",
    ]
    voice_name = os.environ.get("GEMINI_LIVE_VOICE", "Aoede")

    live_instruction = (
        f"{SYSTEM_INSTRUCTION}\n\n"
        f"### VOICE CONVERSATION MODE\n"
        f"- You are speaking live with the County Emergency Manager for **{county} County, {state}**.\n"
        f"- Keep your spoken responses clear, natural, and concise (2 to 4 short paragraphs or key bullet points) "
        f"while citing exact tract numbers, shelter names, and counts from your tools.\n"
        f"- Always use `get_vulnerable_tracts`, `analyze_shelter_readiness`, `get_power_and_medical_gaps`, or "
        f"`ask_evacuation_specialist` to ground your answers in real federal records and live Google Maps checks.\n"
    )

    live_config = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice_name)
            )
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        system_instruction=types.Content(parts=[types.Part.from_text(text=live_instruction)]),
        tools=[types.Tool(function_declarations=_LIVE_TOOL_DECLARATIONS)],
    )

    try:
        genai_client = genai.Client(
            vertexai=True,
            project=project if project and project != "your-gcp-project-id" else None,
            location=live_location,
        )
    except Exception as exc:
        await websocket.send_json(
            {"type": "error", "message": f"Failed to initialize Gemini Live client: {exc}"}
        )
        await websocket.close()
        return

    # Try connecting with candidate live models
    live_ctx = None
    connected_model = None
    last_err: Optional[Exception] = None
    for model_id in dict.fromkeys(candidate_models):
        try:
            ctx = genai_client.aio.live.connect(model=model_id, config=live_config)
            live_session = await ctx.__aenter__()
            live_ctx = ctx
            connected_model = model_id
            break
        except Exception as exc:
            last_err = exc
            continue

    if live_ctx is None or connected_model is None:
        await websocket.send_json(
            {
                "type": "error",
                "message": f"Gemini Live session unavailable ({last_err}). Falling back to browser voice bridge.",
            }
        )
        await websocket.close()
        return

    await websocket.send_json(
        {
            "type": "ready",
            "model": connected_model,
            "county": county,
            "state": state,
        }
    )

    turn_tools: List[str] = []
    turn_grounding: List[MapsGroundingChunk] = []
    seen_uris: set = set()
    turn_actions: Dict[str, RecommendedAction] = {}
    turn_outputs: List[AgentSchemaOutput] = []
    turn_started_at: Optional[float] = None

    async def receive_from_client():
        nonlocal turn_started_at
        try:
            while True:
                raw_msg = await websocket.receive_text()
                try:
                    msg = json.loads(raw_msg)
                except json.JSONDecodeError:
                    continue

                msg_type = msg.get("type")
                if msg_type == "audio":
                    b64_data = msg.get("data")
                    if b64_data:
                        pcm_bytes = base64.b64decode(b64_data)
                        await live_session.send(
                            input=types.LiveClientRealtimeInput(
                                media_chunks=[
                                    types.Blob(data=pcm_bytes, mime_type="audio/pcm;rate=16000")
                                ]
                            )
                        )
                elif msg_type == "text":
                    text_val = (msg.get("text") or "").strip()
                    if text_val:
                        turn_started_at = time.time()
                        await live_session.send(input=text_val, end_of_turn=True)
                elif msg_type == "end_audio":
                    turn_started_at = time.time()
        except WebSocketDisconnect:
            pass
        except Exception:
            pass

    async def receive_from_gemini():
        nonlocal turn_tools, turn_grounding, seen_uris, turn_actions, turn_outputs, turn_started_at
        try:
            while True:
                async for response in live_session.receive():
                    sc = getattr(response, "server_content", None)
                    if sc is not None:
                        if getattr(sc, "interrupted", False):
                            await websocket.send_json({"type": "interrupted"})

                        in_tr = getattr(sc, "input_transcription", None)
                        if in_tr and getattr(in_tr, "text", None):
                            if turn_started_at is None:
                                turn_started_at = time.time()
                            await websocket.send_json(
                                {
                                    "type": "input_transcript",
                                    "text": in_tr.text,
                                    "finished": bool(getattr(in_tr, "finished", False)),
                                }
                            )

                        out_tr = getattr(sc, "output_transcription", None)
                        if out_tr and getattr(out_tr, "text", None):
                            await websocket.send_json(
                                {
                                    "type": "output_transcript",
                                    "text": out_tr.text,
                                    "finished": bool(getattr(out_tr, "finished", False)),
                                }
                            )

                        model_turn = getattr(sc, "model_turn", None)
                        if model_turn and getattr(model_turn, "parts", None):
                            for part in model_turn.parts:
                                inline_data = getattr(part, "inline_data", None)
                                if inline_data and getattr(inline_data, "data", None):
                                    b64_audio = base64.b64encode(inline_data.data).decode("ascii")
                                    await websocket.send_json(
                                        {
                                            "type": "audio",
                                            "data": b64_audio,
                                            "mime_type": getattr(inline_data, "mime_type", None)
                                            or "audio/pcm;rate=24000",
                                        }
                                    )
                                part_text = getattr(part, "text", None)
                                if part_text and not getattr(part, "thought", False):
                                    await websocket.send_json(
                                        {
                                            "type": "output_transcript",
                                            "text": part_text,
                                            "finished": False,
                                        }
                                    )

                        if getattr(sc, "turn_complete", False):
                            elapsed = (
                                round(time.time() - turn_started_at, 1)
                                if turn_started_at
                                else None
                            )
                            await websocket.send_json(
                                {
                                    "type": "turn_complete",
                                    "tools_called": list(turn_tools),
                                    "elapsed_seconds": elapsed,
                                    "grounding_chunks": [c.model_dump() for c in turn_grounding],
                                    "recommended_actions": [a.model_dump() for a in turn_actions.values()],
                                    "agent_outputs": [o.model_dump() for o in turn_outputs],
                                }
                            )
                            turn_tools = []
                            turn_grounding = []
                            seen_uris = set()
                            turn_actions = {}
                            turn_outputs = []
                            turn_started_at = None

                    tool_call = getattr(response, "tool_call", None)
                    if tool_call and getattr(tool_call, "function_calls", None):
                        if turn_started_at is None:
                            turn_started_at = time.time()
                        fn_responses: List[types.FunctionResponse] = []
                        for fc in tool_call.function_calls:
                            fn_name = getattr(fc, "name", "") or ""
                            fn_args = dict(getattr(fc, "args", {}) or {})
                            res_dict = await _execute_live_tool(
                                name=fn_name,
                                args=fn_args,
                                default_county=county,
                                session_id=session_id,
                                websocket=websocket,
                                turn_tools=turn_tools,
                                turn_grounding=turn_grounding,
                                seen_uris=seen_uris,
                                turn_actions=turn_actions,
                                turn_outputs=turn_outputs,
                            )
                            fn_responses.append(
                                types.FunctionResponse(
                                    id=getattr(fc, "id", None),
                                    name=fn_name,
                                    response=res_dict,
                                )
                            )
                        if fn_responses:
                            await live_session.send(
                                input=types.LiveClientToolResponse(
                                    function_responses=fn_responses
                                )
                            )
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            try:
                await websocket.send_json({"type": "error", "message": str(exc)[:250]})
            except Exception:
                pass

    client_task = asyncio.create_task(receive_from_client())
    gemini_task = asyncio.create_task(receive_from_gemini())
    try:
        await asyncio.wait(
            [client_task, gemini_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
    finally:
        client_task.cancel()
        gemini_task.cancel()
        try:
            await live_ctx.__aexit__(None, None, None)
        except Exception:
            pass


def _flag_label(val: Any) -> str:
    if val is True:
        return "YES"
    if val is False:
        return "NO"
    return "UNRECORDED"


@app.get("/api/area/map-points")
def get_county_map_points(
    county: str = Query("Lee", description="County name, e.g. Lee, Miami-Dade, Pinellas"),
) -> Dict[str, Any]:
    """Return shelters and priority vulnerable census tracts for a county to plot on the interactive map."""
    try:
        client, project, dataset = _get_bq_client()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    shelters_sql = f"""
    SELECT
      CAST(shelter_id AS STRING) AS shelter_id,
      shelter_name,
      address_1,
      city,
      zip,
      COALESCE(county_name, county_parish) AS county_name,
      county_fips,
      latitude,
      longitude,
      evacuation_capacity,
      post_impact_capacity,
      wheelchair_accessible,
      generator_onsite,
      self_sufficient_electricity,
      in_surge_slosh_area,
      in_100_yr_floodplain,
      pet_accommodations_code,
      is_medical,
      usage
    FROM `{project}.{dataset}.shelters`
    WHERE latitude IS NOT NULL
      AND longitude IS NOT NULL
      AND (
        LOWER(COALESCE(county_name, '')) LIKE LOWER(@county_pat)
        OR LOWER(COALESCE(county_parish, '')) LIKE LOWER(@county_pat)
      )
    LIMIT 150
    """

    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("county_pat", "STRING", f"%{county.strip()}%")
        ]
    )

    shelters_rows = [dict(r.items()) for r in client.query(shelters_sql, job_config=job_config).result()]
    county_fips = next((r.get("county_fips") for r in shelters_rows if r.get("county_fips")), None)

    shelters_out = [
        {
            "shelter_id": r["shelter_id"],
            "shelter_name": r["shelter_name"],
            "address_1": r.get("address_1"),
            "city": r.get("city"),
            "zip": str(r.get("zip") or "").strip(),
            "county_name": r.get("county_name"),
            "latitude": _sanitize_value(r["latitude"]),
            "longitude": _sanitize_value(r["longitude"]),
            "evacuation_capacity": _sanitize_value(r.get("evacuation_capacity")),
            "post_impact_capacity": _sanitize_value(r.get("post_impact_capacity")),
            "wheelchair_status": _flag_label(r.get("wheelchair_accessible")),
            "generator_status": _flag_label(r.get("generator_onsite")),
            "self_sufficient_status": _flag_label(r.get("self_sufficient_electricity")),
            "surge_status": _flag_label(r.get("in_surge_slosh_area")),
            "floodplain_status": _flag_label(r.get("in_100_yr_floodplain")),
            "medical_status": _flag_label(r.get("is_medical")),
            "pets": str(r.get("pet_accommodations_code") or "").strip() or "UNRECORDED",
            "in_surge_slosh_area": r.get("in_surge_slosh_area"),
            "is_medical": bool(r.get("is_medical")),
            "usage": r.get("usage") or "EVAC",
        }
        for r in shelters_rows
    ]

    tracts_out: List[Dict[str, Any]] = []
    if county_fips:
        tracts_sql = f"""
        SELECT
          v.geo_id,
          v.county_fips,
          v.lat,
          v.lon,
          v.total_pop,
          v.households_no_vehicle,
          v.pct_no_vehicle,
          v.pop_65_plus,
          v.pct_age_65_plus,
          v.pct_disability,
          v.pct_mobility,
          v.mobile_homes,
          h.CFLD_EXPP,
          h.HRCN_EALT
        FROM `{project}.{dataset}.vulnerability_tracts` v
        LEFT JOIN `{project}.{dataset}.hazard_tracts` h
          ON v.geo_id = h.geo_id
        WHERE v.county_fips = @county_fips
          AND v.lat IS NOT NULL
          AND v.lon IS NOT NULL
        ORDER BY COALESCE(v.households_no_vehicle, 0) DESC
        LIMIT 60
        """
        t_cfg = bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("county_fips", "STRING", str(county_fips))]
        )
        for tr in client.query(tracts_sql, job_config=t_cfg).result():
            d = {k: _sanitize_value(v) for k, v in dict(tr.items()).items()}
            tracts_out.append(d)

    return {
        "county": county,
        "county_fips": county_fips,
        "shelters": shelters_out,
        "tracts": tracts_out,
    }


@app.get("/api/area/inspect")
def inspect_clicked_area(
    lat: float = Query(..., description="Clicked latitude"),
    lng: float = Query(..., description="Clicked longitude"),
    radius_km: float = Query(15.0, ge=1.0, le=80.0, description="Search radius in km"),
    include_maps: bool = Query(True, description="Whether to run live Vertex AI Google Maps Grounding"),
) -> Dict[str, Any]:
    """
    Fetch comprehensive details for a clicked (lat, lng) coordinate using:
    1. BigQuery Spatial Queries (`ST_DISTANCE` / `ST_DWITHIN`) across all 5 tables.
    2. Vertex AI Grounding with Google Maps (Places + Routing) for live area & shelter verification.
    """
    t0 = time.time()
    try:
        client, project, dataset = _get_bq_client()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    params = [
        bigquery.ScalarQueryParameter("lat", "FLOAT64", lat),
        bigquery.ScalarQueryParameter("lng", "FLOAT64", lng),
        bigquery.ScalarQueryParameter("radius_m", "FLOAT64", radius_km * 1000.0),
    ]
    job_config = bigquery.QueryJobConfig(query_parameters=params)

    # 1. Nearest Census Tract (Vulnerability + Hazard)
    tract_sql = f"""
    SELECT
      v.geo_id,
      v.county_fips,
      v.lat,
      v.lon,
      ROUND(ST_DISTANCE(ST_GEOGPOINT(v.lon, v.lat), ST_GEOGPOINT(@lng, @lat)) / 1000.0, 2) AS distance_km,
      v.total_pop,
      v.households,
      v.households_no_vehicle,
      ROUND(v.pct_no_vehicle, 1) AS pct_no_vehicle,
      v.pop_65_plus,
      ROUND(v.pct_age_65_plus, 1) AS pct_age_65_plus,
      ROUND(v.pct_disability, 1) AS pct_disability,
      ROUND(v.pct_mobility, 1) AS pct_mobility,
      v.mobile_homes,
      ROUND(v.pct_mobile_homes, 1) AS pct_mobile_homes,
      ROUND(v.pct_limited_english, 1) AS pct_limited_english,
      ROUND(v.pct_no_internet, 1) AS pct_no_internet,
      ROUND(h.HRCN_AFREQ, 2) AS hrcn_afreq,
      ROUND(h.HRCN_EXPP, 0) AS hrcn_expp,
      ROUND(h.HRCN_EALT, 0) AS hrcn_ealt,
      ROUND(h.CFLD_AFREQ, 2) AS cfld_afreq,
      ROUND(h.CFLD_EXPP, 0) AS cfld_expp,
      ROUND(h.CFLD_EALT, 0) AS cfld_ealt
    FROM `{project}.{dataset}.vulnerability_tracts` v
    LEFT JOIN `{project}.{dataset}.hazard_tracts` h
      ON v.geo_id = h.geo_id
    WHERE v.lat IS NOT NULL AND v.lon IS NOT NULL
    ORDER BY ST_DISTANCE(ST_GEOGPOINT(v.lon, v.lat), ST_GEOGPOINT(@lng, @lat)) ASC
    LIMIT 1
    """
    tract_rows = list(client.query(tract_sql, job_config=job_config).result())
    nearest_tract = (
        {k: _sanitize_value(v) for k, v in dict(tract_rows[0].items()).items()}
        if tract_rows
        else None
    )

    # 2. County Power-Dependent DME (HHS emPOWER)
    county_power = None
    if nearest_tract and nearest_tract.get("county_fips"):
        empower_sql = f"""
        SELECT
          COALESCE(name, county, namelsad) AS county_name,
          fips_code_recode AS county_fips,
          medicare_benes,
          power_dependent_dme,
          power_dependent_is_censored,
          o2_services_any_dme,
          facility_esrd_dialysis_any_dme,
          home_health_services_any_dme,
          athome_hospice_any_dme
        FROM `{project}.{dataset}.power_dependent_counties`
        WHERE fips_code_recode = @cfips OR fips_code = @cfips
        LIMIT 1
        """
        emp_cfg = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("cfips", "STRING", str(nearest_tract["county_fips"]))
            ]
        )
        emp_rows = list(client.query(empower_sql, job_config=emp_cfg).result())
        if emp_rows:
            county_power = {k: _sanitize_value(v) for k, v in dict(emp_rows[0].items()).items()}

    # 3. Nearby Shelters within radius_km
    shelters_sql = f"""
    SELECT
      CAST(shelter_id AS STRING) AS shelter_id,
      shelter_name,
      address_1,
      city,
      COALESCE(county_name, county_parish) AS county_name,
      zip,
      latitude,
      longitude,
      ROUND(ST_DISTANCE(ST_GEOGPOINT(longitude, latitude), ST_GEOGPOINT(@lng, @lat)) / 1000.0, 2) AS distance_km,
      evacuation_capacity,
      post_impact_capacity,
      wheelchair_accessible,
      generator_onsite,
      self_sufficient_electricity,
      in_surge_slosh_area,
      in_100_yr_floodplain,
      is_medical,
      usage
    FROM `{project}.{dataset}.shelters`
    WHERE latitude IS NOT NULL
      AND longitude IS NOT NULL
      AND ST_DWITHIN(ST_GEOGPOINT(longitude, latitude), ST_GEOGPOINT(@lng, @lat), @radius_m)
    ORDER BY distance_km ASC
    LIMIT 8
    """
    nearby_shelters = []
    for r in client.query(shelters_sql, job_config=job_config).result():
        row_dict = {k: _sanitize_value(v) for k, v in dict(r.items()).items()}
        row_dict["wheelchair_status"] = _flag_label(row_dict.get("wheelchair_accessible"))
        row_dict["generator_status"] = _flag_label(row_dict.get("generator_onsite"))
        nearby_shelters.append(row_dict)

    # 4. Nearby Care Facilities / Nursing Homes within radius_km
    care_sql = f"""
    SELECT
      cms_certification_number_ccn,
      provider_name,
      provider_address,
      citytown,
      zip_code,
      number_of_certified_beds,
      ownership_type,
      latitude,
      longitude,
      ROUND(ST_DISTANCE(ST_GEOGPOINT(longitude, latitude), ST_GEOGPOINT(@lng, @lat)) / 1000.0, 2) AS distance_km
    FROM `{project}.{dataset}.care_facilities`
    WHERE latitude IS NOT NULL
      AND longitude IS NOT NULL
      AND ST_DWITHIN(ST_GEOGPOINT(longitude, latitude), ST_GEOGPOINT(@lng, @lat), @radius_m)
    ORDER BY distance_km ASC
    LIMIT 5
    """
    nearby_care = [
        {k: _sanitize_value(v) for k, v in dict(r.items()).items()}
        for r in client.query(care_sql, job_config=job_config).result()
    ]

    # 5. Live Google Maps Grounding (Places + Routing via Vertex AI)
    maps_summary = ""
    maps_route: Optional[Dict[str, Any]] = None
    grounding_chunks: List[MapsGroundingChunk] = []
    seen_uris: set = set()
    maps_error: Optional[str] = None

    top_shelter = nearby_shelters[0] if nearby_shelters else None
    shelter_prompt_part = ""
    if top_shelter:
        shelter_prompt_part = (
            f"\n2) Verify the nearest registered FEMA shelter: \"{top_shelter['shelter_name']}\" at "
            f"{top_shelter.get('address_1')}, {top_shelter.get('city')}, FL {top_shelter.get('zip') or ''}. "
            f"State its current Google Maps name, operational status (OPERATIONAL or CLOSED), whether Google Maps "
            f"lists a wheelchair-accessible entrance, and the driving time and distance from ({lat:.5f}, {lng:.5f}) "
            f"to this shelter."
        )

    maps_prompt = (
        f"A planner clicked the map at coordinates ({lat:.5f}, {lng:.5f}) in Florida.\n"
        f"Using Google Maps Grounding, provide a concise 3-part live area briefing:\n"
        f"1) **Clicked Area & Neighborhood**: Identify the neighborhood, city, and major roads/bridges around ({lat:.5f}, {lng:.5f})."
        f"{shelter_prompt_part}\n"
        f"3) **Nearby Emergency & Medical Facilities**: List 1-2 nearby hospitals, urgent care centers, or fire/emergency facilities on Google Maps."
    )

    if include_maps:
        try:
            genai_client = genai.Client(vertexai=True, project=project, location="global")
            model_name = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")
            gt = types.GoogleMapsGroundingTypes(
                places=types.GoogleMapsPlaces(),
                routing=types.GoogleMapsRouting() if top_shelter else None,
            )
            maps_tool = types.Tool(google_maps=types.GoogleMaps(grounding_types=gt))

            resp = genai_client.models.generate_content(
                model=model_name,
                contents=maps_prompt,
                config=types.GenerateContentConfig(tools=[maps_tool], temperature=0.1),
            )
            maps_summary = (resp.text or "").strip()

            gm = resp.candidates[0].grounding_metadata if resp.candidates else None
            for ch in (gm.grounding_chunks if gm and gm.grounding_chunks else []):
                if not getattr(ch, "maps", None):
                    continue
                m = ch.maps
                if getattr(m, "route", None) and maps_route is None:
                    secs = float(str(m.route.duration or "0s").rstrip("s") or 0)
                    maps_route = {
                        "drive_minutes": round(secs / 60, 1),
                        "drive_miles": round((m.route.distance_meters or 0) / 1609.34, 1),
                        "drive_km": round((m.route.distance_meters or 0) / 1000.0, 2),
                    }
                    continue
                uri = getattr(m, "uri", None)
                if uri and uri not in seen_uris:
                    seen_uris.add(uri)
                    grounding_chunks.append(
                        MapsGroundingChunk(
                            place_id=getattr(m, "place_id", None),
                            title=getattr(m, "title", None) or "Google Maps Place",
                            uri=uri,
                        )
                    )
        except Exception as exc:
            maps_error = str(exc)[:250]

    return {
        "coordinates": {"lat": round(lat, 5), "lng": round(lng, 5), "radius_km": radius_km},
        "elapsed_seconds": round(time.time() - t0, 1),
        "nearest_tract": nearest_tract,
        "county_power_dependent": county_power,
        "nearby_shelters": nearby_shelters,
        "nearby_care_facilities": nearby_care,
        "google_maps_live": {
            "summary": maps_summary,
            "route_to_nearest_shelter": maps_route,
            "grounding_chunks": [c.model_dump() for c in grounding_chunks],
            "error": maps_error,
        },
    }


@app.get("/api/shelters/google-maps")
def verify_shelter_google_maps(
    shelter_id: str = Query(..., description="FEMA shelter ID"),
    name: str = Query(..., description="Recorded shelter name"),
    address: str = Query("", description="Street address"),
    city: str = Query("", description="City"),
    zip_code: str = Query("", description="ZIP code"),
    bq_access: str = Query("UNRECORDED", description="BigQuery wheelchair_accessible status: YES, NO, or UNRECORDED"),
) -> Dict[str, Any]:
    """
    Live verification of a single FEMA shelter against Vertex AI Grounding with Google Maps,
    following agent/evac_agent/verify.py and returning open hours + accessibility reconciliation.
    """
    t0 = time.time()
    project = os.environ.get("GOOGLE_CLOUD_PROJECT", "kaggle-data-486706")
    model_name = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

    prompt = (
        f"You are checking one entry in FEMA's historical hurricane-shelter registry against Google Maps.\n\n"
        f"Registry entry: \"{name}\", {address}, {city}, Florida {zip_code}.\n"
        f"Use Google Maps to answer about THIS building at THIS address only.\n"
        f"Answer in exactly these lines, plain text, no JSON, no markdown:\n"
        f"FOUND: yes or no\n"
        f"MAPS NAME: current name on Google Maps\n"
        f"MAPS ADDRESS: address on Google Maps\n"
        f"PLACE TYPE: what kind of place it is\n"
        f"STATUS: OPERATIONAL, CLOSED_PERMANENTLY, CLOSED_TEMPORARILY or UNKNOWN\n"
        f"OPEN HOURS: regular opening hours listed on Google Maps (e.g. Mon-Fri 7:30 AM - 4:00 PM), or not listed\n"
        f"SAME PLACE AS REGISTRY: yes, no or unsure\n"
        f"WHEELCHAIR ENTRANCE: Google Maps lists a wheelchair accessible entrance / Google Maps says the entrance is not wheelchair accessible / not listed\n"
        f"ACCESSIBILITY ATTRIBUTES: the accessibility attributes exactly as Google Maps lists them, or none\n"
        f"NOTES: one short sentence on anything that changed or notable facility details"
    )

    fields_map = {
        "FOUND": "found",
        "MAPS NAME": "maps_name",
        "MAPS ADDRESS": "maps_address",
        "PLACE TYPE": "place_type",
        "STATUS": "business_status",
        "OPEN HOURS": "open_hours",
        "SAME PLACE AS REGISTRY": "same_place_as_registry",
        "WHEELCHAIR ENTRANCE": "wheelchair_accessible_entrance",
        "ACCESSIBILITY ATTRIBUTES": "accessibility_attributes",
        "NOTES": "notes",
    }

    ans: Dict[str, Any] = {}
    grounded: set = set()
    grounding_chunks: List[MapsGroundingChunk] = []
    seen_uris: set = set()
    err_msg: Optional[str] = None

    try:
        genai_client = genai.Client(vertexai=True, project=project, location="global")
        gt = types.GoogleMapsGroundingTypes(places=types.GoogleMapsPlaces())
        maps_tool = types.Tool(google_maps=types.GoogleMaps(grounding_types=gt))

        for _attempt in range(2):
            resp = genai_client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(tools=[maps_tool], temperature=0.0),
            )
            gm = resp.candidates[0].grounding_metadata if resp.candidates else None
            supports = gm.grounding_supports if gm else None
            seg_texts = [
                (sp.segment.text or "").strip()
                for sp in (supports or [])
                if getattr(sp, "segment", None) and getattr(sp, "grounding_chunk_indices", None)
            ]
            ans = {}
            grounded = set()
            for line in (resp.text or "").splitlines():
                label, _, value = line.strip().strip("*").partition(":")
                key = fields_map.get(label.strip().upper())
                if not key:
                    continue
                val = value.strip()
                ans[key] = val
                if any(t and (t in line or line.strip() in t) for t in seg_texts):
                    grounded.add(key)

            grounding_chunks = []
            seen_uris = set()
            for ch in (gm.grounding_chunks if gm and gm.grounding_chunks else []):
                if not getattr(ch, "maps", None):
                    continue
                m = ch.maps
                if getattr(m, "route", None):
                    continue
                uri = getattr(m, "uri", None)
                if uri and uri not in seen_uris:
                    seen_uris.add(uri)
                    grounding_chunks.append(
                        MapsGroundingChunk(
                            place_id=getattr(m, "place_id", None),
                            title=getattr(m, "title", None) or "Google Maps Place",
                            uri=uri,
                        )
                    )
            if grounding_chunks:
                break
    except Exception as exc:
        err_msg = str(exc)[:250]

    wc_raw = str(ans.get("wheelchair_accessible_entrance") or "").lower()
    if "not wheelchair" in wc_raw or wc_raw == "no":
        maps_access = "NO"
    elif "lists a wheelchair" in wc_raw or "accessible entrance" in wc_raw or wc_raw == "yes":
        maps_access = "YES"
    else:
        maps_access = "UNLISTED"

    # Follow agent/evac_agent/verify.py: only accept a YES/NO accessibility claim if grounded in Google Maps
    if maps_access in ("YES", "NO") and grounded and "wheelchair_accessible_entrance" not in grounded and not grounding_chunks:
        maps_access = "UNLISTED"

    fema_wc = bq_access.upper() if bq_access.upper() in ("YES", "NO", "UNRECORDED") else "UNRECORDED"

    return {
        "shelter_id": shelter_id,
        "registry_name": name,
        "registry_address": f"{address}, {city}".strip(", "),
        "found": str(ans.get("found", "")).lower().startswith("yes"),
        "maps_name": ans.get("maps_name") or name,
        "maps_address": ans.get("maps_address") or f"{address}, {city}".strip(", "),
        "place_type": ans.get("place_type") or "Not listed",
        "business_status": str(ans.get("business_status") or "UNKNOWN").upper(),
        "open_hours": ans.get("open_hours") or "Not listed on Google Maps",
        "same_place_as_registry": str(ans.get("same_place_as_registry") or "unsure").lower(),
        "bq_access": fema_wc,
        "maps_access": maps_access,
        "accessibility_attributes": ans.get("accessibility_attributes") or "None listed",
        "notes": ans.get("notes") or "",
        "grounding_chunks": [c.model_dump() for c in grounding_chunks],
        "elapsed_seconds": round(time.time() - t0, 1),
        "error": err_msg,
    }


# Serve the built React dashboard (copied to ./static in the dashboard image). Mounted last so the
# /api and /health routes above take precedence.
_STATIC_DIR = _AGENT_DIR / "static"
if _STATIC_DIR.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=_STATIC_DIR, html=True), name="dashboard")
