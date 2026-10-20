-- Derived tables the agent reads. Built from the five challenge tables; safe to re-run.
-- Run with: python agent/sql/build_derived.py   (substitutes ${DS})
--
-- Modeling decisions encoded here (and defended in the deck):
--   * Accessibility, generator, surge and floodplain flags are three-state strings:
--     YES / NO / UNRECORDED. A NULL never becomes NO.
--   * "Pre-landfall" shelters are usage EVAC or BOTH. POST shelters are excluded from
--     evacuation options (their evacuation_capacity is 0 by design, not missing).
--     Usage NULL is kept but flagged usage_unknown.
--   * Site hazard for a shelter comes from the FEMA NRI row of the nearest 2020 tract
--     centroid (approximation: shelters carry no tract id). Used because the shelter's own
--     surge flag is unrecorded for 81% of FL shelters (97% in Lee).
--   * Reachability: WALK_KM = 1.6 (one mile) for households with no vehicle;
--     DRIVE_KM = 25 for households with one. Straight-line distance; drive time comes
--     from Grounding with Google Maps routing at runtime.

-- Counties: one name per FIPS (derived-from-coordinates name used by the shelters table).
CREATE OR REPLACE TABLE ${DS}.counties AS
SELECT county_fips, ANY_VALUE(county_name) AS county_name
FROM ${DS}.shelters
GROUP BY county_fips;

-- Shelters, cleaned into explicit categories, with site hazard from the nearest tract.
CREATE OR REPLACE TABLE ${DS}.shelters_enriched AS
WITH s AS (
  SELECT *,
    CASE WHEN wheelchair_accessible THEN 'YES' WHEN NOT wheelchair_accessible THEN 'NO' ELSE 'UNRECORDED' END AS wheelchair,
    CASE WHEN generator_onsite THEN 'YES' WHEN NOT generator_onsite THEN 'NO' ELSE 'UNRECORDED' END AS generator,
    CASE WHEN in_surge_slosh_area THEN 'YES' WHEN NOT in_surge_slosh_area THEN 'NO' ELSE 'UNRECORDED' END AS surge_flag,
    CASE WHEN in_100_yr_floodplain THEN 'YES' WHEN NOT in_100_yr_floodplain THEN 'NO' ELSE 'UNRECORDED' END AS floodplain_flag,
    ST_GEOGPOINT(longitude, latitude) AS geog
  FROM ${DS}.shelters
  WHERE latitude IS NOT NULL
),
nearest AS (
  SELECT s.shelter_id,
    ARRAY_AGG(STRUCT(t.geo_id, ST_DISTANCE(s.geog, ST_GEOGPOINT(t.lon, t.lat)) AS d)
              ORDER BY ST_DISTANCE(s.geog, ST_GEOGPOINT(t.lon, t.lat)) LIMIT 1)[OFFSET(0)] AS nt
  FROM s JOIN ${DS}.vulnerability_tracts t
    ON ST_DWITHIN(s.geog, ST_GEOGPOINT(t.lon, t.lat), 20000)
  GROUP BY s.shelter_id
)
SELECT
  s.shelter_id, TRIM(s.shelter_name) AS shelter_name, TRIM(s.address_1) AS address, TRIM(s.city) AS city, s.zip,
  s.county_fips, s.county_name, TRIM(s.county_parish) AS fema_county_text,
  s.latitude, s.longitude, s.usage,
  s.usage IN ('EVAC', 'BOTH') AS pre_landfall,
  s.usage IS NULL AS usage_unknown,
  s.evacuation_capacity, s.post_impact_capacity,
  s.wheelchair, s.generator, s.surge_flag, s.floodplain_flag,
  s.is_medical, s.population_code, s.incident_id,
  n.nt.geo_id AS nearest_tract,
  h.CFLD_EXPP AS site_coastal_flood_exposed_pop,
  SAFE_DIVIDE(h.CFLD_EXPP, h.POPULATION) AS site_coastal_flood_share,
  h.HRCN_EALT AS site_hurricane_eal_usd,
  -- Flood-hazard ground: the recorded surge flag says YES, or >=25% of the surrounding
  -- tract's population is exposed to coastal flooding (FEMA NRI).
  (SAFE_DIVIDE(h.CFLD_EXPP, h.POPULATION) >= 0.25 OR s.in_surge_slosh_area IS TRUE) AS site_in_flood_hazard
