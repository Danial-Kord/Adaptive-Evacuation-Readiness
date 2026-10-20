"""BigQuery-backed tools. The SQL that encodes the data rules lives in agent/sql/derived.sql;
these functions hold the judgment calls on top of it."""
from __future__ import annotations

import datetime as dt
import math
import re
from functools import lru_cache

from typing import Optional

from google.adk.tools import ToolContext
from google.cloud import bigquery

from .config import DRIVE_KM, PROJECT, WALK_KM, table
from .schemas import (
    ActionOption,
    ActionSeverity,
    ActionType,
    ApprovalDetails,
    AttentionItem,
    CountyGapReportOutput,
    EquityAuditGroup,
    EquityAuditOutput,
    FindSheltersOutput,
    InteractionMode,
    LocationInfo,
    RecommendedAction,
    RecordShelterAssessmentOutput,
    ShelterAssessmentRecord,
    ShelterRegistryRow,
    record_actions_in_state,
)

KM_TO_MI = 0.621


@lru_cache(maxsize=1)
def _bq() -> bigquery.Client:
    return bigquery.Client(project=PROJECT)


def _rows(sql: str, **params) -> list[dict]:
    qp = []
    for k, v in params.items():
        typ = "INT64" if isinstance(v, int) else "FLOAT64" if isinstance(v, float) else "STRING"
        qp.append(bigquery.ScalarQueryParameter(k, typ, v))
    job = _bq().query(sql, job_config=bigquery.QueryJobConfig(query_parameters=qp))
    return [_clean(dict(r)) for r in job.result()]


def _clean(d: dict) -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, float):
            v = None if math.isnan(v) else round(v, 3)
        elif isinstance(v, (dt.datetime, dt.date)):
            v = v.isoformat()
        out[k] = v
    return out


def _norm_county(name: str) -> str:
    s = name.lower().strip()
    s = re.sub(r"\b(county|parish)\b", "", s)
    s = re.sub(r"\bsaint\b", "st.", s)
    s = re.sub(r"\bst\b(?!\.)", "st.", s)
    return re.sub(r"[^a-z.]", "", s)


@lru_cache(maxsize=1)
def _counties() -> dict[str, tuple[str, str]]:
    rows = _rows(f"SELECT county_fips, county_name FROM {table('counties')}")
    out = {}
    for r in rows:
        out[_norm_county(r["county_name"])] = (r["county_fips"], r["county_name"])
        out[r["county_fips"]] = (r["county_fips"], r["county_name"])
    return out


def resolve_county(county: str) -> tuple[str, str]:
    key = county.strip() if county.strip().isdigit() else _norm_county(county)
    hit = _counties().get(key)
    if not hit:
        raise ValueError(f"Unknown county {county!r}. Use a Florida county name such as 'Lee' or 'Miami-Dade'.")
    return hit


def _reach_label(km: float, share_no_vehicle: float | None) -> str:
    if km <= WALK_KM:
        return "walkable (within 1 mile)"
    if km <= DRIVE_KM:
        return "beyond walking distance: households here without a vehicle need a pickup"
    return "beyond 15 miles (25 km): not a realistic destination without organized transport"


# ---------------------------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------------------------

def find_people_who_cannot_self_evacuate(county: str, top_n: int = 10) -> dict:
    """Ranks the census tracts in a Florida county holding the most people who cannot get
    themselves out, among tracts an evacuation order would target.

    Ranking uses counts, not percentages: households with no vehicle (ACS, measured, weighted
    double), adults with a mobility disability (CDC PLACES, modeled estimate), residents 65+,
    and mobile homes, each as a percentile within the county. Tracts with >=25% of residents
    exposed to coastal flooding or >=10% mobile homes are evacuation-zone tracts; the rest are
    halved as shelter-in-place candidates ("run from water, hide from wind").

    Args:
      county: Florida county name, e.g. "Lee" or "Miami-Dade".
      top_n: how many tracts to return (max 25).

    Returns:
      dict with county totals and a ranked list of tracts, each with the reasons it ranks high
      and how far its nearest shelter options are.
    """
    fips, name = resolve_county(county)
    top_n = max(1, min(int(top_n), 25))
    totals = _rows(f"""
        SELECT COUNT(*) tracts, SUM(total_pop) population, SUM(hh_no_vehicle) households_no_vehicle,
          SUM(pop_65_plus) pop_65_plus, ROUND(SUM(est_mobility_disabled_modeled)) mobility_disabled_modeled,
          SUM(mobile_homes) mobile_homes,
          COUNTIF(evacuation_driver IS NOT NULL) evacuation_zone_tracts,
          SUM(IF(evacuation_driver IS NOT NULL, total_pop, 0)) evacuation_zone_population,
          SUM(IF(evacuation_driver IS NOT NULL, hh_no_vehicle, 0)) evacuation_zone_households_no_vehicle,
          COUNTIF(hazard_missing) tracts_without_hazard_data
        FROM {table('tract_readiness')} WHERE county_fips = @fips""", fips=fips)[0]
    tracts = _rows(f"""
        SELECT geo_id, near_city, ROUND(lat, 4) lat, ROUND(lon, 4) lon, total_pop, hh_no_vehicle,
          ROUND(100 * share_no_vehicle, 1) pct_households_no_vehicle, pop_65_plus,
          ROUND(est_mobility_disabled_modeled) mobility_disabled_modeled, mobile_homes,
          group_quarters_pop, evacuation_driver, ROUND(100 * coastal_flood_share) pct_coastal_flood_exposed,
          ROUND(0.621 * km_nearest_shelter, 1) miles_nearest_shelter,
          ROUND(0.621 * km_nearest_recorded_accessible, 1) miles_nearest_recorded_wheelchair_yes,
          n_within_walk shelters_within_1_mile, n_within_walk_wc_yes, n_within_walk_wc_no,
          n_within_walk_wc_unrecorded, ROUND(priority_score, 3) priority_score,
          pr_no_vehicle, pr_mobility, pr_65_plus, pr_mobile_homes
        FROM {table('tract_readiness')} WHERE county_fips = @fips
        ORDER BY priority_score DESC LIMIT @n""", fips=fips, n=top_n)
    for t in tracts:
        reasons = []
        for key, label in [("pr_no_vehicle", f"{int(t['hh_no_vehicle'])} households with no vehicle"),
                           ("pr_mobility", f"~{int(t['mobility_disabled_modeled'] or 0)} adults with a mobility disability (modeled)"),
                           ("pr_65_plus", f"{int(t['pop_65_plus'])} residents 65+"),
                           ("pr_mobile_homes", f"{int(t['mobile_homes'])} mobile homes")]:
            if (t.pop(key) or 0) >= 0.75:
                reasons.append(label + " (top quartile in county)")
        t["why"] = reasons or ["above-median need across several measures"]
        t["evacuation_driver"] = t["evacuation_driver"] or "none (shelter-in-place candidate)"
        t["location"] = LocationInfo(
            lat=t.get("lat"),
            lon=t.get("lon"),
            label=f"Tract {t['geo_id']} (near {t.get('near_city') or name})",
            city=t.get("near_city"),
            county=name,
            county_fips=fips,
            geo_id=t["geo_id"],
        ).model_dump()
    return {
        "county": name, "county_fips": fips, "county_totals": totals, "tracts": tracts,
        "method": "Percentile ranks within county of counts; no-vehicle households weighted x2. "
                  "No race/ethnicity input. Distances are straight-line miles to pre-landfall (EVAC/BOTH) shelters.",
        "source": "ACS 2022 5-yr, CDC SVI 2022, CDC PLACES 2025 (modeled), FEMA NRI. Historical/statistical, not live.",
    }


