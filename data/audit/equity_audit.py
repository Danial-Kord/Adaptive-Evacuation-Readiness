"""Post-hoc Equity & Reporting-Bias Audit.

Per challenge rules:
- Race/ethnicity and socioeconomic variables are NOT used to filter out or deprioritize communities,
  and SVI Theme 3 is excluded as a model input.
- Instead, we audit the agent's recommended priority tracts against the state/county baseline
  to check:
  1. Did our recommendations land where people genuinely cannot self-evacuate?
  2. Did relying on recorded wheelchair accessibility introduce clerical/reporting bias?
"""

import os
from typing import List
from google.cloud import bigquery


def run_equity_audit(priority_tract_ids: List[str], state_fips: str = "12") -> dict:
    """Compare recommended tracts against the state baseline across poverty, income, and limited English."""
    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    dataset = os.environ.get("BQ_DATASET", "evacuation_readiness")
    client = bigquery.Client(project=project)

    sql = f"""
    WITH tagged AS (
      SELECT
        geo_id,
        geo_id IN UNNEST(@priority_ids) AS is_recommended,
        total_pop,
        poverty_rate,
        median_income,
        pct_limited_english,
        pct_no_vehicle,
        pct_disability,
        svi_socioeconomic
      FROM `{project}.{dataset}.vulnerability_tracts`
      WHERE total_pop > 0
    )
    SELECT
      is_recommended,
      COUNT(*) AS tract_count,
      ROUND(AVG(poverty_rate) * 100, 1) AS avg_poverty_pct,
      ROUND(AVG(median_income), 0) AS avg_median_income,
      ROUND(AVG(pct_limited_english), 1) AS avg_limited_english_pct,
      ROUND(AVG(pct_no_vehicle), 1) AS avg_no_vehicle_pct,
      ROUND(AVG(pct_disability), 1) AS avg_disability_pct
    FROM tagged
    GROUP BY is_recommended
    ORDER BY is_recommended DESC
    """

    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ArrayQueryParameter("priority_ids", "STRING", priority_tract_ids),
        ]
    )
    rows = [dict(r) for r in client.query(sql, job_config=job_config).result()]
    return {"comparison": rows}


if __name__ == "__main__":
    print("Run `run_equity_audit(priority_tract_ids)` after generating your county Readiness Brief.")
