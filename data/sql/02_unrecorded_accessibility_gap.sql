-- 02_unrecorded_accessibility_gap.sql
-- Summarizes wheelchair accessibility and generator reporting by county.
-- CRITICAL: Keeps NULL ('UNRECORDED') separate from FALSE ('NO').

SELECT
  county_fips,
  county_name,
  COUNT(*) AS total_shelters,
  SUM(IFNULL(evacuation_capacity, 0)) AS total_evacuation_capacity,
  COUNTIF(wheelchair_accessible IS TRUE) AS wheelchair_yes,
  COUNTIF(wheelchair_accessible IS FALSE) AS wheelchair_no,
  COUNTIF(wheelchair_accessible IS NULL) AS wheelchair_unrecorded,
  ROUND(100.0 * COUNTIF(wheelchair_accessible IS NULL) / GREATEST(COUNT(*), 1), 1) AS pct_wheelchair_unrecorded,
  COUNTIF(generator_onsite IS TRUE) AS generator_yes,
  COUNTIF(generator_onsite IS FALSE) AS generator_no,
  COUNTIF(generator_onsite IS NULL) AS generator_unrecorded,
  COUNTIF(is_medical IS TRUE) AS medical_needs_shelters
FROM `evacuation_readiness.shelters`
GROUP BY county_fips, county_name
ORDER BY total_evacuation_capacity DESC;