FROM s
LEFT JOIN nearest n USING (shelter_id)
LEFT JOIN ${DS}.hazard_tracts h ON h.geo_id = n.nt.geo_id;

-- Tracts: who cannot self-evacuate, why they must, and how far the options are.
CREATE OR REPLACE TABLE ${DS}.tract_readiness AS
WITH t AS (
  SELECT v.geo_id, v.county_fips, v.lat, v.lon, v.total_pop, v.households,
    v.households_no_vehicle AS hh_no_vehicle,
    SAFE_DIVIDE(v.households_no_vehicle, v.households) AS share_no_vehicle,
    v.pop_65_plus, v.mobile_homes, v.pct_mobile_homes, v.group_quarters_pop,
    v.pct_disability, v.pct_mobility,
    -- CDC PLACES is modeled prevalence, so this count is an estimate, labelled as such.
    v.total_pop * v.pct_mobility / 100 AS est_mobility_disabled_modeled,
    h.CFLD_EXPP AS coastal_flood_exposed_pop,
    SAFE_DIVIDE(h.CFLD_EXPP, h.POPULATION) AS coastal_flood_share, h.HRCN_EALT AS hurricane_eal_usd,
    h.geo_id IS NULL AS hazard_missing
  FROM ${DS}.vulnerability_tracts v
  LEFT JOIN ${DS}.hazard_tracts h USING (geo_id)
  WHERE v.total_pop > 0 AND v.lat IS NOT NULL
),
dist AS (
  SELECT t.geo_id,
    MIN(ST_DISTANCE(ST_GEOGPOINT(t.lon, t.lat), ST_GEOGPOINT(s.longitude, s.latitude))) / 1000 AS km_nearest_shelter,
    -- A human-readable place label for the tract: the city of its nearest shelter.
    INITCAP(ARRAY_AGG(s.city ORDER BY ST_DISTANCE(ST_GEOGPOINT(t.lon, t.lat), ST_GEOGPOINT(s.longitude, s.latitude)) LIMIT 1)[OFFSET(0)]) AS near_city,
    MIN(IF(s.wheelchair = 'YES', ST_DISTANCE(ST_GEOGPOINT(t.lon, t.lat), ST_GEOGPOINT(s.longitude, s.latitude)), NULL)) / 1000 AS km_nearest_recorded_accessible,
    COUNTIF(ST_DWITHIN(ST_GEOGPOINT(t.lon, t.lat), ST_GEOGPOINT(s.longitude, s.latitude), 1600)) AS n_within_walk,
    COUNTIF(ST_DWITHIN(ST_GEOGPOINT(t.lon, t.lat), ST_GEOGPOINT(s.longitude, s.latitude), 1600) AND s.wheelchair = 'YES') AS n_within_walk_wc_yes,
    COUNTIF(ST_DWITHIN(ST_GEOGPOINT(t.lon, t.lat), ST_GEOGPOINT(s.longitude, s.latitude), 1600) AND s.wheelchair = 'NO') AS n_within_walk_wc_no,
    COUNTIF(ST_DWITHIN(ST_GEOGPOINT(t.lon, t.lat), ST_GEOGPOINT(s.longitude, s.latitude), 1600) AND s.wheelchair = 'UNRECORDED') AS n_within_walk_wc_unrecorded,
    COUNTIF(ST_DWITHIN(ST_GEOGPOINT(t.lon, t.lat), ST_GEOGPOINT(s.longitude, s.latitude), 25000)) AS n_within_drive,
    COUNTIF(ST_DWITHIN(ST_GEOGPOINT(t.lon, t.lat), ST_GEOGPOINT(s.longitude, s.latitude), 25000) AND s.wheelchair = 'YES') AS n_within_drive_wc_yes,
    COUNTIF(ST_DWITHIN(ST_GEOGPOINT(t.lon, t.lat), ST_GEOGPOINT(s.longitude, s.latitude), 25000) AND s.wheelchair = 'UNRECORDED') AS n_within_drive_wc_unrecorded
  FROM t CROSS JOIN ${DS}.shelters_enriched s
  WHERE s.pre_landfall OR s.usage_unknown
  GROUP BY t.geo_id
),
ranked AS (
  SELECT t.*,
    PERCENT_RANK() OVER (PARTITION BY county_fips ORDER BY hh_no_vehicle) AS pr_no_vehicle,
    PERCENT_RANK() OVER (PARTITION BY county_fips ORDER BY COALESCE(est_mobility_disabled_modeled, 0)) AS pr_mobility,
    PERCENT_RANK() OVER (PARTITION BY county_fips ORDER BY pop_65_plus) AS pr_65_plus,
    PERCENT_RANK() OVER (PARTITION BY county_fips ORDER BY mobile_homes) AS pr_mobile_homes
  FROM t
)
SELECT r.*, c.county_name, d.* EXCEPT (geo_id),
  -- "Run from water, hide from wind": surge/coastal-flood areas and mobile homes are the
  -- populations evacuation orders target. Everyone else is a shelter-in-place candidate.
  CASE
    WHEN r.coastal_flood_share >= 0.25 AND COALESCE(r.pct_mobile_homes, 0) >= 10 THEN 'coastal flood + mobile homes'
    WHEN r.coastal_flood_share >= 0.25 THEN 'coastal flood exposure'
    WHEN COALESCE(r.pct_mobile_homes, 0) >= 10 THEN 'mobile homes'
    ELSE NULL
  END AS evacuation_driver,
  -- Counts, not percentages: a planner sends buses to people. No-vehicle households weigh double
  -- because they are the measured (not modeled) signal of inability to self-evacuate.
  (2 * r.pr_no_vehicle + r.pr_mobility + r.pr_65_plus + r.pr_mobile_homes) / 5 AS need_score
