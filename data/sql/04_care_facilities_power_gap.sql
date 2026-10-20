-- 04_care_facilities_power_gap.sql
-- Joins county-level HHS emPOWER electricity-dependent Medicare beneficiary counts
-- with county shelter generator & medical-needs capacity.
-- Note: power_dependent_is_censored = TRUE means the count is masked as 11 (representing 1-10).

SELECT
  e.fips_code AS county_fips,
  MAX(s.county_name) AS county_name,
  e.power_dependent_dme,
  e.power_dependent_is_censored,
  COUNT(DISTINCT s.shelter_id) AS total_shelters,
  COUNTIF(s.is_medical IS TRUE) AS medical_needs_shelters,
  SUM(CASE WHEN s.is_medical IS TRUE THEN IFNULL(s.evacuation_capacity, 0) ELSE 0 END) AS medical_evac_capacity,
  COUNTIF(s.generator_onsite IS TRUE) AS shelters_with_generator_yes,
  COUNTIF(s.generator_onsite IS NULL) AS shelters_with_generator_unrecorded
FROM `evacuation_readiness.power_dependent_counties` e
LEFT JOIN `evacuation_readiness.shelters` s
  ON s.county_fips = e.fips_code
GROUP BY e.fips_code, e.power_dependent_dme, e.power_dependent_is_censored
ORDER BY e.power_dependent_dme DESC;
