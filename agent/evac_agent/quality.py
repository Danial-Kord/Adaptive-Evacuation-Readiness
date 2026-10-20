"""Q3 tools: how sure can we be? Counts what the record never captured, finds records that contradict
themselves, and says how old each kind of fact is."""
from __future__ import annotations

from google.adk.tools.tool_context import ToolContext

from .config import LBL, table
from .data import _rows, resolve_county
from .schemas import (
    ActionOption,
    ActionSeverity,
    ActionType,
    ApprovalDetails,
    AttentionItem,
    ContradictoryRecordEntry,
    DataQualityReportOutput,
    InteractionMode,
    LocationInfo,
    RecommendedAction,
    SelfContradictingAddressGroup,
    SuspiciousShelterRecord,
    record_actions_in_state,
)


def data_quality_report(county: str = "", tool_context: ToolContext = None) -> dict:
    """Audits the shelter record for one Florida county (or all of Florida if county is ""): what is
    unrecorded, what contradicts itself, and what looks stale. Use it to answer "how accurate / up to
    date is this data?" and before trusting any shelter-level conclusion.

    Args:
      county: Florida county name, or "" for statewide.

    Returns:
      unrecorded counts per field, self-contradicting records (same address, conflicting flags) with
      coordinates, suspicious records with coordinates, freshness of each source, and structured
      `recommended_actions` (validated via `DataQualityReportOutput`).
    """
    where, params, scope = "TRUE", {}, "Florida"
    if county.strip():
        fips, name = resolve_county(county)
        where, params, scope = "county_fips = @fips", {"fips": fips}, f"{name} County"
    S = table("shelters_enriched")
    unrec = _rows(
        f"""
        SELECT COUNT(*) shelters,
          COUNTIF(wheelchair='UNRECORDED') wheelchair, COUNTIF(generator='UNRECORDED') generator,
          COUNTIF(surge_flag='UNRECORDED') surge_flag, COUNTIF(evacuation_capacity IS NULL) capacity,
          COUNTIF(usage_unknown) usage
        FROM {S} WHERE {where}""",
        **params,
    )[0]
    conflicts_raw = _rows(
        f"""
        SELECT UPPER(address) address, ANY_VALUE(city) city, ANY_VALUE(county_name) county_name,
          ANY_VALUE(county_fips) county_fips,
          ROUND(AVG(latitude), 5) lat, ROUND(AVG(longitude), 5) lon,
          ARRAY_AGG(STRUCT(shelter_id, shelter_name, wheelchair, generator, evacuation_capacity AS capacity) LIMIT 4) records
        FROM {S} WHERE {where}
        GROUP BY UPPER(address)
        HAVING COUNT(DISTINCT IF(wheelchair != 'UNRECORDED', wheelchair, NULL)) > 1
            OR COUNT(DISTINCT IF(generator != 'UNRECORDED', generator, NULL)) > 1
        LIMIT 10""",
        **params,
    )
    suspicious_raw = _rows(
        f"""
        SELECT * FROM (
        SELECT shelter_id, shelter_name, address, city, county_name, county_fips,
          ROUND(latitude, 5) lat, ROUND(longitude, 5) lon,
          CASE
            WHEN REGEXP_CONTAINS(UPPER(shelter_name), r'INACTIVE|CLOSED|DEMOLISH') THEN 'name says inactive/closed'
            WHEN pre_landfall AND evacuation_capacity = 0 THEN 'pre-landfall shelter with 0 recorded capacity'
            WHEN UPPER(REGEXP_REPLACE(REPLACE(UPPER(fema_county_text),'SAINT','ST.'), r'[^A-Z.]', ''))
                 != UPPER(REGEXP_REPLACE(county_name, r'[^A-Za-z.]', '')) THEN 'FEMA county text disagrees with coordinates'
          END issue
        FROM {S} WHERE {where})
        WHERE issue IS NOT NULL
        ORDER BY issue LIMIT 15""",
        **params,
    )
    yes_by_county = _rows(
        f"""
        SELECT county_name, COUNT(*) shelters, COUNTIF(wheelchair != 'UNRECORDED') answered
        FROM {S} GROUP BY 1 ORDER BY answered DESC LIMIT 3"""
    )
    blank_counties = _rows(
        f"""
        SELECT COUNT(*) n FROM (SELECT county_name FROM {S} GROUP BY 1 HAVING COUNTIF(wheelchair != 'UNRECORDED') = 0)"""
    )[0]

    conflicts: list[SelfContradictingAddressGroup] = []
    suspicious: list[SuspiciousShelterRecord] = []
    actions: list[RecommendedAction] = []

    for idx, c in enumerate(conflicts_raw):
        recs = [ContradictoryRecordEntry(**r) for r in (c.get("records") or [])]
        first_sid = recs[0].shelter_id if recs else None
        loc = LocationInfo(
            lat=c.get("lat"),
            lon=c.get("lon"),
            label=f"{recs[0].shelter_name if recs else c['address']} ({c.get('city') or scope})",
            address=c.get("address"),
            city=c.get("city"),
            county=c.get("county_name"),
            county_fips=c.get("county_fips"),
            shelter_id=first_sid,
        )
        conflicts.append(
            SelfContradictingAddressGroup(
                address=c["address"],
                city=c.get("city"),
                county_name=c.get("county_name"),
                lat=c.get("lat"),
                lon=c.get("lon"),
                location=loc,
                records=recs,
            )
        )
        options = [
            ActionOption(
                option_id=f"record-{r.shelter_id or i}",
                label=f"Use '{r.shelter_name}' (#{r.shelter_id}): wheelchair={r.wheelchair}, generator={r.generator}",
                description=f"Capacity: {r.capacity if r.capacity is not None else 'unrecorded'} · FEMA record #{r.shelter_id}",
                recommended=False,
                location=loc.model_copy(update={"shelter_id": r.shelter_id, "label": r.shelter_name}),
                metrics={
                    "shelter_id": r.shelter_id,
                    "wheelchair": r.wheelchair,
                    "generator": r.generator,
                    "capacity": r.capacity,
                },
                warnings=["Conflicting sibling record exists at same address"],
            )
            for i, r in enumerate(recs)
        ]
        options.append(
            ActionOption(
                option_id=f"interview-operator-{first_sid or idx}",
                label="Hold Both & Interview Operator to Reconcile",
                description="Do not trust either conflicting FEMA record until the facility operator confirms wheelchair & generator status.",
                recommended=True,
                location=loc,
                metrics={"address": c["address"], "conflicting_records": len(recs)},
            )
        )
        actions.append(
            RecommendedAction(
                action_id=f"act-conflict-addr-{first_sid or idx}",
                action_type=ActionType.RESOLVE_CONTRADICTORY_RECORDS,
                agent_source="verification_agent",
                interaction_mode=InteractionMode.SELECT_BETWEEN_OPTIONS,
                requires_approval=True,
                requires_selection=True,
                severity=ActionSeverity.HIGH,
                title=f"Resolve Contradictory FEMA Records at {c['address']}, {c.get('city') or ''}",
                summary=(
                    f"{len(recs)} FEMA shelter records at {c['address']} ({c.get('city')}) disagree on wheelchair "
                    f"or generator status. Select the authoritative record or trigger an operator reconciliation."
                ),
                affected_count=len(recs),
                affected_unit="conflicting_records",
                primary_location=loc,
                attention_items=[
                    AttentionItem(
                        label=r.shelter_name,
                        value=f"wheelchair={r.wheelchair}, generator={r.generator}, cap={r.capacity}",
                        source_badge=LBL["fema"],
                        is_warning=True,
                    )
                    for r in recs
                ],
                approval=ApprovalDetails(
                    confirm_label="Apply Selected Resolution",
                    reject_label="Defer",
                    proposed_change=f"Reconcile conflicting FEMA records at {c['address']} ({c.get('city')}).",
                    target_entity_type="shelter",
                    target_entity_id=str(first_sid or c["address"]),
                    payload={"address": c["address"], "shelter_ids": [r.shelter_id for r in recs]},
                    irreversible_or_high_impact=False,
                ),
                options=options,
                selected_option_id=f"interview-operator-{first_sid or idx}",
            )
        )

    for s in suspicious_raw:
        loc = LocationInfo(
            lat=s.get("lat"),
            lon=s.get("lon"),
            label=f"{s['shelter_name']} ({s.get('city') or ''})",
            address=s.get("address"),
            city=s.get("city"),
            county=s.get("county_name"),
            county_fips=s.get("county_fips"),
            shelter_id=int(s["shelter_id"]),
        )
        suspicious.append(
            SuspiciousShelterRecord(
                shelter_id=int(s["shelter_id"]),
                shelter_name=s["shelter_name"],
                address=s.get("address"),
                city=s.get("city"),
                county_name=s.get("county_name"),
                lat=s.get("lat"),
                lon=s.get("lon"),
                location=loc,
                issue=s["issue"],
            )
        )
        if len(actions) < 12:
            issue_str = s["issue"]
            if "inactive/closed" in issue_str:
                act_type = ActionType.DROP_CLOSED_SHELTER
                title_str = f"Approve Removal of '{s['shelter_name']}' (Name Indicates Inactive/Closed)"
            elif "0 recorded capacity" in issue_str:
                act_type = ActionType.CONFIRM_SHELTER_CAPACITY
                title_str = f"Confirm Capacity or Hold '{s['shelter_name']}' (0 Pre-Landfall Capacity Recorded)"
            else:
                act_type = ActionType.IN_PERSON_BUILDING_CHECK
                title_str = f"Verify County/Coordinates Mismatch for '{s['shelter_name']}'"

            actions.append(
                RecommendedAction(
                    action_id=f"act-suspicious-{s['shelter_id']}",
                    action_type=act_type,
                    agent_source="verification_agent",
                    interaction_mode=InteractionMode.APPROVAL_REQUIRED,
                    requires_approval=True,
                    requires_selection=False,
                    severity=ActionSeverity.HIGH if act_type == ActionType.DROP_CLOSED_SHELTER else ActionSeverity.MEDIUM,
                    title=title_str,
                    summary=f"FEMA registry issue on shelter #{s['shelter_id']} ({s['shelter_name']}, {s.get('city')}): {issue_str}.",
                    affected_count=1,
                    affected_unit="shelters",
                    primary_location=loc,
                    attention_items=[
                        AttentionItem(label="Registry anomaly", value=issue_str, source_badge=LBL["fema"], is_warning=True)
                    ],
                    approval=ApprovalDetails(
                        confirm_label="Approve Action",
                        reject_label="Keep As-Is",
                        proposed_change=f"Flag/remove suspicious shelter #{s['shelter_id']} ({s['shelter_name']}) from active plan until verified.",
                        target_entity_type="shelter",
                        target_entity_id=str(s["shelter_id"]),
                        payload={"shelter_id": int(s["shelter_id"]), "issue": issue_str},
                        irreversible_or_high_impact=(act_type == ActionType.DROP_CLOSED_SHELTER),
                    ),
                )
            )

    record_actions_in_state(tool_context, actions)
    out = DataQualityReportOutput(
        scope=scope,
        unrecorded_counts={**unrec, "label": LBL["unrecorded"] + " = nobody wrote it down; never treat as NO"},
        self_contradicting_records=conflicts,
        suspicious_records=suspicious,
        reporting_bias={
            "counties_with_zero_wheelchair_answers": blank_counties["n"],
            "counties_answering_most": yes_by_county,
            "meaning": (
                "Recorded accessibility measures which counties fill in the form, not which buildings work. "
                "Never rank places by recorded accessibility."
            ),
        },
        freshness={
            "shelters": (
                f"{LBL['fema']}: a registry of every facility ever registered, some from past incidents. "
                "FEMA says it must not be used for operational status."
            ),
            "people": f"{LBL['measured']} ACS 2022 5-year; {LBL['modeled']} CDC PLACES 2025; CDC SVI 2022.",
            "hazard": "FEMA National Risk Index (tract level, planning use only).",
            "power_dependence": f"{LBL['county']}, monthly.",
            "live": f"{LBL['live']}: checked at the moment you ask; place_id is the only thing stored.",
        },
        how_we_handle_missing_data=[
            "Unrecorded stays its own category (❓), counted and shown, never folded into NO.",
            "Shelters with no recorded capacity are not counted as usable spaces.",
            "Accessibility from Google Maps is accepted only when Google Maps cites it, and an accessible entrance "
            "is not treated as proof a wheelchair user can use the shelter unaccompanied.",
            "Operator interviews (record_shelter_assessment) fill the gaps the registry left.",
        ],
        recommended_actions=actions,
    )
    return out.model_dump()