def shelter_options_for_tract(geo_id: str, limit: int = 6) -> dict:
    """Lists the nearest pre-landfall shelters (usage EVAC or BOTH, plus usage-unknown) to a
    census tract, with what the FEMA record says and what it does not.

    Every flag is YES / NO / UNRECORDED. UNRECORDED means nobody wrote it down; it is never "no".

    Args:
      geo_id: 11-digit census tract id, e.g. "12071050402".
      limit: number of shelters to return (max 12).

    Returns:
      dict with the tract's no-vehicle share and a list of shelters with distance, a
      reachability label for this tract, capacity, record flags and site flood hazard.
    """
    limit = max(1, min(int(limit), 12))
    tract = _rows(f"""SELECT geo_id, county_name, county_fips, near_city, lat, lon, total_pop, hh_no_vehicle, share_no_vehicle
                      FROM {table('tract_readiness')} WHERE geo_id = @g""", g=geo_id)
    if not tract:
        return {"error": f"tract {geo_id} not found"}
    t = tract[0]
    t["location"] = LocationInfo(
        lat=t.get("lat"),
        lon=t.get("lon"),
        label=f"Tract {t['geo_id']} (near {t.get('near_city') or t.get('county_name')})",
        city=t.get("near_city"),
        county=t.get("county_name"),
        county_fips=t.get("county_fips"),
        geo_id=t["geo_id"],
    ).model_dump()
    shelters = _rows(f"""
        SELECT shelter_id, shelter_name, address, city, county_name, county_fips,
          ROUND(latitude, 5) latitude, ROUND(longitude, 5) longitude, usage,
          evacuation_capacity, wheelchair, generator, surge_flag, is_medical,
          site_in_flood_hazard, ROUND(100 * site_coastal_flood_share) site_pct_coastal_flood_exposed,
          incident_id,
          ROUND(ST_DISTANCE(ST_GEOGPOINT(longitude, latitude), ST_GEOGPOINT(@lon, @lat)) / 1000, 2) km
        FROM {table('shelters_enriched')}
        WHERE (pre_landfall OR usage_unknown)
          AND ST_DWITHIN(ST_GEOGPOINT(longitude, latitude), ST_GEOGPOINT(@lon, @lat), 40000)
        ORDER BY km LIMIT @n""", lat=float(t["lat"]), lon=float(t["lon"]), n=limit)
    for s in shelters:
        s["miles"] = round(s["km"] * KM_TO_MI, 1)
        s["reachability"] = _reach_label(s["km"], t["share_no_vehicle"])
        cap = s.pop("evacuation_capacity")
        s["capacity"] = "UNRECORDED" if cap is None else ("0 recorded (verify)" if cap == 0 else cap)
        s["record_source"] = (f"FEMA National Shelter System record (historical; registered under incident "
                              f"{int(s['incident_id'])})" if s["incident_id"] else
                              "FEMA National Shelter System record (historical)")
        s.pop("incident_id")
        s["location"] = LocationInfo(
            lat=s.get("latitude"),
            lon=s.get("longitude"),
            label=s["shelter_name"],
            address=s.get("address"),
            city=s.get("city"),
            county=s.get("county_name"),
            county_fips=s.get("county_fips"),
            shelter_id=int(s["shelter_id"]),
        ).model_dump()
    counts = {k: sum(1 for s in shelters if s["wheelchair"] == k) for k in ("YES", "NO", "UNRECORDED")}
    return {
        "tract": t, "shelters": shelters,
        "wheelchair_record_counts": counts,
        "note": "Distances are straight-line. Call verify_shelters_live with origin_tract for drive times "
                "and to check each building still exists.",
    }