FROM ranked r
JOIN dist d USING (geo_id)
LEFT JOIN ${DS}.counties c USING (county_fips);

ALTER TABLE ${DS}.tract_readiness ADD COLUMN IF NOT EXISTS priority_score FLOAT64;
UPDATE ${DS}.tract_readiness
SET priority_score = need_score * IF(evacuation_driver IS NOT NULL, 1.0, 0.5)
WHERE TRUE;

-- Nursing homes, placed in a county and a hazard by nearest tract.
CREATE OR REPLACE TABLE ${DS}.care_enriched AS
WITH c AS (
  SELECT *, ST_GEOGPOINT(longitude, latitude) AS geog FROM ${DS}.care_facilities WHERE latitude IS NOT NULL
),
nearest AS (
  SELECT c.cms_certification_number_ccn AS ccn,
    ARRAY_AGG(t.geo_id ORDER BY ST_DISTANCE(c.geog, ST_GEOGPOINT(t.lon, t.lat)) LIMIT 1)[OFFSET(0)] AS geo_id
  FROM c JOIN ${DS}.vulnerability_tracts t ON ST_DWITHIN(c.geog, ST_GEOGPOINT(t.lon, t.lat), 20000)
  GROUP BY 1
),
med AS (
  SELECT c.cms_certification_number_ccn AS ccn,
    MIN(ST_DISTANCE(c.geog, ST_GEOGPOINT(s.longitude, s.latitude))) / 1000 AS km_nearest_medical_shelter
  FROM c CROSS JOIN ${DS}.shelters_enriched s WHERE s.is_medical
  GROUP BY 1
)
SELECT c.cms_certification_number_ccn AS ccn, c.provider_name, c.provider_address, c.citytown,
  c.number_of_certified_beds AS beds, c.latitude, c.longitude,
  v.county_fips, cn.county_name, n.geo_id AS nearest_tract,
  SAFE_DIVIDE(h.CFLD_EXPP, h.POPULATION) >= 0.25 AS site_coastal_flood_exposed, m.km_nearest_medical_shelter
FROM c
LEFT JOIN nearest n ON n.ccn = c.cms_certification_number_ccn
LEFT JOIN ${DS}.vulnerability_tracts v ON v.geo_id = n.geo_id
LEFT JOIN ${DS}.counties cn ON cn.county_fips = v.county_fips
LEFT JOIN ${DS}.hazard_tracts h ON h.geo_id = n.geo_id
LEFT JOIN med m ON m.ccn = c.cms_certification_number_ccn;

-- Google Maps place_id pointers (the only Maps content we are allowed to keep).
CREATE TABLE IF NOT EXISTS ${DS}.shelter_place_ids (
  shelter_id INT64, place_id STRING, maps_title STRING, verified_at TIMESTAMP, status STRING
);

-- Shelter assessments captured from operators (closes the "unrecorded" gap).
CREATE TABLE IF NOT EXISTS ${DS}.shelter_assessments (
  shelter_id INT64, assessed_at TIMESTAMP, wheelchair_unaccompanied STRING,
  step_free_entrance STRING, accessible_restroom STRING, generator STRING,
  notes STRING, source STRING
);
