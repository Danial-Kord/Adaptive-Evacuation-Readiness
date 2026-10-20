"""Tool 2: Audit shelter readiness, surge exposure, and unrecorded accessibility in a county."""

import os
from typing import Any, Dict
from google.cloud import bigquery


def analyze_shelter_readiness(
    county_name_or_fips: str,
    limit: int = 25,
) -> Dict[str, Any]:
    """Analyze shelter capacity, wheelchair accessibility (YES vs NO vs UNRECORDED), generator status, and storm surge risk.

    Args:
        county_name_or_fips: County name (e.g. 'Miami-Dade', 'Lee', 'Pinellas') or 5-digit county FIPS (e.g. '12086').
        limit: Max number of candidate shelters to return for live Google Maps verification.

    Returns:
        Dictionary with county-level summary counts (explicitly separating UNRECORDED from NO) and candidate shelters to verify via Google Maps grounding.
    """
    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    dataset = os.environ.get("BQ_DATASET", "evacuation_readiness")
    client = bigquery.Client(project=project)

    summary_sql = f"""
    SELECT
      COUNT(*) AS total_shelters,
      SUM(IFNULL(evacuation_capacity, 0)) AS total_evacuation_capacity,
      SUM(IFNULL(post_impact_capacity, 0)) AS total_post_impact_capacity,
      COUNTIF(wheelchair_accessible IS TRUE) AS wheelchair_recorded_yes,
      COUNTIF(wheelchair_accessible IS FALSE) AS wheelchair_recorded_no,
      COUNTIF(wheelchair_accessible IS NULL) AS wheelchair_unrecorded,
      ROUND(100.0 * COUNTIF(wheelchair_accessible IS NULL) / GREATEST(COUNT(*), 1), 1) AS pct_wheelchair_unrecorded,
      COUNTIF(generator_onsite IS TRUE) AS generator_recorded_yes,
      COUNTIF(generator_onsite IS FALSE) AS generator_recorded_no,
      COUNTIF(generator_onsite IS NULL) AS generator_unrecorded,
      COUNTIF(in_surge_slosh_area IS TRUE) AS shelters_in_surge_zone,
      COUNTIF(in_100_yr_floodplain IS TRUE) AS shelters_in_100yr_floodplain,
      COUNTIF(is_medical IS TRUE) AS medical_needs_shelters,
      COUNTIF(usage = 'EVAC') AS evac_designated_shelters,
      COUNTIF(usage = 'POST') AS post_impact_designated_shelters
    FROM `{project}.{dataset}.shelters`
    WHERE LOWER(county_name) LIKE CONCAT('%', LOWER(@county), '%')
       OR LOWER(county_parish) LIKE CONCAT('%', LOWER(@county), '%')
       OR county_fips = @county
    """

    candidates_sql = f"""
    SELECT
      shelter_id,
      shelter_name,
      address_1,
      city,
      county_name,
      state,
      zip,
      latitude,
      longitude,
      evacuation_capacity,
      post_impact_capacity,
      CASE
        WHEN wheelchair_accessible IS TRUE THEN 'YES'
        WHEN wheelchair_accessible IS FALSE THEN 'NO'
        ELSE 'UNRECORDED'
      END AS wheelchair_status,
      CASE
        WHEN generator_onsite IS TRUE THEN 'YES'
        WHEN generator_onsite IS FALSE THEN 'NO'
        ELSE 'UNRECORDED'
      END AS generator_status,
      in_surge_slosh_area,
      in_100_yr_floodplain,
      is_medical,
      usage
    FROM `{project}.{dataset}.shelters`
    WHERE LOWER(county_name) LIKE CONCAT('%', LOWER(@county), '%')
       OR LOWER(county_parish) LIKE CONCAT('%', LOWER(@county), '%')
       OR county_fips = @county
    ORDER BY
      evacuation_capacity DESC NULLS LAST,
      post_impact_capacity DESC NULLS LAST
    LIMIT @limit
    """

    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("county", "STRING", county_name_or_fips),
            bigquery.ScalarQueryParameter("limit", "INT64", limit),
        ]
    )

    try:
        summary_rows = [dict(r) for r in client.query(summary_sql, job_config=job_config).result()]
        candidate_rows = [dict(r) for r in client.query(candidates_sql, job_config=job_config).result()]
        return {
            "status": "success",
            "county_query": county_name_or_fips,
            "summary": summary_rows[0] if summary_rows else {},
            "candidate_shelters": candidate_rows,
            "next_step_for_agent": (
                "IMPORTANT: FEMA's shelter table is a static historical registry. "
                "Call google_maps_grounding on the top candidate shelters (one named building and address at a time) "
                "to verify whether the building still exists, whether its name changed, whether it is open, "
                "and whether Google Maps reports wheelchair-accessible entrance information."
            ),
        }
    except Exception as exc:
        return {"status": "error", "error": str(exc)}
