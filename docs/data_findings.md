# Data findings — Florida (evacuation_readiness), profiled 2026-10-20

Scripts: `explore/shelters.py`, `explore/tracts.py`, `explore/county.py` (helper `bqh.py`).

## Shelters (2,793)
| Flag | Yes | No | Unrecorded |
|---|---:|---:|---:|
| wheelchair_accessible | 247 | 83 | 2,463 (88%) |
| generator_onsite | 207 | 268 | 2,318 |
| self_sufficient_electricity | 131 | 202 | 2,460 |
| in_surge_slosh_area | 58 | 466 | 2,269 (81%) |
| in_100_yr_floodplain | 35 | 435 | 2,323 |
| is_medical | 155 | 2,638 | 0 (derived from population_code, never null) |

- **Capacity 0 is usually not "missing".** 622 of 698 POST shelters have evacuation_capacity 0 but a post_impact_capacity — they are post-landfall sites. Genuinely missing: 529 nulls (all 332 rows with null `usage`).
- `shelter_status_code` is CLOSED for 2,788/2,793 — historical registry, carries no operational meaning.
- `pet_accommodations_code` is a blank string in 1,615 rows (defect 2: blank ≠ null).
- FEMA county field is dirty: tabs (`\tMarion`), typos (`Boward`, `Hillborough`), `Dade`. Use `county_fips`/`county_name` (derived from coordinates).
- Some coordinates disagree with the record: "Cultural Center of Charlotte County", Port Charlotte → coords in **Lee**; "Crestview Recreation Center", Pensacola/Escambia → coords in Okaloosa. Good Maps-grounding test cases.

## Reporting bias (the "measures paperwork" trap)
- 15 of 67 counties recorded **zero** wheelchair answers; no county recorded all of them.
- Hillsborough (39 answers) and Polk (23) record far more than Broward (1) or Leon (1). Any ranking on "recorded accessible" rewards Hillsborough's clerks.

## Lee County (FIPS 12071) — Hurricane Ian
- 223 tracts, 756,570 people, 215,942 aged 65+, 14,553 households with no vehicle, 39,299 mobile homes.
- 100 shelters, 34,070 evacuation spaces, 9 medical-needs.
- Wheelchair: **2 yes, 5 no, 93 unrecorded**. Surge flag: **97% unrecorded** → must use `hazard_tracts` (CFLD/HRCN) for surge exposure instead.
- 7,381 Medicare beneficiaries on power-dependent equipment (emPOWER, county-level only).
- Includes "St. Peter Evangelical Lutheran Church, 3751 Estero Blvd, Fort Myers Beach" — barrier island hit hardest by Ian. Prime live-verification example.

## Tracts (5,160) / hazard / care / power
- Percent columns are 0–100 scale. `pct_lacktrpt` is null for all FL tracts (CDC doesn't publish it for FL).
- **`median_income` = -666,666,666 in 127 tracts** — ACS sentinel for "not available", not in the README's defect list.
- 81 tracts have zero population; 82–89 have null SVI/PLACES percentages.
- SVI `pct_no_vehicle` and ACS `households_no_vehicle/households` correlate 0.90; statewide ≈6.1% of households have no vehicle.
- 46 tracts have no hazard_tracts row (2010/2020 vintage mismatch).
- care_facilities: 694 nursing homes, 84,517 certified beds, all with coordinates.
- emPOWER: no FL county censored on the headline column (all >11); 7 counties show dialysis = 11 (i.e. 1–10).
