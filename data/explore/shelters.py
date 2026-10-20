from bqh import q
flags = ["wheelchair_accessible","generator_onsite","self_sufficient_electricity","in_surge_slosh_area","in_100_yr_floodplain","is_medical","is_functional"]
q("shelters: boolean flags", " UNION ALL ".join(
  f"SELECT '{f}' flag, COUNTIF({f}) n_yes, COUNTIF(NOT {f}) n_no, COUNTIF({f} IS NULL) unrecorded FROM D.shelters$" for f in flags))
for c in ["usage","shelter_status_code","population_code","pet_accommodations_code"]:
    q(f"shelters.{c}", f"SELECT {c}, COUNT(*) n FROM D.shelters$ GROUP BY 1 ORDER BY n DESC LIMIT 8")
q("capacity / coords / county", """SELECT COUNTIF(evacuation_capacity IS NULL) cap_null, COUNTIF(evacuation_capacity=0) cap_zero,
  APPROX_QUANTILES(evacuation_capacity,4) cap_quartiles, COUNTIF(latitude IS NULL) no_coords,
  COUNTIF(county_name IS NULL) no_county, COUNTIF(incident_id IS NOT NULL) has_incident, COUNT(DISTINCT incident_id) n_incidents FROM D.shelters$""")
q("biggest capacities", "SELECT shelter_name, city, county_name, evacuation_capacity evac_cap, post_impact_capacity post_cap, usage FROM D.shelters$ ORDER BY evacuation_capacity DESC LIMIT 6")
q("county_parish vs derived county_name", "SELECT county_parish, county_name, COUNT(*) n FROM D.shelters$ GROUP BY 1,2 HAVING UPPER(county_parish) != UPPER(REPLACE(county_name,' County','')) ORDER BY n DESC LIMIT 8")
q("Lee County sample", "SELECT shelter_name, address_1, city, evacuation_capacity cap, wheelchair_accessible wc, generator_onsite gen, in_surge_slosh_area surge, is_medical med, usage FROM D.shelters$ WHERE county_name LIKE 'Lee%' LIMIT 10")
