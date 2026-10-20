"""Q3 tools: how sure can we be? Counts what the record never captured, finds records that contradict
themselves, and says how old each kind of fact is."""
from __future__ import annotations

from .config import LBL, table
from .data import _rows, resolve_county


def data_quality_report(county: str = "") -> dict:
    """Audits the shelter record for one Florida county (or all of Florida if county is ""): what is
    unrecorded, what contradicts itself, and what looks stale. Use it to answer "how accurate / up to
    date is this data?" and before trusting any shelter-level conclusion.

    Args:
      county: Florida county name, or "" for statewide.

    Returns:
      unrecorded counts per field, self-contradicting records (same address, conflicting flags),
      suspicious records (capacity 0, name says INACTIVE/CLOSED, county text disagrees with
      coordinates), and the freshness of each source.
    """
    where, params, scope = "TRUE", {}, "Florida"
    if county.strip():
        fips, name = resolve_county(county)
        where, params, scope = "county_fips = @fips", {"fips": fips}, f"{name} County"
    S = table("shelters_enriched")
    unrec = _rows(f"""
        SELECT COUNT(*) shelters,
          COUNTIF(wheelchair='UNRECORDED') wheelchair, COUNTIF(generator='UNRECORDED') generator,
          COUNTIF(surge_flag='UNRECORDED') surge_flag, COUNTIF(evacuation_capacity IS NULL) capacity,
          COUNTIF(usage_unknown) usage
        FROM {S} WHERE {where}""", **params)[0]
    conflicts = _rows(f"""
        SELECT UPPER(address) address, ANY_VALUE(city) city,
          ARRAY_AGG(STRUCT(shelter_name, wheelchair, generator, evacuation_capacity AS capacity) LIMIT 4) records
        FROM {S} WHERE {where}
        GROUP BY UPPER(address)
        HAVING COUNT(DISTINCT IF(wheelchair != 'UNRECORDED', wheelchair, NULL)) > 1
            OR COUNT(DISTINCT IF(generator != 'UNRECORDED', generator, NULL)) > 1
        LIMIT 10""", **params)
    suspicious = _rows(f"""
        SELECT * FROM (
        SELECT shelter_id, shelter_name, city,
          CASE
            WHEN REGEXP_CONTAINS(UPPER(shelter_name), r'INACTIVE|CLOSED|DEMOLISH') THEN 'name says inactive/closed'
            WHEN pre_landfall AND evacuation_capacity = 0 THEN 'pre-landfall shelter with 0 recorded capacity'
            WHEN UPPER(REGEXP_REPLACE(REPLACE(UPPER(fema_county_text),'SAINT','ST.'), r'[^A-Z.]', ''))
                 != UPPER(REGEXP_REPLACE(county_name, r'[^A-Za-z.]', '')) THEN 'FEMA county text disagrees with coordinates'
          END issue
        FROM {S} WHERE {where})
        WHERE issue IS NOT NULL
        ORDER BY issue LIMIT 15""", **params)
    yes_by_county = _rows(f"""
        SELECT county_name, COUNT(*) shelters, COUNTIF(wheelchair != 'UNRECORDED') answered
        FROM {S} GROUP BY 1 ORDER BY answered DESC LIMIT 3""")
    blank_counties = _rows(f"""
        SELECT COUNT(*) n FROM (SELECT county_name FROM {S} GROUP BY 1 HAVING COUNTIF(wheelchair != 'UNRECORDED') = 0)""")[0]
    return {
        "scope": scope,
        "unrecorded_counts": {**unrec, "label": LBL["unrecorded"] + " = nobody wrote it down; never treat as NO"},
        "self_contradicting_records": conflicts,
        "suspicious_records": suspicious,
        "reporting_bias": {
            "counties_with_zero_wheelchair_answers": blank_counties["n"],
            "counties_answering_most": yes_by_county,
            "meaning": "Recorded accessibility measures which counties fill in the form, not which buildings work. "
                       "Never rank places by recorded accessibility.",
        },
        "freshness": {
            "shelters": f"{LBL['fema']}: a registry of every facility ever registered, some from past incidents. "
                        "FEMA says it must not be used for operational status.",
            "people": f"{LBL['measured']} ACS 2022 5-year; {LBL['modeled']} CDC PLACES 2025; CDC SVI 2022.",
            "hazard": "FEMA National Risk Index (tract level, planning use only).",
            "power_dependence": f"{LBL['county']}, monthly.",
            "live": f"{LBL['live']}: checked at the moment you ask; place_id is the only thing stored.",
        },
        "how_we_handle_missing_data": [
            "Unrecorded stays its own category (❓), counted and shown, never folded into NO.",
            "Shelters with no recorded capacity are not counted as usable spaces.",
            "Accessibility from Google Maps is accepted only when Google Maps cites it, and an accessible entrance "
            "is not treated as proof a wheelchair user can use the shelter unaccompanied.",
            "Operator interviews (record_shelter_assessment) fill the gaps the registry left.",
        ],
    }
