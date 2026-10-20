# Equity Audit Results: Does the FEMA Registry Gap Track Social Vulnerability?

> **Script**: [`data/audit/equity_audit.py`](../data/audit/equity_audit.py)  
> **SQL Queries**: [`01_tract_to_shelter_distance.sql`](../data/sql/01_tract_to_shelter_distance.sql), [`02_unrecorded_accessibility_gap.sql`](../data/sql/02_unrecorded_accessibility_gap.sql)

---

## 1. Research Question

Are socially vulnerable communities (`svi_score >= 0.75`) and high-disability tracts doubly penalized—first by higher evacuation need (no vehicle, mobile homes, disability, advanced age), and second by **lower rates of verified ADA-accessible shelter capacity** (`wheelchair_accessible = 'YES'`) within a 10-mile radius?

---

## 2. Methodology

1. **Spatial Join (`ST_DISTANCE`)**:
   - For every census tract in Florida (`state = 'FL'`), compute geodesic distance in miles from `ST_CENTROID(tract_geom)` to:
     - $d_{\text{any}}$: Nearest FEMA shelter regardless of `wheelchair_accessible` value.
     - $d_{\text{verified}}$: Nearest FEMA shelter where `UPPER(TRIM(wheelchair_accessible)) = 'YES'`.
2. **Accessibility Distance Penalty ($\Delta d_{\text{ADA}}$)**:
   $$\Delta d_{\text{ADA}} = d_{\text{verified}} - d_{\text{any}}$$
3. **Stratification by SVI Quartile**:
   - Group tracts into SVI quartiles ($Q_1$: Least Vulnerable to $Q_4$: Most Vulnerable, `svi_score >= 0.75`) and compare mean/median $\Delta d_{\text{ADA}}$ and percentage of nearby shelter capacity with `UNRECORDED` accessibility.

---

## 3. Summary Table (Template — Populate via `python data/audit/equity_audit.py`)

| SVI Quartile | Tracts ($N$) | Mean Distance to Any Shelter (mi) | Mean Distance to Verified ADA Shelter (mi) | Accessibility Penalty $\Delta d_{\text{ADA}}$ (mi) | % Nearby Capacity `UNRECORDED` |
|--------------|-------------:|----------------------------------:|-------------------------------------------:|---------------------------------------------------:|-------------------------------:|
| **Q1 (Low SVI `< 0.25`)** | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |
| **Q2 (`0.25 – 0.50`)** | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |
| **Q3 (`0.50 – 0.75`)** | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |
| **Q4 (High SVI `>= 0.75`)** | *TBD* | *TBD* | *TBD* | *TBD* | *TBD* |

---

## 4. Key Limitations & Data Guardrails Documented

- **Observation Bias vs. Physical Reality**: A high `UNRECORDED` rate in FEMA's National Shelter System (`shelters`) reflects *reporting completeness* by state/county agencies, not necessarily the absence of physical wheelchair ramps. This is why live cross-verification via **Google Maps Grounding** is essential.
- **Centroid Approximation**: Tract-to-shelter distances use `ST_CENTROID(tract_geom)` straight-line geodesic distance rather than road-network routing Time-to-Shelter; coastal barriers and bridges (e.g., Sanibel Causeway, Matanzas Pass Bridge in Lee County) amplify real-world travel times beyond geodesic distance.
- **Transportation Metric Availability**: CDC PLACES `pct_lacktrpt` is `NULL` across all Florida and Texas tracts; this audit uses ACS 5-Year `households_no_vehicle` and SVI `pct_no_vehicle` (household vehicle ownership).
