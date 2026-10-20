# Shared API Contract: ADK Backend <-> React Frontend

> **Rule for Day 1**: Neither the Agent lane (`agent/`) nor the Frontend lane (`frontend/`) may change field names in [`schemas.py`](../agent/evacuation_agent/schemas.py) or [`brief.ts`](../frontend/src/types/brief.ts) without updating this file and notifying both lanes.

---

## 1. Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check for Cloud Run readiness probes |
| `POST` | `/api/chat` | Send an emergency planner prompt and receive an ADK agent response + structured data + Google Maps grounding metadata |

---

## 2. `POST /api/chat` Request Body

```json
{
  "session_id": "planner-session-01",
  "county_fips": "12071",
  "state": "FL",
  "message": "Produce a Hurricane Readiness Brief for Lee County, FL (12071)."
}
```

---

## 3. `POST /api/chat` Response Body

```json
{
  "session_id": "planner-session-01",
  "county_fips": "12071",
  "county_name": "Lee County, FL",
  "reply_markdown": "## 1. Who Cannot Leave on Their Own ...",
  "vulnerable_tracts": [
    {
      "tract_geoid": "12071001702",
      "county_name": "Lee",
      "population": 3840,
      "svi_score": 0.91,
      "households_no_vehicle": 265,
      "pct_no_vehicle": 18.4,
      "pct_age65": 34.2,
      "pct_disability": 24.8,
      "pct_mobile_home": 41.0,
      "nearest_shelter_id": "S-12071-04",
      "nearest_shelter_name": "Hertz Arena",
      "nearest_shelter_miles": 6.4,
      "nearest_shelter_ada_status": "UNRECORDED",
      "nearest_verified_ada_miles": 14.8,
      "centroid_lat": 26.6406,
      "centroid_lng": -81.8723
    }
  ],
  "shelter_candidates": [
    {
      "shelter_id": "S-12071-01",
      "shelter_name": "Dunbar High School",
      "city": "Fort Myers",
      "county_fips": "12071",
      "evacuation_capacity": 1850,
      "post_impact_capacity": 1200,
      "ada_status": "UNRECORDED",
      "backup_power_status": "UNRECORDED",
      "pet_accommodations": "UNRECORDED",
      "in_surge_zone": false,
      "lat": 26.6358,
      "lng": -81.8384
    }
  ],
  "power_dependent_summary": {
    "county_fips": "12071",
    "county_name": "Lee",
    "power_dependent_devices": 7420,
    "power_dependent_is_censored": false,
    "nursing_homes_count": 38,
    "hospitals_count": 9,
    "hospital_beds_total": 2410
  },
  "unrecorded_Stats": {
    "total_shelters": 24,
    "ada_yes": 2,
    "ada_no": 1,
    "ada_unrecorded": 21,
    "pct_unrecorded": 87.5
  },
  "maps_grounding_chunks": [
    {
      "title": "Dunbar High School",
      "uri": "https://maps.google.com/?cid=10293847561029384756",
      "place_id": "ChIJ1234567890abcdef"
    }
  ]
}
```

---

## 4. Non-Negotiable Data & Policy Invariants

1. **Three-Way Accessibility Status (`"YES" | "NO" | "UNRECORDED"`)**:
   - `wheelchair_accessible IS NULL` in BigQuery must **always** map to `"UNRECORDED"`, never `"NO"` or `false`.
2. **Google Maps Grounding Compliance**:
   - Every item in `maps_grounding_chunks` must be rendered via `<MapsAttribution />` immediately following the claims it supports.
   - The attribution label `"Google Maps"` must use `translate="no"` and follow official typography guidelines.
   - Only `place_id` (and `review_id` if used) may be cached/persisted beyond the live session.
3. **County-Level Scale Enforcement**:
   - `power_dependent_summary` is strictly county-level (HHS emPOWER `power_dependent_counties`). Do not disaggregate or interpolate to census tracts.
   - When `power_dependent_is_censored` is `true` (raw count `11`), the UI must display `"1–10 (privacy-masked)"`.