def find_shelters(county: str, name_contains: str = "", pre_landfall_only: bool = True, limit: int = 25,
                  tool_context: Optional[ToolContext] = None) -> dict:
    """Searches the FEMA shelter registry in a county, optionally by name or street address.

    Args:
      county: Florida county name.
      name_contains: case-insensitive substring of the shelter name or street address; empty for all.
      pre_landfall_only: if true, only EVAC/BOTH/unknown-usage shelters.
      limit: max rows (max 50).

    Returns:
      dict with matching shelters (id, name, address, capacity, YES/NO/UNRECORDED flags) and
      category counts across the whole match set.
    """
    fips, name = resolve_county(county)
    where = "county_fips = @fips AND (LOWER(shelter_name) LIKE @pat OR LOWER(address) LIKE @pat)"
    if pre_landfall_only:
        where += " AND (pre_landfall OR usage_unknown)"
    pat = f"%{name_contains.lower().strip()}%"
    counts = _rows(f"""SELECT COUNT(*) shelters, SUM(evacuation_capacity) capacity_recorded,
          COUNTIF(evacuation_capacity IS NULL) capacity_unrecorded,
          COUNTIF(wheelchair='YES') wheelchair_yes, COUNTIF(wheelchair='NO') wheelchair_no,
          COUNTIF(wheelchair='UNRECORDED') wheelchair_unrecorded,
          COUNTIF(generator='YES') generator_yes, COUNTIF(generator='UNRECORDED') generator_unrecorded,
          COUNTIF(is_medical) medical_needs, COUNTIF(site_in_flood_hazard) on_flood_hazard_ground
        FROM {table('shelters_enriched')} WHERE {where}""", fips=fips, pat=pat)[0]
    rows = _rows(f"""SELECT shelter_id, shelter_name, address, city, county_name, county_fips,
          ROUND(latitude, 5) latitude, ROUND(longitude, 5) longitude,
          usage, evacuation_capacity capacity,
          wheelchair, generator, surge_flag, is_medical, site_in_flood_hazard
        FROM {table('shelters_enriched')} WHERE {where}
        ORDER BY evacuation_capacity DESC NULLS LAST LIMIT @n""", fips=fips, pat=pat, n=max(1, min(int(limit), 50)))

    shelter_models: list[ShelterRegistryRow] = []
    unrecorded_options: list[ActionOption] = []
    flood_options: list[ActionOption] = []

    for r in rows:
        loc = LocationInfo(
            lat=r.get("latitude"),
            lon=r.get("longitude"),
            label=r["shelter_name"],
            address=r.get("address"),
            city=r.get("city"),
            county=r.get("county_name") or name,
            county_fips=r.get("county_fips") or fips,
            shelter_id=int(r["shelter_id"]),
        )
        row_model = ShelterRegistryRow(
            shelter_id=int(r["shelter_id"]),
            shelter_name=r["shelter_name"],
            address=r.get("address"),
            city=r.get("city"),
            county_name=r.get("county_name") or name,
            latitude=r.get("latitude"),
            longitude=r.get("longitude"),
            location=loc,
            usage=r.get("usage"),
            capacity=r.get("capacity"),
            wheelchair=r["wheelchair"],
            generator=r["generator"],
            surge_flag=r["surge_flag"],
            is_medical=r.get("is_medical"),
            site_in_flood_hazard=r.get("site_in_flood_hazard"),
        )
        shelter_models.append(row_model)

        if r["wheelchair"] == "UNRECORDED" or r["generator"] == "UNRECORDED":
            unrecorded_options.append(
                ActionOption(
                    option_id=f"assess_shelter_{r['shelter_id']}",
                    label=f"Assess {r['shelter_name']} ({r.get('city') or name})",
                    description=(
                        f"Capacity: {r.get('capacity') if r.get('capacity') is not None else 'UNRECORDED'} · "
                        f"Wheelchair: {r['wheelchair']} · Generator: {r['generator']}"
                    ),
                    recommended=(len(unrecorded_options) == 0),
                    location=loc,
                    metrics={
                        "shelter_id": int(r["shelter_id"]),
                        "capacity": r.get("capacity"),
                        "wheelchair": r["wheelchair"],
                        "generator": r["generator"],
                    },
                    warnings=[
                        w for w in [
                            "❓ Wheelchair accessibility UNRECORDED" if r["wheelchair"] == "UNRECORDED" else None,
                            "❓ Generator status UNRECORDED" if r["generator"] == "UNRECORDED" else None,
                        ] if w
                    ],
                )
            )
        if r.get("site_in_flood_hazard"):
            flood_options.append(
                ActionOption(
                    option_id=f"flood_review_{r['shelter_id']}",
                    label=f"Review flood elevation for {r['shelter_name']}",
                    description=(
                        f"Address: {r.get('address')}, {r.get('city')} · "
                        f"Capacity: {r.get('capacity') if r.get('capacity') is not None else 'UNRECORDED'} · "
                        f"Surge flag: {r['surge_flag']}"
                    ),
                    recommended=(len(flood_options) == 0),
                    location=loc,
                    metrics={
                        "shelter_id": int(r["shelter_id"]),
                        "capacity": r.get("capacity"),
                        "surge_flag": r["surge_flag"],
                    },
                    warnings=["🌊 Site sits on flood-hazard ground or surge zone"],
                )
            )

    actions: list[RecommendedAction] = []
    if unrecorded_options:
        first_loc = unrecorded_options[0].location or LocationInfo(county=name, county_fips=fips, label=f"{name} County Shelters")
        actions.append(
            RecommendedAction(
                action_id=f"find_shelters_audit_unrecorded_{fips}",
                action_type=ActionType.AUDIT_UNASSESSED_NEARBY_SHELTERS,
                interaction_mode=InteractionMode.SELECT_BETWEEN_OPTIONS,
                severity=ActionSeverity.MEDIUM,
                title=f"Select {name} County shelters with UNRECORDED accessibility/generator for operator interview",
                summary=(
                    f"{int(counts.get('wheelchair_unrecorded') or 0)} of {int(counts.get('shelters') or 0)} matching "
                    f"shelters have UNRECORDED wheelchair access and {int(counts.get('generator_unrecorded') or 0)} "
                    f"have UNRECORDED generator status."
                ),
                rationale=(
                    "UNRECORDED means nobody wrote it down in the FEMA registry; selecting a shelter initiates "
                    "an operator interview to record wheelchair_unaccompanied, step_free_entrance, accessible_restroom, and generator."
                ),
                source_agent="evacuation_readiness_coordinator",
                source_tool="find_shelters",
                location=first_loc,
                attention_items=[
                    AttentionItem(
                        label="Wheelchair Unrecorded",
                        value=f"{int(counts.get('wheelchair_unrecorded') or 0)} / {int(counts.get('shelters') or 0)} shelters",
                        badge="❓ unrecorded",
                        is_warning=True,
                    ),
                    AttentionItem(
                        label="Generator Unrecorded",
                        value=f"{int(counts.get('generator_unrecorded') or 0)} / {int(counts.get('shelters') or 0)} shelters",
                        badge="❓ unrecorded",
                        is_warning=True,
                    ),
                ],
                requires_selection=True,
                options=unrecorded_options[:10],
                selected_option_id=unrecorded_options[0].option_id,
            )
        )

    if flood_options:
        first_flood_loc = flood_options[0].location or LocationInfo(county=name, county_fips=fips, label=f"{name} County Shelters")
        actions.append(
            RecommendedAction(
                action_id=f"find_shelters_flood_hazard_{fips}",
                action_type=ActionType.VERIFY_FLOOD_GROUND_ELEVATION,
                interaction_mode=InteractionMode.SELECT_BETWEEN_OPTIONS,
                severity=ActionSeverity.HIGH,
                title=f"Verify finished-floor elevation for {int(counts.get('on_flood_hazard_ground') or 0)} flood-exposed shelters in {name} County",
                summary=(
                    f"{int(counts.get('on_flood_hazard_ground') or 0)} matching shelters sit in a coastal flood-exposed tract "
                    f"or have surge_flag='YES'. Select shelters to verify elevation or exclude from storm-surge plans."
                ),
                rationale=(
                    "Tract-level flood exposure does not prove the building itself floods, unless surge_flag='YES'. "
                    "Emergency managers must confirm building elevation before assigning coastal evacuees."
                ),
                source_agent="evacuation_readiness_coordinator",
                source_tool="find_shelters",
                location=first_flood_loc,
                attention_items=[
                    AttentionItem(
                        label="Shelters on Flood-Hazard Ground",
                        value=f"{int(counts.get('on_flood_hazard_ground') or 0)} shelters",
                        badge="🌊 FEMA NRI / 🕰️ FEMA",
                        is_warning=True,
                    ),
                ],
                requires_selection=True,
                requires_approval=True,
                options=flood_options[:10],
                selected_option_id=flood_options[0].option_id,
                approval=ApprovalDetails(
                    confirm_label="Dispatch Elevation / Surge Review",
                    reject_label="Defer Review",
                    proposed_change=f"Verify building elevation for flood-exposed shelters in {name} County",
                    target_entity_type="county",
                    target_entity_id=fips,
                    payload={"county_fips": fips, "shelter_ids": [o.metrics.get("shelter_id") for o in flood_options[:10]]},
                ),
            )
        )

    record_actions_in_state(tool_context, actions)
    output = FindSheltersOutput(
        county=name,
        summary=counts,
        shelters=shelter_models,
        source="FEMA National Shelter System (historical registry; not operational status)",
        recommended_actions=actions,
    )
    return output.model_dump()


