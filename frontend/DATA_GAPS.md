# Dashboard data coverage and missing inputs

The overview uses the existing main-branch `/api/admin/tables/{table}/rows`
endpoints. No new backend endpoint or database write is introduced. The adapters
live in `src/services/dashboardApi.ts` and `dashboardData.ts` so a later backend
contract can replace them without redesigning the interface.

## What the five base tables can support

| Base table | Fields used / available | What the dashboard can show | What is still missing |
| --- | --- | --- | --- |
| `shelters` | `shelter_id`, name, address, `county_fips`, coordinates, `usage`, `evacuation_capacity`, nullable `wheelchair_accessible`, `generator_onsite`, `in_surge_slosh_area`, `is_medical` | Registered sites, recorded capacity, medical-needs count, YES/NO/UNRECORDED documentation breakdown, map markers and selection details | Current occupancy and opening status; verified entrances, toilets, access hours, staffing, current backup power, assessment dates. The historical `shelter_status_code` does not establish operational status. |
| `vulnerability_tracts` | `geo_id`, `county_fips`, `lat`, `lon`, `households_no_vehicle`, `pct_age_65_plus`, `pct_disability`; other ACS/SVI/PLACES measures available | Tract centroid points, priority table, demographic context, measured household counts | Tract polygons, pickup points, actual ability to obtain a ride, individual evacuation needs. `pct_lacktrpt` is unreported for FL/TX. Percentages describe different populations and must not be summed. |
| `hazard_tracts` | `geo_id`, `HRCN_EALP`, `CFLD_EALP`; historical hazard exposure/frequency fields available | Selected tract's historical expected annual population loss, joined by `geo_id` | Live storm forecast/track, forecast uncertainty, official evacuation-order boundaries, event-specific inundation. Some tract identifiers do not match across vintages. Missing joins are not zero hazard. |
| `power_dependent_counties` | `fips_code`, `power_dependent_dme`, `power_dependent_is_censored` | County-level Medicare beneficiary metric; suppression displayed as 1–10 | Tract-level or individual equipment users, device runtime, battery capacity, household backup power and transport requirements. These cannot be inferred by spreading county totals across tracts. |
| `care_facilities` | CMS facility names, addresses, coordinates, `number_of_certified_beds` | Available for inspection through Data Explorer | Base API lacks a reliable county assignment: its county filter matches city names. A spatial county join is needed before showing county facility counts. Certified beds are not current vacant beds; assisted living, transfer agreements and generator readiness are absent. |

The frontend does not infer nursing-home county membership from city names and
therefore does not show a fabricated county facility total.

## Features from the design image

| Feature | Current implementation | Data needed to complete it |
| --- | --- | --- |
| Shelter count and capacity cards | County rows loaded with pagination and aggregated in browser. Capacity sums known values; missing count is displayed. | Server-side aggregates would reduce request volume and ensure a consistent snapshot for larger datasets. |
| Accessibility breakdown | Historical three-way documentation counts, not a certification of accessibility. | Timestamped operator assessments or field audits for verified physical access. |
| Medical power card | County-level only; missing/error = unrecorded, never zero. | No extra data needed for published county counts. Finer-scale estimates would require a separately justified source; no individual data should be collected here. |
| Geographic shelter map | Leaflet map with OpenStreetMap basemap, real point coordinates, pan/zoom, filters and selected records. | Browser network access for basemap tiles. No Maps key is required for this basemap. Source coordinate discrepancies still require verification. |
| Shaded priority tract polygons | Deliberately represented by centroid markers instead of invented boundaries. | Census tract GeoJSON / vector tiles matched to the same vintage as `geo_id`, plus a documented styling metric. |
| Priority ranking | Descending ACS no-vehicle household count; missing counts sort last. Top 15 mapped; top 5/50 listed. | Expose main agent's `tract_readiness.priority_score` if the UI should use the agent's combined need/exposure methodology. The current ranking is explicitly not an evacuation order or a hazard score. |
| Distance to accessible shelter | Haversine straight-line km to a recorded YES, EVAC/BOTH shelter within the loaded county. Unknown usage and POST-only records excluded. | Routing for drive time; broader candidate query for cross-county shelters. NULL means no eligible geolocated candidate, not proof that no accessible building exists. |
| Shelter verification | Pending until an actual live agent check; selecting a record can draft a chat question. | Maps grounding at runtime with supporting sources; operator assessment for physical accessibility that Maps cannot confirm. |
| Agent/map interaction | Map or table selection opens details; Ask assistant drafts a question for review and Send. Main Cloud Run chat, sessions, tool metadata and attribution remain. | Structured response actions would enable agent replies to select map records automatically. Parsing free text into coordinates is not implemented. |
| Buses, drivers and staging resources | Not displayed as known inventories. | Timestamped resource inventory, availability, capabilities, seating/wheelchair capacity, locations and allocation rules. |
| Available / full shelter status | Not displayed. | Authorized operational shelter feed with timestamps, occupancy and actual usable capacity. |
| Number of people who must evacuate | Not inferred from household counts or overlapping demographic groups. | Official planning scenarios/zones and a defined, validated estimate methodology. |
| Nursing home layer | Base records remain accessible in Data Explorer. | Reliable county/spatial join and documented facility scope. Do not relabel the federal nursing-home roster as all care facilities. |

## Existing derived data in main

`agent/sql/derived.sql` already defines `counties`, `shelters_enriched`,
`tract_readiness`, and `care_enriched`, as well as assessment/place-ID tables.
These are outside the five base-table explorer endpoints. Exposing them through
an agreed structured dashboard API would reuse the agent's rankings, county
assignment, and distance methodology rather than duplicating them in the UI.
Do not treat saved Maps content as a durable dashboard database; follow the
project's grounding attribution and retention requirements.

## Current scope and display rules

- Picker is limited to six named Florida counties with explicit FIPS codes,
  matching the existing Florida agent scope. This does not claim other counties
  are missing from the database. A future county-list API can make it dynamic.
- Live mode never silently substitutes sample data. Missing required shelter or
  tract queries produce Retry; optional hazard or power failures show coverage
  notes and unknown values.
- Preview is explicit and uses only a county-filtered subset of main's existing
  sample table rows. Its totals are labeled illustrative, never full-county
  figures. Preview does not simulate the agent: chat still calls the live service.
- Counts and percentages remain distinct; unknown flags stay UNRECORDED. Zero
  capacity is retained, including valid POST records; it is not recoded to null.
- The query timestamp is the browser retrieval time, not a federal source update
  timestamp. Source freshness needs explicit per-dataset provenance metadata.
- Base table paging currently lacks a shared database snapshot / stable sort.
  Avoid concurrent table replacement while loading; a future aggregate endpoint
  should provide consistent pagination or snapshot semantics.
- Main's Data Explorer retains its own live/sample connection indicator and
  filters. The overview's county and data-mode controls do not alter the explorer.

Map setup follows [Leaflet's quick start](https://leafletjs.com/examples/quick-start/)
and uses browser-loaded tiles with visible [OpenStreetMap attribution](https://operations.osmfoundation.org/policies/tiles/).
