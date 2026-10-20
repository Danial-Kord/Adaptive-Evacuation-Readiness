"""FastAPI server wrapping the ADK Runner, Google Maps grounding metadata, and BigQuery Admin Explorer."""

import math
import os
from pathlib import Path
from typing import Any, Dict, List, Optional
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.cloud import bigquery
from google.genai import types

from evacuation_agent.agent import root_agent
from evacuation_agent.schemas import ChatRequest, ChatResponse, MapsGroundingChunk

# Load .env from either agent/.env or the repository root .env
_AGENT_DIR = Path(__file__).resolve().parent
load_dotenv(_AGENT_DIR / ".env")
load_dotenv(_AGENT_DIR.parent / ".env")

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



@app.post("/api/chat", response_model=ChatResponse)
async def chat_endpoint(req: ChatRequest) -> ChatResponse:
    """Run a turn against the ADK agent and return both text and Google Maps grounding chunks."""
    user_id = "emergency-manager"
    session_id = req.session_id or "default-session"

    session = await session_service.get_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id
    )
    if session is None:
        session = await session_service.create_session(
            app_name=APP_NAME, user_id=user_id, session_id=session_id
        )

    contextual_prompt = f"[Context: State={req.state}, County={req.county}] {req.message}"
    new_message = types.Content(
        role="user", parts=[types.Part.from_text(text=contextual_prompt)]
    )

    reply_parts: List[str] = []
    grounding_chunks: List[MapsGroundingChunk] = []
    seen_uris = set()

    try:
        async for event in runner.run_async(
            user_id=user_id, session_id=session.id, new_message=new_message
        ):
            if event.content and event.content.parts:
                for part in event.content.parts:
                    if part.text and event.is_final_response():
                        reply_parts.append(part.text)

            # Extract Google Maps grounding chunks for required UI attribution
            gm = getattr(event, "grounding_metadata", None)
            if gm and getattr(gm, "grounding_chunks", None):
                for ch in gm.grounding_chunks:
                    maps_obj = getattr(ch, "maps", None)
                    if maps_obj and getattr(maps_obj, "uri", None):
                        if maps_obj.uri not in seen_uris:
                            seen_uris.add(maps_obj.uri)
                            grounding_chunks.append(
                                MapsGroundingChunk(
                                    place_id=getattr(maps_obj, "place_id", None),
                                    title=getattr(maps_obj, "title", "Google Maps Place"),
                                    uri=maps_obj.uri,
                                )
                            )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return ChatResponse(
        reply="\n".join(reply_parts).strip() or "No response generated.",
        county=req.county or "Miami-Dade",
        state=req.state or "FL",
        grounding_chunks=grounding_chunks,
    )