def county_gap_report(county: str, tool_context: Optional[ToolContext] = None) -> dict:
    """What a county should fix before the season: the gaps, counted, plus what the record
    cannot tell us.

    Args:
      county: Florida county name.

    Returns:
      dict with: evacuation-zone tracts with no shelter within walking distance; tracts with no
      recorded-accessible shelter within 25 km split into "none exists nearby" vs "nearby ones are
      unrecorded"; pre-landfall shelter capacity on flood-hazard ground; medical-needs shelters vs
      power-dependent residents; nursing homes on flood-hazard ground; and an unknowns inventory.
    """
    fips, name = resolve_county(county)
    T, S, C, P = table("tract_readiness"), table("shelters_enriched"), table("care_enriched"), table("power_dependent_counties")
    walk = _rows(f"""
        SELECT COUNT(*) tracts, SUM(total_pop) population, SUM(hh_no_vehicle) households_no_vehicle,
          ARRAY_AGG(STRUCT(geo_id, near_city, ROUND(lat, 4) AS lat, ROUND(lon, 4) AS lon,
                           hh_no_vehicle, ROUND(0.621 * km_nearest_shelter,1) AS miles_nearest_shelter)
                    ORDER BY hh_no_vehicle DESC LIMIT 8) worst
        FROM {T} WHERE county_fips=@fips AND evacuation_driver IS NOT NULL AND n_within_walk = 0""", fips=fips)[0]
    access = _rows(f"""
        SELECT
          COUNTIF(n_within_drive_wc_yes = 0) tracts_no_recorded_accessible_within_25km,
          COUNTIF(n_within_drive_wc_yes = 0 AND n_within_drive_wc_unrecorded > 0) of_those_tracts_with_unassessed_shelters_within_25km,
          SUM(IF(n_within_drive_wc_yes = 0, total_pop, 0)) population_affected,
          ROUND(0.621 * APPROX_QUANTILES(km_nearest_shelter, 2)[OFFSET(1)], 1) median_miles_any_shelter,
          ROUND(0.621 * APPROX_QUANTILES(km_nearest_recorded_accessible, 2)[OFFSET(1)], 1) median_miles_recorded_accessible
        FROM {T} WHERE county_fips=@fips""", fips=fips)[0]
    flood = _rows(f"""
        SELECT COUNTIF(pre_landfall) pre_landfall_shelters,
          COUNTIF(pre_landfall AND site_in_flood_hazard) on_flood_hazard_ground,
          SUM(IF(pre_landfall, evacuation_capacity, 0)) pre_landfall_capacity,
          SUM(IF(pre_landfall AND site_in_flood_hazard, evacuation_capacity, 0)) capacity_on_flood_hazard_ground,
          COUNTIF(pre_landfall AND surge_flag='YES') recorded_in_surge_zone,
          COUNTIF(pre_landfall AND surge_flag='UNRECORDED') surge_flag_unrecorded,
          ARRAY_AGG(IF(pre_landfall AND site_in_flood_hazard,
                       STRUCT(shelter_id, shelter_name, address, city,
                              ROUND(latitude, 5) AS latitude, ROUND(longitude, 5) AS longitude,
                              evacuation_capacity AS capacity, surge_flag,
                              ROUND(100*site_coastal_flood_share) AS pct_tract_flood_exposed), NULL)
                    IGNORE NULLS ORDER BY evacuation_capacity DESC LIMIT 8) largest
        FROM {S} WHERE county_fips=@fips""", fips=fips)[0]
    medical = _rows(f"""
        SELECT (SELECT COUNTIF(is_medical) FROM {S} WHERE county_fips=@fips) medical_needs_shelters,
          (SELECT SUM(IF(is_medical, evacuation_capacity, 0)) FROM {S} WHERE county_fips=@fips) medical_needs_capacity,
          (SELECT COUNTIF(is_medical AND generator='YES') FROM {S} WHERE county_fips=@fips) medical_with_recorded_generator,
          (SELECT COUNTIF(is_medical AND generator='UNRECORDED') FROM {S} WHERE county_fips=@fips) medical_generator_unrecorded,
          (SELECT MAX(power_dependent_dme) FROM {P} WHERE fips_code=@fips) power_dependent_residents,
          (SELECT MAX(o2_services_any_dme) FROM {P} WHERE fips_code=@fips) oxygen_service_users_with_power_dependent_equipment,
          (SELECT MAX(facility_esrd_dialysis_any_dme) FROM {P} WHERE fips_code=@fips) facility_dialysis_patients_with_power_dependent_equipment,
          (SELECT LOGICAL_OR(power_dependent_is_censored) FROM {P} WHERE fips_code=@fips) power_count_censored""",
        fips=fips)[0]
    care = _rows(f"""
        SELECT COUNT(*) nursing_homes, SUM(beds) beds,
          COUNTIF(site_coastal_flood_exposed) on_flood_hazard_ground,
          SUM(IF(site_coastal_flood_exposed, beds, 0)) beds_on_flood_hazard_ground,
          ARRAY_AGG(IF(site_coastal_flood_exposed,
                    STRUCT(ccn, provider_name, provider_address, citytown,
                           ROUND(latitude, 5) AS latitude, ROUND(longitude, 5) AS longitude,
                           beds, ROUND(0.621 * km_nearest_medical_shelter,1) AS miles_nearest_medical_shelter), NULL)
                    IGNORE NULLS ORDER BY beds DESC LIMIT 6) largest
        FROM {C} WHERE county_fips=@fips""", fips=fips)[0]
    unknown = _rows(f"""
        SELECT COUNT(*) shelters, COUNTIF(wheelchair='UNRECORDED') wheelchair_unrecorded,
          COUNTIF(generator='UNRECORDED') generator_unrecorded, COUNTIF(surge_flag='UNRECORDED') surge_unrecorded,
          COUNTIF(evacuation_capacity IS NULL) capacity_unrecorded, COUNTIF(usage_unknown) usage_unrecorded,
          COUNTIF(UPPER(REGEXP_REPLACE(REPLACE(UPPER(fema_county_text),'SAINT','ST.'), r'[^A-Z.]', ''))
                  != UPPER(REGEXP_REPLACE(county_name, r'[^A-Za-z.]', ''))) fema_county_disagrees_with_coordinates
        FROM {S} WHERE county_fips=@fips""", fips=fips)[0]

    actions: list[RecommendedAction] = []

    # 1. Walkable shelter & transit gap action (with selectable worst tracts)
    worst_walk = walk.get("worst") or []
    if (walk.get("tracts") or 0) > 0 and worst_walk:
        walk_options: list[ActionOption] = []
        for idx, w in enumerate(worst_walk):
            w_loc = LocationInfo(
                lat=w.get("lat"),
                lon=w.get("lon"),
                label=f"Tract {w['geo_id']} (near {w.get('near_city') or name})",
                city=w.get("near_city"),
                county=name,
                county_fips=fips,
                geo_id=w["geo_id"],
            )
            w["location"] = w_loc.model_dump()
            walk_options.append(
                ActionOption(
                    option_id=f"transit_pickup_{w['geo_id']}",
                    label=f"Tract {w['geo_id']} ({w.get('near_city') or name}) — {int(w.get('hh_no_vehicle') or 0)} no-car HH",
                    description=(
                        f"0 shelters within 1 mi · Nearest shelter is {w.get('miles_nearest_shelter')} mi away · "
                        f"{int(w.get('hh_no_vehicle') or 0)} households without a vehicle"
                    ),
                    recommended=(idx == 0),
                    location=w_loc,
                    metrics={
                        "geo_id": w["geo_id"],
                        "hh_no_vehicle": int(w.get("hh_no_vehicle") or 0),
                        "miles_nearest_shelter": w.get("miles_nearest_shelter"),
                    },
                    warnings=[f"No walkable shelter within 1 mile ({w.get('miles_nearest_shelter')} mi to nearest)"],
                )
            )
        primary_walk_loc = walk_options[0].location or LocationInfo(county=name, county_fips=fips, label=f"{name} County")
        actions.append(
            RecommendedAction(
                action_id=f"gap_transit_pickup_{fips}",
                action_type=ActionType.DESIGNATE_BUS_PICKUP_POINT,
                interaction_mode=InteractionMode.SELECT_BETWEEN_OPTIONS,
                severity=ActionSeverity.CRITICAL if (walk.get("households_no_vehicle") or 0) >= 500 else ActionSeverity.HIGH,
                title=f"Pre-arrange transit pickup for {int(walk.get('tracts') or 0)} evacuation-zone tracts in {name} County with 0 walkable shelters",
                summary=(
                    f"{int(walk.get('tracts') or 0)} evacuation-zone tracts ({int(walk.get('households_no_vehicle') or 0):,} "
                    f"no-vehicle households; {int(walk.get('population') or 0):,} residents) have zero pre-landfall shelters within 1 mile."
                ),
                rationale=(
                    "Households without a vehicle in evacuation-zone tracts with no shelter within walking distance (1 mile) "
                    "cannot self-evacuate without designated bus pickup points."
                ),
                source_agent="evacuation_readiness_coordinator",
                source_tool="county_gap_report",
                location=primary_walk_loc,
                attention_items=[
                    AttentionItem(
                        label="Zero-Walk-Shelter Evac Tracts",
                        value=f"{int(walk.get('tracts') or 0)} tracts",
                        badge="📊 ACS / 🕰️ FEMA",
                        is_warning=True,
                    ),
                    AttentionItem(
                        label="No-Vehicle Households Affected",
                        value=f"{int(walk.get('households_no_vehicle') or 0):,} households",
                        badge="📊 ACS",
                        is_warning=True,
                    ),
                ],
                requires_selection=True,
                requires_approval=True,
                options=walk_options,
                selected_option_id=walk_options[0].option_id,
                approval=ApprovalDetails(
                    confirm_label="Approve Transit Pickup Staging",
                    reject_label="Defer Transit Staging",
                    proposed_change=f"Stage bus pickup routes for zero-walkable-shelter tracts in {name} County",
                    target_entity_type="county",
                    target_entity_id=fips,
                    payload={
                        "county_fips": fips,
                        "tracts_affected": int(walk.get("tracts") or 0),
                        "households_no_vehicle": int(walk.get("households_no_vehicle") or 0),
                    },
                    irreversible_or_high_impact=True,
                ),
            )
        )

    # 2. Unrecorded accessible shelters audit action
    no_acc_tracts = int(access.get("tracts_no_recorded_accessible_within_25km") or 0)
    unassessed_tracts = int(access.get("of_those_tracts_with_unassessed_shelters_within_25km") or 0)
    if no_acc_tracts > 0 or int(unknown.get("wheelchair_unrecorded") or 0) > 0:
        actions.append(
            RecommendedAction(
                action_id=f"gap_accessibility_audit_{fips}",
                action_type=ActionType.AUDIT_UNASSESSED_NEARBY_SHELTERS,
                interaction_mode=InteractionMode.APPROVAL_REQUIRED,
                severity=ActionSeverity.HIGH if no_acc_tracts > 0 else ActionSeverity.MEDIUM,
                title=f"Audit {int(unknown.get('wheelchair_unrecorded') or 0)} shelters with UNRECORDED wheelchair accessibility in {name} County",
                summary=(
                    f"{no_acc_tracts} tracts ({int(access.get('population_affected') or 0):,} residents) have no "
                    f"recorded-accessible shelter within 25 km — but {unassessed_tracts} of those tracts have nearby "
                    f"shelters whose wheelchair access is simply UNRECORDED."
                ),
                rationale=(
                    "Closing the paperwork gap by interviewing operators of unrecorded shelters can resolve apparent "
                    "accessibility deserts without building new facilities."
                ),
                source_agent="evacuation_readiness_coordinator",
                source_tool="county_gap_report",
                location=LocationInfo(county=name, county_fips=fips, label=f"{name} County Accessibility Audit"),
                attention_items=[
                    AttentionItem(
                        label="Tracts w/o Recorded Accessible Shelter (25km)",
                        value=f"{no_acc_tracts} tracts ({unassessed_tracts} have unassessed nearby shelters)",
                        badge="❓ unrecorded",
                        is_warning=True,
                    ),
                    AttentionItem(
                        label="County Shelters Wheelchair UNRECORDED",
                        value=f"{int(unknown.get('wheelchair_unrecorded') or 0)} / {int(unknown.get('shelters') or 0)} shelters",
                        badge="❓ unrecorded",
                        is_warning=True,
                    ),
                    AttentionItem(
                        label="Median Distance (Any vs Recorded Accessible)",
                        value=f"{access.get('median_miles_any_shelter')} mi vs {access.get('median_miles_recorded_accessible')} mi",
                        badge="🕰️ FEMA",
                        is_warning=(access.get("median_miles_recorded_accessible") or 0) > (access.get("median_miles_any_shelter") or 0) * 1.5,
                    ),
                ],
                requires_approval=True,
                approval=ApprovalDetails(
                    confirm_label="Approve County Accessibility Audit",
                    reject_label="Dismiss",
                    proposed_change=f"Launch operator accessibility questionnaire for {int(unknown.get('wheelchair_unrecorded') or 0)} unrecorded shelters in {name} County",
                    target_entity_type="county",
                    target_entity_id=fips,
                    payload={
                        "county_fips": fips,
                        "wheelchair_unrecorded": int(unknown.get("wheelchair_unrecorded") or 0),
                        "tracts_no_recorded_accessible_within_25km": no_acc_tracts,
                    },
                ),
            )
        )

    # 3. Pre-landfall shelters on flood-hazard ground
    largest_flood = flood.get("largest") or []
    if (flood.get("on_flood_hazard_ground") or 0) > 0 and largest_flood:
        flood_opts: list[ActionOption] = []
        for idx, fs in enumerate(largest_flood):
            f_loc = LocationInfo(
                lat=fs.get("latitude"),
                lon=fs.get("longitude"),
                label=fs["shelter_name"],
                address=fs.get("address"),
                city=fs.get("city"),
                county=name,
                county_fips=fips,
                shelter_id=int(fs["shelter_id"]),
            )
            fs["location"] = f_loc.model_dump()
            flood_opts.append(
                ActionOption(
                    option_id=f"flood_shelter_{fs['shelter_id']}",
                    label=f"{fs['shelter_name']} ({fs.get('city') or name}) — Cap: {fs.get('capacity') or 'UNRECORDED'}",
                    description=(
                        f"Surge flag: {fs.get('surge_flag')} · Surrounding tract coastal flood exposure: "
                        f"{fs.get('pct_tract_flood_exposed')}% · Capacity: {fs.get('capacity') or 'UNRECORDED'}"
                    ),
                    recommended=(idx == 0),
                    location=f_loc,
                    metrics={
                        "shelter_id": int(fs["shelter_id"]),
                        "capacity": fs.get("capacity"),
                        "surge_flag": fs.get("surge_flag"),
                        "pct_tract_flood_exposed": fs.get("pct_tract_flood_exposed"),
                    },
                    warnings=[
                        f"Surge flag={fs.get('surge_flag')}, tract flood exposure={fs.get('pct_tract_flood_exposed')}%"
                    ],
                )
            )
        actions.append(
            RecommendedAction(
                action_id=f"gap_flood_shelters_{fips}",
                action_type=ActionType.VERIFY_FLOOD_GROUND_ELEVATION,
                interaction_mode=InteractionMode.SELECT_BETWEEN_OPTIONS,
                severity=ActionSeverity.CRITICAL if (flood.get("recorded_in_surge_zone") or 0) > 0 else ActionSeverity.HIGH,
                title=f"Review {int(flood.get('on_flood_hazard_ground') or 0)} pre-landfall shelters on flood-hazard ground in {name} County",
                summary=(
                    f"{int(flood.get('on_flood_hazard_ground') or 0)} of {int(flood.get('pre_landfall_shelters') or 0)} "
                    f"pre-landfall shelters ({int(flood.get('capacity_on_flood_hazard_ground') or 0):,} spaces) sit on "
                    f"flood-hazard ground ({int(flood.get('recorded_in_surge_zone') or 0)} recorded in surge zone)."
                ),
                rationale=(
                    "Shelters with surge_flag='YES' must be excluded from storm-surge plans; shelters in flood-exposed "
                    "tracts require building elevation confirmation and surge_flag verification."
                ),
                source_agent="evacuation_readiness_coordinator",
                source_tool="county_gap_report",
                location=flood_opts[0].location or LocationInfo(county=name, county_fips=fips, label=f"{name} County"),
                attention_items=[
                    AttentionItem(
                        label="Pre-Landfall Capacity on Flood Ground",
                        value=f"{int(flood.get('capacity_on_flood_hazard_ground') or 0):,} / {int(flood.get('pre_landfall_capacity') or 0):,} spaces",
                        badge="🌊 FEMA NRI / 🕰️ FEMA",
                        is_warning=True,
                    ),
                    AttentionItem(
                        label="Surge Flag Status",
                        value=f"{int(flood.get('recorded_in_surge_zone') or 0)} YES · {int(flood.get('surge_flag_unrecorded') or 0)} UNRECORDED",
                        badge="🕰️ FEMA / ❓ unrecorded",
                        is_warning=True,
                    ),
                ],
                requires_selection=True,
                requires_approval=True,
                options=flood_opts,
                selected_option_id=flood_opts[0].option_id,
                approval=ApprovalDetails(
                    confirm_label="Approve Flood / Surge Audit",
                    reject_label="Defer",
                    proposed_change=f"Audit elevation and surge zone status for {int(flood.get('on_flood_hazard_ground') or 0)} shelters in {name} County",
                    target_entity_type="county",
                    target_entity_id=fips,
                    payload={"county_fips": fips, "on_flood_hazard_ground": int(flood.get("on_flood_hazard_ground") or 0)},
                    irreversible_or_high_impact=True,
                ),
            )
        )

    # 4. Medical-needs shelters vs power-dependent Medicare beneficiaries (HHS emPOWER)
    pwr_res = int(medical.get("power_dependent_residents") or 0)
    med_cap = int(medical.get("medical_needs_capacity") or 0)
    med_gen_unrec = int(medical.get("medical_generator_unrecorded") or 0)
    if pwr_res > med_cap or med_gen_unrec > 0:
        actions.append(
            RecommendedAction(
                action_id=f"gap_medical_power_{fips}",
                action_type=ActionType.VERIFY_MEDICAL_SHELTER_GENERATORS,
                interaction_mode=InteractionMode.APPROVAL_REQUIRED,
                severity=ActionSeverity.CRITICAL if pwr_res > med_cap else ActionSeverity.HIGH,
                title=f"Address medical-needs shelter & generator gap for {pwr_res:,} power-dependent residents in {name} County",
                summary=(
                    f"{name} County has {pwr_res:,} Medicare beneficiaries with power-dependent equipment "
                    f"(including {int(medical.get('oxygen_service_users_with_power_dependent_equipment') or 0):,} O2 users "
                    f"and {int(medical.get('facility_dialysis_patients_with_power_dependent_equipment') or 0):,} facility "
                    f"dialysis patients), vs {med_cap:,} recorded medical-needs shelter spaces across "
                    f"{int(medical.get('medical_needs_shelters') or 0)} medical shelters ({med_gen_unrec} with UNRECORDED generator)."
                ),
                rationale=(
                    "Power-dependent DME users require backup generators and medical-needs shelter capacity; "
                    "facility dialysis patients also require post-landfall clinic power restoration."
                ),
                source_agent="evacuation_readiness_coordinator",
                source_tool="county_gap_report",
                location=LocationInfo(county=name, county_fips=fips, label=f"{name} County Medical Shelters"),
                attention_items=[
                    AttentionItem(
                        label="Power-Dependent Residents (HHS emPOWER)",
                        value=f"{pwr_res:,} residents (county-level only)",
                        badge="⚡ HHS emPOWER",
                        is_warning=pwr_res > med_cap,
                    ),
                    AttentionItem(
                        label="Medical-Needs Shelter Capacity",
                        value=f"{med_cap:,} spaces across {int(medical.get('medical_needs_shelters') or 0)} shelters",
                        badge="🕰️ FEMA",
                        is_warning=pwr_res > med_cap,
                    ),
                    AttentionItem(
                        label="Medical Shelter Generators",
                        value=f"{int(medical.get('medical_with_recorded_generator') or 0)} YES · {med_gen_unrec} UNRECORDED",
                        badge="❓ unrecorded",
                        is_warning=med_gen_unrec > 0,
                    ),
                ],
                requires_approval=True,
                approval=ApprovalDetails(
                    confirm_label="Approve Generator Verification & DME Contingency",
                    reject_label="Defer",
                    proposed_change=f"Verify generators at {med_gen_unrec} medical shelters and expand medical-needs capacity in {name} County",
                    target_entity_type="county",
                    target_entity_id=fips,
                    payload={
                        "county_fips": fips,
                        "power_dependent_residents": pwr_res,
                        "medical_needs_capacity": med_cap,
                        "medical_generator_unrecorded": med_gen_unrec,
                    },
                    irreversible_or_high_impact=True,
                ),
            )
        )

    # 5. Nursing homes on flood-hazard ground
    largest_care = care.get("largest") or []
    if (care.get("on_flood_hazard_ground") or 0) > 0 and largest_care:
        care_opts: list[ActionOption] = []
        for idx, nh in enumerate(largest_care):
            c_loc = LocationInfo(
                lat=nh.get("latitude"),
                lon=nh.get("longitude"),
                label=nh["provider_name"],
                address=nh.get("provider_address"),
                city=nh.get("citytown"),
                county=name,
                county_fips=fips,
                facility_id=str(nh.get("ccn") or ""),
            )
            nh["location"] = c_loc.model_dump()
            care_opts.append(
                ActionOption(
                    option_id=f"nursing_home_{nh.get('ccn') or idx}",
                    label=f"{nh['provider_name']} ({nh.get('citytown') or name}) — {int(nh.get('beds') or 0)} beds",
                    description=(
                        f"{int(nh.get('beds') or 0)} licensed beds on flood-hazard ground · "
                        f"Nearest medical shelter: {nh.get('miles_nearest_medical_shelter')} mi"
                    ),
                    recommended=(idx == 0),
                    location=c_loc,
                    metrics={
                        "ccn": nh.get("ccn"),
                        "beds": int(nh.get("beds") or 0),
                        "miles_nearest_medical_shelter": nh.get("miles_nearest_medical_shelter"),
                    },
                    warnings=[f"On coastal flood-exposed ground; nearest medical shelter is {nh.get('miles_nearest_medical_shelter')} mi away"],
                )
            )
        actions.append(
            RecommendedAction(
                action_id=f"gap_nursing_homes_flood_{fips}",
                action_type=ActionType.PLAN_NURSING_HOME_EVACUATION,
                interaction_mode=InteractionMode.SELECT_BETWEEN_OPTIONS,
                severity=ActionSeverity.CRITICAL,
                title=f"Pre-plan ambulance/medical transport for {int(care.get('on_flood_hazard_ground') or 0)} flood-exposed nursing homes ({int(care.get('beds_on_flood_hazard_ground') or 0):,} beds) in {name} County",
                summary=(
                    f"{int(care.get('on_flood_hazard_ground') or 0)} of {int(care.get('nursing_homes') or 0)} "
                    f"nursing homes ({int(care.get('beds_on_flood_hazard_ground') or 0):,} of {int(care.get('beds') or 0):,} beds) "
                    f"sit in coastal flood-exposed tracts."
                ),
                rationale=(
                    "Skilled nursing facilities on flood-hazard ground require specialized medical evacuation contracts "
                    "and receiving-facility agreements before hurricane watch."
                ),
                source_agent="evacuation_readiness_coordinator",
                source_tool="county_gap_report",
                location=care_opts[0].location or LocationInfo(county=name, county_fips=fips, label=f"{name} County Nursing Homes"),
                attention_items=[
                    AttentionItem(
                        label="Flood-Exposed Nursing Homes",
                        value=f"{int(care.get('on_flood_hazard_ground') or 0)} facilities ({int(care.get('beds_on_flood_hazard_ground') or 0):,} beds)",
                        badge="🏥 CMS / 🌊 FEMA NRI",
                        is_warning=True,
                    ),
                ],
                requires_selection=True,
                requires_approval=True,
                options=care_opts,
                selected_option_id=care_opts[0].option_id,
                approval=ApprovalDetails(
                    confirm_label="Approve Facility Evacuation Review",
                    reject_label="Defer",
                    proposed_change=f"Verify mutual-aid evacuation plans for {int(care.get('on_flood_hazard_ground') or 0)} flood-exposed nursing homes in {name} County",
                    target_entity_type="county",
                    target_entity_id=fips,
                    payload={
                        "county_fips": fips,
                        "nursing_homes_on_flood_ground": int(care.get("on_flood_hazard_ground") or 0),
                        "beds_on_flood_ground": int(care.get("beds_on_flood_hazard_ground") or 0),
                    },
                    irreversible_or_high_impact=True,
                ),
            )
        )

    record_actions_in_state(tool_context, actions)
    output = CountyGapReportOutput(
        county=name,
        county_fips=fips,
        evacuation_zone_tracts_with_no_shelter_within_1_mile=walk,
        accessible_shelter_access=access,
        shelters_on_flood_hazard_ground=flood,
        medical_and_power_dependence=medical,
        nursing_homes=care,
        what_the_record_cannot_tell_us=unknown,
        caveats=[
            "Flood-hazard ground = recorded surge flag YES, or >=25% of the surrounding tract's population "
            "exposed to coastal flooding (FEMA NRI). Tract-level, not the building's own elevation.",
            "Power dependence (HHS emPOWER) is county-level only: how many, never which block. The dialysis "
            "figure counts end-stage kidney disease patients dialysing at a FACILITY who also use power-dependent "
            "equipment at home (not home dialysis); facility dialysis needs the clinic open after landfall.",
            "A tract with 'no recorded-accessible shelter' may have accessible shelters nobody assessed.",
        ],
        recommended_actions=actions,
    )
    return output.model_dump()


