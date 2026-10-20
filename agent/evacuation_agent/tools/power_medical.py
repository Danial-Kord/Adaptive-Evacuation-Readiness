"""Tool 3: Evaluate electricity-dependent populations (HHS emPOWER) and nursing homes (CMS)."""

import os
from typing import Any, Dict
from google.cloud import bigquery


def get_power_and_medical_gaps(
    county_name_or_fips: str,
    limit: int = 15,
) -> Dict[str, Any]:
    """Retrieve county-level electricity-dependent Medicare beneficiaries (emPOWER), nursing homes (CMS), and medical shelters.

    Args:
        county_name_or_fips: County name (e.g. 'Miami-Dade', 'Lee', 'Pinellas') or 5-digit county FIPS (e.g. '12086').
        limit: Max number of nursing home care facilities to return.

    Returns:
        Dictionary with county-level emPOWER power-dependent counts (noting censoring if value == 11),
        medical-needs shelters in the county, and top nursing homes by certified bed count.
    """
    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    dataset = os.environ.get("BQ_DATASET", "evacuation_readiness")
    client = bigquery.Client(project=project)

    empower_sql = f"""
    SELECT
      e.fips_code,
      e.power_dependent_dme,
      e.power_dependent_is_censored,
      COUNT(DISTINCT s.shelter_id) AS total_shelters_in_county,
      COUNTIF(s.is_medical IS TRUE) AS medical_shelters_in_county,
      COUNTIF(s.generator_onsite IS TRUE) AS shelters_with_recorded_generator,
      SUM(CASE WHEN s.is_medical IS TRUE THEN IFNULL(s.evacuation_capacity, 0) ELSE 0 END) AS medical_shelter_evac_capacity
    FROM `{project}.{dataset}.power_dependent_counties` e
    LEFT JOIN `{project}.{dataset}.shelters` s
      ON s.county_fips = e.fips_code
    WHERE e.fips_code = @county
       OR LOWER(s.county_name) LIKE CONCAT('%', LOWER(@county), '%')
       OR LOWER(s.county_parish) LIKE CONCAT('%', LOWER(@county), '%')
    GROUP BY e.fips_code, e.power_dependent_dme, e.power_dependent_is_censored
    LIMIT 5
    """

    care_sql = f"""
    WITH target_cities AS (
      SELECT DISTINCT UPPER(TRIM(city)) AS city
      FROM `{project}.{dataset}.shelters`
      WHERE LOWER(county_name) LIKE CONCAT('%', LOWER(@county), '%')
         OR LOWER(county_parish) LIKE CONCAT('%', LOWER(@county), '%')
         OR county_fips = @county
    )
    SELECT *
    FROM `{project}.{dataset}.care_facilities`
    WHERE UPPER(TRIM(IFNULL(citytown, ''))) IN (SELECT city FROM target_cities)
    ORDER BY number_of_certified_beds DESC NULLS LAST
    LIMIT @limit
    """

    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("county", "STRING", county_name_or_fips),
            bigquery.ScalarQueryParameter("limit", "INT64", limit),
        ]
    )

    try:
        empower_rows = [dict(r) for r in client.query(empower_sql, job_config=job_config).result()]
        try:
            care_rows = [dict(r) for r in client.query(care_sql, job_config=job_config).result()]
        except Exception:
            care_rows = []

        return {
            "status": "success",
            "county_query": county_name_or_fips,
            "empower_county_summary": empower_rows,
            "care_facilities": care_rows,
            "scale_and_censoring_notes": [
                "HHS emPOWER is published strictly at the COUNTY level, never at the census tract or block level.",
                "If power_dependent_is_censored is TRUE (value == 11), the actual count is suppressed between 1 and 10.",
                "Assisted living facilities are state-regulated and have no national federal roster; care_facilities covers CMS Medicare-certified nursing homes only.",
            ],
        }
    except Exception as exc:
        return {"status": "error", "error": str(exc)}
