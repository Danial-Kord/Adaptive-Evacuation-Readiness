-- 01_tract_to_shelter_distance.sql
-- Computes straight-line distance from each census tract centroid to:
--   1. Nearest shelter of any kind
--   2. Nearest shelter recorded as wheelchair accessible (wheelchair_accessible IS TRUE)
--   3. Count of shelters within 10 km where wheelchair accessibility is UNRECORDED (IS NULL)

WITH tracts AS (
  SELECT
    geo_id,
    county_fips,
    total_pop,
    households,
    households_no_vehicle,
    SAFE_DIVIDE(households_no_vehicle, households) AS share_no_vehicle,
    pct_no_vehicle,
    pct_age_65_plus,
    pct_disability,
    pct_mobility,
    mobile_homes,
    lat,
    lon
  FROM `evacuation_readiness.vulnerability_tracts`
  WHERE lat IS NOT NULL AND total_pop > 0
),
shelters AS (
  SELECT
    shelter_id,
    shelter_name,
    county_fips,
    latitude,
    longitude,
    evacuation_capacity,
    wheelchair_accessible,
    generator_onsite,
    in_surge_slosh_area
  FROM `evacuation_readiness.shelters`
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL
)
SELECT
  t.geo_id,
  t.county_fips,
  t.total_pop,
  t.households_no_vehicle,
  t.pct_no_vehicle,
  t.pct_age_65_plus,
  t.pct_disability,
  t.mobile_homes,
  ROUND(MIN(ST_DISTANCE(ST_GEOGPOINT(t.lon, t.lat), ST_GEOGPOINT(s.longitude, s.latitude))) / 1000.0, 2) AS km_to_any_shelter,
  ROUND(MIN(CASE WHEN s.wheelchair_accessible IS TRUE
                 THEN ST_DISTANCE(ST_GEOGPOINT(t.lon, t.lat), ST_GEOGPOINT(s.longitude, s.latitude)) END) / 1000.0, 2) AS km_to_recorded_wheelchair_shelter,
  COUNTIF(
    ST_DWITHIN(ST_GEOGPOINT(t.lon, t.lat), ST_GEOGPOINT(s.longitude, s.latitude), 10000)
    AND s.wheelchair_accessible IS NULL
  ) AS shelters_within_10km_unrecorded_accessibility
FROM tracts t
CROSS JOIN shelters s
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
ORDER BY t.households_no_vehicle DESC;