def equity_audit(county: str, top_n: int = 20, tool_context: Optional[ToolContext] = None) -> dict:
    """Audits the agent's own ranking after the fact. Race/ethnicity is NOT a ranking input;
    this joins the top-ranked tracts to ACS 2020 race/ethnicity and compares them with the
    county, and checks whether the ranking follows need or paperwork (recording rates).

    Args:
      county: Florida county name.
      top_n: size of the priority list to audit.

    Returns:
      dict comparing priority tracts vs the county on race/ethnicity shares, poverty, and the
      share of nearby shelters whose wheelchair access was recorded at all.
    """
    fips, name = resolve_county(county)
    n_clamped = max(5, min(int(top_n), 60))
    rows = _rows(f"""
        WITH r AS (
          SELECT geo_id, total_pop, households, hh_no_vehicle, pop_65_plus, priority_score,
            ROW_NUMBER() OVER (ORDER BY priority_score DESC) rk,
            SAFE_DIVIDE(n_within_drive - n_within_drive_wc_unrecorded, n_within_drive) recorded_share
          FROM {table('tract_readiness')} WHERE county_fips=@fips
        ),
        j AS (
          SELECT r.*, a.white_pop, a.black_pop, a.hispanic_pop, a.asian_pop, a.total_pop AS acs_pop,
            v.poverty_rate, v.median_income
          FROM r
          JOIN `bigquery-public-data.census_bureau_acs.censustract_2020_5yr` a USING (geo_id)
          JOIN {table('vulnerability_tracts')} v USING (geo_id)
        )
        SELECT IF(rk <= @n, 'priority_tracts', 'rest_of_county') grp, COUNT(*) tracts,
          ROUND(100*SUM(white_pop)/SUM(acs_pop),1) pct_white_non_hispanic,
          ROUND(100*SUM(black_pop)/SUM(acs_pop),1) pct_black_non_hispanic,
          ROUND(100*SUM(hispanic_pop)/SUM(acs_pop),1) pct_hispanic,
          ROUND(100*SUM(asian_pop)/SUM(acs_pop),1) pct_asian,
          ROUND(100*AVG(poverty_rate),1) avg_pct_poverty,
          ROUND(100*SUM(hh_no_vehicle)/SUM(households),1) pct_households_no_vehicle,
          ROUND(100*SUM(pop_65_plus)/SUM(total_pop),1) pct_65_plus,
          ROUND(APPROX_QUANTILES(IF(median_income > 0, median_income, NULL), 2)[OFFSET(1)]) median_income_excl_sentinel,
          ROUND(100*AVG(recorded_share),1) pct_nearby_shelters_with_wheelchair_recorded
        FROM j GROUP BY grp ORDER BY grp""", fips=fips, n=n_clamped)

    group_models = [EquityAuditGroup(**r) for r in rows]
    by_grp = {g.grp: g for g in group_models}
    pri = by_grp.get("priority_tracts")
    rest = by_grp.get("rest_of_county")

    actions: list[RecommendedAction] = []
    if pri and rest:
        pri_rec = pri.pct_nearby_shelters_with_wheelchair_recorded or 0.0
        rest_rec = rest.pct_nearby_shelters_with_wheelchair_recorded or 0.0
        paperwork_skew = abs(pri_rec - rest_rec) >= 5.0 or pri_rec < 50.0
        actions.append(
            RecommendedAction(
                action_id=f"equity_audit_review_{fips}_top{n_clamped}",
                action_type=ActionType.AUDIT_UNASSESSED_NEARBY_SHELTERS if paperwork_skew else ActionType.ADJUST_PRIORITY_WEIGHTS,
                interaction_mode=InteractionMode.SELECT_BETWEEN_OPTIONS,
                severity=ActionSeverity.HIGH if paperwork_skew else ActionSeverity.LOW,
                title=f"Review equity & recording-rate audit for top {n_clamped} priority tracts in {name} County",
                summary=(
                    f"Priority tracts vs rest of {name} County: No-vehicle HH {pri.pct_households_no_vehicle}% vs "
                    f"{rest.pct_households_no_vehicle}%, Poverty {pri.avg_pct_poverty}% vs {rest.avg_pct_poverty}%, "
                    f"Nearby shelter wheelchair recording rate {pri_rec}% vs {rest_rec}%."
                ),
                rationale=(
                    "If priority tracts differ sharply in shelter recording rate, apparent accessibility gaps may "
                    "reflect missing paperwork rather than fewer buildings. Planners can choose to audit unrecorded "
                    "shelters in priority tracts or adjust priority weights."
                ),
                source_agent="prioritization_agent",
                source_tool="equity_audit",
                location=LocationInfo(county=name, county_fips=fips, label=f"{name} County Equity Audit"),
                attention_items=[
                    AttentionItem(
                        label="Wheelchair Recording Rate (Priority vs Rest)",
                        value=f"{pri_rec}% vs {rest_rec}%",
                        badge="❓ unrecorded / 🕰️ FEMA",
                        is_warning=paperwork_skew,
                    ),
                    AttentionItem(
                        label="Poverty Rate (Priority vs Rest)",
                        value=f"{pri.avg_pct_poverty}% vs {rest.avg_pct_poverty}%",
                        badge="📊 ACS",
                        is_warning=False,
                    ),
                    AttentionItem(
                        label="Demographics (Priority Tracts)",
                        value=(
                            f"Black {pri.pct_black_non_hispanic}%, Hispanic {pri.pct_hispanic}%, "
                            f"White {pri.pct_white_non_hispanic}%, Asian {pri.pct_asian}%"
                        ),
                        badge="📊 ACS 2020",
                        is_warning=False,
                    ),
                ],
                requires_selection=True,
                options=[
                    ActionOption(
                        option_id="audit_priority_tract_shelters",
                        label=f"Prioritize operator accessibility audits near top {n_clamped} tracts",
                        description=f"Close the {round(100 - pri_rec, 1)}% unrecorded wheelchair gap around priority tracts",
                        recommended=paperwork_skew,
                        location=LocationInfo(county=name, county_fips=fips, label=f"{name} County Priority Tracts"),
                        metrics={"priority_recording_pct": pri_rec, "rest_recording_pct": rest_rec},
                    ),
                    ActionOption(
                        option_id="retain_current_ranking",
                        label="Accept equity audit and retain current priority ranking",
                        description="Confirm ranking reflects physical evacuation need (no-vehicle households, mobility, age 65+, mobile homes)",
                        recommended=not paperwork_skew,
                        location=LocationInfo(county=name, county_fips=fips, label=f"{name} County"),
                        metrics={"top_n": n_clamped},
                    ),
                ],
                selected_option_id="audit_priority_tract_shelters" if paperwork_skew else "retain_current_ranking",
            )
        )

    record_actions_in_state(tool_context, actions)
    output = EquityAuditOutput(
        county=name,
        groups=group_models,
        how_to_read="If priority tracts differ sharply in recording rate, the ranking may follow paperwork. "
                    "Race shares are reported, not used as inputs; a difference is a finding to state, not hide.",
        notes="ACS 2020 5-yr (bigquery-public-data). median_income excludes the -666666666 ACS sentinel.",
        recommended_actions=actions,
    )
    return output.model_dump()


