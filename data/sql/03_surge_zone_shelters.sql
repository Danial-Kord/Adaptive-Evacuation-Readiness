-- 03_surge_zone_shelters.sql
-- Identifies shelters located inside storm surge / slosh areas or 100-year floodplains,
-- joined with the nearest census tract's FEMA National Risk Index hurricane & coastal flood exposure.

SELECT
  s.shelter_id,
  s.shelter_name,
  s.address_1,
  s.city,
  s.county_name,
  s.county_fips,
  s.evacuation_capacity,
  s.post_impact_capacity,
  s.usage,
  s.in_surge_slosh_area,
  s.in_100_yr_floodplain,
  CASE
    WHEN s.wheelchair_accessible IS TRUE THEN 'YES'
    WHEN s.wheelchair_accessible IS FALSE THEN 'NO'
    ELSE 'UNRECORDED'
  END AS wheelchair_status
FROM `evacuation_readiness.shelters` s
WHERE s.in_surge_slosh_area IS TRUE
   OR s.in_100_yr_floodplain IS TRUE
ORDER BY s.evacuation_capacity DESC NULLS LAST;
