from bqh import q
q("reporting rate by county (largest 12 by shelters) - is 'recorded' a county habit?", """
SELECT county_name, COUNT(*) shelters, COUNTIF(wheelchair_accessible) wc_yes, COUNTIF(NOT wheelchair_accessible) wc_no,
  ROUND(100*COUNTIF(wheelchair_accessible IS NULL)/COUNT(*)) pct_wc_unrec, ROUND(100*COUNTIF(in_surge_slosh_area IS NULL)/COUNT(*)) pct_surge_unrec,
  COUNTIF(is_medical) med, ROUND(100*COUNTIF(COALESCE(evacuation_capacity,0)=0)/COUNT(*)) pct_cap_missing
FROM D.shelters$ GROUP BY 1 ORDER BY shelters DESC LIMIT 12""")
q("counties with 0% vs 100% wheelchair unrecorded", """
WITH c AS (SELECT county_name, COUNT(*) n, COUNTIF(wheelchair_accessible IS NULL) u FROM D.shelters$ GROUP BY 1)
SELECT COUNTIF(u=n) all_unrecorded_counties, COUNTIF(u=0) fully_recorded_counties, COUNT(*) counties FROM c""")
q("capacity missing by usage", "SELECT usage, COUNT(*) n, COUNTIF(evacuation_capacity IS NULL) cap_null, COUNTIF(evacuation_capacity=0) cap0, COUNTIF(post_impact_capacity>0) has_post_cap FROM D.shelters$ GROUP BY 1")
q("shelters whose FEMA county != county from coordinates", """SELECT shelter_name, city, county_parish fema_county, county_name coord_county FROM D.shelters$
 WHERE UPPER(REPLACE(REPLACE(county_parish,'SAINT','ST.'),' ','')) != UPPER(REPLACE(REPLACE(county_name,' County',''),' ','')) AND county_parish NOT IN ('DE SOTO') LIMIT 12""")
q("LEE COUNTY profile", """
SELECT (SELECT COUNT(*) FROM D.vulnerability_tracts$ WHERE county_fips='12071') tracts,
 (SELECT SUM(total_pop) FROM D.vulnerability_tracts$ WHERE county_fips='12071') pop,
 (SELECT SUM(households_no_vehicle) FROM D.vulnerability_tracts$ WHERE county_fips='12071') hh_no_car,
 (SELECT SUM(pop_65_plus) FROM D.vulnerability_tracts$ WHERE county_fips='12071') pop65,
 (SELECT SUM(mobile_homes) FROM D.vulnerability_tracts$ WHERE county_fips='12071') mobile_homes,
 (SELECT COUNT(*) FROM D.shelters$ WHERE county_fips='12071') shelters,
 (SELECT COUNTIF(wheelchair_accessible) FROM D.shelters$ WHERE county_fips='12071') wc_yes,
 (SELECT COUNTIF(wheelchair_accessible IS NULL) FROM D.shelters$ WHERE county_fips='12071') wc_unrec,
 (SELECT COUNTIF(is_medical) FROM D.shelters$ WHERE county_fips='12071') med,
 (SELECT SUM(evacuation_capacity) FROM D.shelters$ WHERE county_fips='12071') evac_cap,
 (SELECT COUNT(*) FROM D.care_facilities$ c WHERE UPPER(citytown) IN ('FORT MYERS','CAPE CORAL','LEHIGH ACRES','BONITA SPRINGS','ESTERO','NORTH FORT MYERS','FORT MYERS BEACH','SANIBEL')) nursing_homes_approx""")
q("Lee shelters by usage + flags", """SELECT usage, COUNT(*) n, COUNTIF(wheelchair_accessible) wc_yes, COUNTIF(wheelchair_accessible IS NULL) wc_unrec,
 COUNTIF(in_surge_slosh_area) surge_yes, COUNTIF(in_surge_slosh_area IS NULL) surge_unrec, COUNTIF(is_medical) med, SUM(evacuation_capacity) cap
 FROM D.shelters$ WHERE county_fips='12071' GROUP BY 1""")