def record_shelter_assessment(shelter_id: int, wheelchair_unaccompanied: str, step_free_entrance: str,
                              accessible_restroom: str, generator: str, notes: str = "",
                              tool_context: Optional[ToolContext] = None) -> dict:
    """Saves an accessibility assessment reported by a shelter operator, closing an UNRECORDED gap.

    Only call this with answers the operator actually gave. Each answer must be "yes", "no" or
    "unknown".

    Args:
      shelter_id: FEMA shelter_id.
      wheelchair_unaccompanied: can a wheelchair user get in and use the shelter without help, today?
      step_free_entrance: is there a step-free entrance open whenever the shelter is open?
      accessible_restroom: is there an accessible restroom?
      generator: is there an on-site generator?
      notes: operator's own words on conditions (e.g. "ramp chained outside school hours").

    Returns:
      confirmation dict.
    """
    vals = {k: v.strip().lower() for k, v in dict(wheelchair_unaccompanied=wheelchair_unaccompanied,
            step_free_entrance=step_free_entrance, accessible_restroom=accessible_restroom,
            generator=generator).items()}
    bad = {k: v for k, v in vals.items() if v not in ("yes", "no", "unknown")}
    if bad:
        return {"error": f"answers must be yes/no/unknown: {bad}"}

    shelter_meta = _rows(f"""
        SELECT shelter_id, shelter_name, address, city, county_name, county_fips,
               ROUND(latitude, 5) latitude, ROUND(longitude, 5) longitude
        FROM {table('shelters_enriched')} WHERE shelter_id = @sid LIMIT 1""", sid=int(shelter_id))
    meta = shelter_meta[0] if shelter_meta else {}
    loc = LocationInfo(
        lat=meta.get("latitude"),
        lon=meta.get("longitude"),
        label=meta.get("shelter_name") or f"Shelter #{shelter_id}",
        address=meta.get("address"),
        city=meta.get("city"),
        county=meta.get("county_name"),
        county_fips=meta.get("county_fips"),
        shelter_id=int(shelter_id),
    )

    row_dict = {
        "shelter_id": int(shelter_id),
        "assessed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        **vals,
        "notes": notes[:2000],
        "source": "operator assessment via agent",
    }
    errors = _bq().insert_rows_json(f"{PROJECT}.evacuation_readiness.shelter_assessments", [row_dict])
    saved = not errors

    has_barrier = any(vals[k] == "no" for k in ("wheelchair_unaccompanied", "step_free_entrance", "accessible_restroom", "generator"))
    actions = [
        RecommendedAction(
            action_id=f"record_assessment_{shelter_id}",
            action_type=ActionType.APPROVE_SHELTER_ASSESSMENT_WRITEBACK,
            interaction_mode=InteractionMode.APPROVAL_REQUIRED if has_barrier else InteractionMode.INFO_ATTENTION,
            severity=ActionSeverity.HIGH if has_barrier else ActionSeverity.LOW,
            title=(
                f"Operator assessment recorded for {loc.label} — review physical barrier remediation"
                if has_barrier else f"Operator assessment saved for {loc.label}"
            ),
            summary=(
                f"Unaccompanied wheelchair={vals['wheelchair_unaccompanied'].upper()}, "
                f"Step-free entrance={vals['step_free_entrance'].upper()}, "
                f"Accessible restroom={vals['accessible_restroom'].upper()}, "
                f"Generator={vals['generator'].upper()}."
                + (f" Operator note: {notes[:200]}" if notes else "")
            ),
            rationale=(
                "Operator answers have been written to BigQuery `shelter_assessments`. "
                + ("One or more accessibility/generator barriers were reported as 'no' and need remediation or plan adjustment."
                   if has_barrier else "This closes an UNRECORDED gap in the shelter registry.")
            ),
            source_agent="verification_agent",
            source_tool="record_shelter_assessment",
            location=loc,
            attention_items=[
                AttentionItem(
                    label="Wheelchair Unaccompanied",
                    value=vals["wheelchair_unaccompanied"].upper(),
                    badge="📋 Operator Assessment",
                    is_warning=(vals["wheelchair_unaccompanied"] != "yes"),
                ),
                AttentionItem(
                    label="Step-Free Entrance / Restroom",
                    value=f"Entrance: {vals['step_free_entrance'].upper()} · Restroom: {vals['accessible_restroom'].upper()}",
                    badge="📋 Operator Assessment",
                    is_warning=(vals["step_free_entrance"] != "yes" or vals["accessible_restroom"] != "yes"),
                ),
                AttentionItem(
                    label="On-Site Generator",
                    value=vals["generator"].upper(),
                    badge="📋 Operator Assessment",
                    is_warning=(vals["generator"] != "yes"),
                ),
            ],
            requires_approval=has_barrier,
            approval=ApprovalDetails(
                confirm_label="Flag Shelter Barrier in Plan",
                reject_label="Acknowledge Only",
                proposed_change=f"Update operational accessibility status for {loc.label} (shelter_id={shelter_id})",
                target_entity_type="shelter",
                target_entity_id=str(shelter_id),
                payload=row_dict,
            ) if has_barrier else None,
        )
    ]
    record_actions_in_state(tool_context, actions)
    output = RecordShelterAssessmentOutput(
        saved=saved,
        errors=list(errors),
        record=ShelterAssessmentRecord(**row_dict),
        location=loc,
        recommended_actions=actions,
    )
    return output.model_dump()
