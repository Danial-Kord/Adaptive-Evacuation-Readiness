"""BigQuery-backed tools. The SQL that encodes the data rules lives in agent/sql/derived.sql;
these functions hold the judgment calls on top of it."""
from __future__ import annotations

import datetime as dt
import math
import re
from functools import lru_cache

from google.cloud import bigquery

from .config import DRIVE_KM, PROJECT, WALK_KM, table

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
    tract = _rows(f"""SELECT geo_id, county_name, lat, lon, total_pop, hh_no_vehicle, share_no_vehicle
                      FROM {table('tract_readiness')} WHERE geo_id = @g""", g=geo_id)
    if not tract:
        return {"error": f"tract {geo_id} not found"}
    t = tract[0]
    shelters = _rows(f"""
        SELECT shelter_id, shelter_name, address, city, county_name, usage,
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
    counts = {k: sum(1 for s in shelters if s["wheelchair"] == k) for k in ("YES", "NO", "UNRECORDED")}
    return {
        "tract": t, "shelters": shelters,
        "wheelchair_record_counts": counts,
        "note": "Distances are straight-line. Call verify_shelters_live with origin_tract for drive times "
                "and to check each building still exists.",
    }


def find_shelters(county: str, name_contains: str = "", pre_landfall_only: bool = True, limit: int = 25) -> dict:
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
    rows = _rows(f"""SELECT shelter_id, shelter_name, address, city, usage, evacuation_capacity capacity,
          wheelchair, generator, surge_flag, is_medical, site_in_flood_hazard
        FROM {table('shelters_enriched')} WHERE {where}
        ORDER BY evacuation_capacity DESC NULLS LAST LIMIT @n""", fips=fips, pat=pat, n=max(1, min(int(limit), 50)))
    return {"county": name, "summary": counts, "shelters": rows,
            "source": "FEMA National Shelter System (historical registry; not operational status)"}


def county_gap_report(county: str) -> dict:
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
          ARRAY_AGG(STRUCT(geo_id, near_city, hh_no_vehicle, ROUND(0.621 * km_nearest_shelter,1) AS miles_nearest_shelter)
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
                       STRUCT(shelter_id, shelter_name, city, evacuation_capacity AS capacity,
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
          ARRAY_AGG(IF(site_coastal_flood_exposed, STRUCT(provider_name, citytown, beds,
                    ROUND(0.621 * km_nearest_medical_shelter,1) AS miles_nearest_medical_shelter), NULL)
                    IGNORE NULLS ORDER BY beds DESC LIMIT 6) largest
        FROM {C} WHERE county_fips=@fips""", fips=fips)[0]
    unknown = _rows(f"""
        SELECT COUNT(*) shelters, COUNTIF(wheelchair='UNRECORDED') wheelchair_unrecorded,
          COUNTIF(generator='UNRECORDED') generator_unrecorded, COUNTIF(surge_flag='UNRECORDED') surge_unrecorded,
          COUNTIF(evacuation_capacity IS NULL) capacity_unrecorded, COUNTIF(usage_unknown) usage_unrecorded,
          COUNTIF(UPPER(REGEXP_REPLACE(REPLACE(UPPER(fema_county_text),'SAINT','ST.'), r'[^A-Z.]', ''))
                  != UPPER(REGEXP_REPLACE(county_name, r'[^A-Za-z.]', ''))) fema_county_disagrees_with_coordinates
        FROM {S} WHERE county_fips=@fips""", fips=fips)[0]
    return {
        "county": name,
        "evacuation_zone_tracts_with_no_shelter_within_1_mile": walk,
        "accessible_shelter_access": access,
        "shelters_on_flood_hazard_ground": flood,
        "medical_and_power_dependence": medical,
        "nursing_homes": care,
        "what_the_record_cannot_tell_us": unknown,
        "caveats": [
            "Flood-hazard ground = recorded surge flag YES, or >=25% of the surrounding tract's population "
            "exposed to coastal flooding (FEMA NRI). Tract-level, not the building's own elevation.",
            "Power dependence (HHS emPOWER) is county-level only: how many, never which block. The dialysis "
            "figure counts end-stage kidney disease patients dialysing at a FACILITY who also use power-dependent "
            "equipment at home (not home dialysis); facility dialysis needs the clinic open after landfall.",
            "A tract with 'no recorded-accessible shelter' may have accessible shelters nobody assessed.",
        ],
    }


def equity_audit(county: str, top_n: int = 20) -> dict:
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
        FROM j GROUP BY grp ORDER BY grp""", fips=fips, n=max(5, min(int(top_n), 60)))
    return {
        "county": name, "groups": rows,
        "how_to_read": "If priority tracts differ sharply in recording rate, the ranking may follow paperwork. "
                       "Race shares are reported, not used as inputs; a difference is a finding to state, not hide.",
        "notes": "ACS 2020 5-yr (bigquery-public-data). median_income excludes the -666666666 ACS sentinel.",
    }


def record_shelter_assessment(shelter_id: int, wheelchair_unaccompanied: str, step_free_entrance: str,
                              accessible_restroom: str, generator: str, notes: str = "") -> dict:
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
    row = {"shelter_id": int(shelter_id), "assessed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
           **vals, "notes": notes[:2000], "source": "operator assessment via agent"}
    errors = _bq().insert_rows_json(f"{PROJECT}.evacuation_readiness.shelter_assessments", [row])
    return {"saved": not errors, "errors": errors, "record": row}
