from bqh import q
cols = ["total_pop","households","households_no_vehicle","pop_65_plus","mobile_homes","group_quarters_pop","median_income",
        "pct_disability","pct_age_65_plus","pct_no_vehicle","pct_mobility","pct_selfcare","pct_indeplive","pct_lacktrpt","pct_mobile_homes","svi_housing_transport","lat"]
q("tracts: null / negative / range per column", " UNION ALL ".join(
  f"SELECT '{c}' col, COUNTIF({c} IS NULL) n_null, COUNTIF({c}<0) negative, ROUND(MIN({c}),2) min_v, ROUND(APPROX_QUANTILES({c},2)[OFFSET(1)],2) median, ROUND(MAX({c}),2) max_v FROM D.vulnerability_tracts$" for c in cols))
q("zero-pop tracts and vehicle measure consistency", """SELECT COUNTIF(total_pop=0) zero_pop,
  ROUND(CORR(pct_no_vehicle, 100*SAFE_DIVIDE(households_no_vehicle,households)),3) corr_svi_vs_acs,
  ROUND(AVG(pct_no_vehicle),2) avg_svi_pct, ROUND(100*SUM(households_no_vehicle)/SUM(households),2) acs_state_pct FROM D.vulnerability_tracts$""")
q("hazard join coverage", """SELECT COUNT(*) vuln_tracts, COUNTIF(h.geo_id IS NULL) no_hazard_row,
  COUNTIF(h.HRCN_EALT IS NULL AND h.geo_id IS NOT NULL) hazard_null_vals FROM D.vulnerability_tracts$ v LEFT JOIN D.hazard_tracts$ h USING(geo_id)""")
q("hazard ranges", "SELECT " + ", ".join(f"ROUND(APPROX_QUANTILES({c},4)[OFFSET(2)],4) med_{c}, ROUND(MAX({c}),2) max_{c}" for c in ["HRCN_AFREQ","HRCN_EALT","CFLD_AFREQ","CFLD_EALT","CFLD_EXPP"]) + " FROM D.hazard_tracts$")
q("care_facilities", """SELECT COUNT(*) n, COUNTIF(latitude IS NULL) no_coords, SUM(number_of_certified_beds) beds,
  APPROX_QUANTILES(number_of_certified_beds,4) bed_quartiles FROM D.care_facilities$""")
q("power_dependent_counties: top + censored", """SELECT county, medicare_benes, power_dependent_dme, power_dependent_is_censored cens, o2_services_any_dme o2, facility_esrd_dialysis_any_dme dialysis
  FROM D.power_dependent_counties$ ORDER BY power_dependent_dme DESC LIMIT 6""")
q("power: censored count + Lee", "SELECT COUNTIF(power_dependent_is_censored) censored, SUM(power_dependent_dme) total, MAX(IF(county LIKE 'Lee%', power_dependent_dme, NULL)) lee FROM D.power_dependent_counties$")
q("power: o2/dialysis censoring (=11)", "SELECT COUNTIF(o2_services_any_dme=11) o2_eq11, COUNTIF(facility_esrd_dialysis_any_dme=11) dial_eq11, COUNTIF(power_de_1 IS NULL) pde1_null, ANY_VALUE(power_de_1) pde1_example FROM D.power_dependent_counties$")
