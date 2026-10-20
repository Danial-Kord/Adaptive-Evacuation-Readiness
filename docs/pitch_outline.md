# 3-Minute Finalist Pitch & Demo Outline

> **Owner**: Story / Equity / Pitch Lead  
> **Target Duration**: 3:00 (strictly timed)  
> **Judging Weight**: Impact & Problem Framing (30%) + Technical Depth & Grounding (35%) + Equity & Responsible AI (20%) + Demo Clarity (15%)

---

## 0:00 – 0:35 | The Hook: The 88% Blind Spot

- **Opening Line**: *"When Hurricane Ian approached Lee County, Florida, emergency managers had a list of 65,000 FEMA shelter records nationwide. On paper, the county had shelter capacity. In reality, 88% of Florida's FEMA shelter records have `NULL` for wheelchair accessibility—and 99.6% have `NULL` for backup generators."*
- **Visual**: Show the **Unrecorded Registry Audit Banner** (`87.5% UNRECORDED` in Lee County) in the React app.
- **Core Thesis**: Treating `NULL` as "no" hides viable shelters; treating `NULL` as "yes" sends wheelchair users and ventilator-dependent seniors to shelters they cannot enter or survive in.

---

## 0:35 – 1:35 | Live Product Demo: Cross-Examining Static FEMA Data with Live Google Maps

1. **Select Scenario**: Click **Lee County, FL (`12071`)** (or run live prompt: *"Generate a pre-landfall Readiness Brief for Lee County ahead of a Category 4 storm with 12-ft surge."*).
2. **Section 1 — Who Cannot Leave (`WhoCannotLeave.tsx` + `CountyMap.tsx`)**:
   - Highlight Tract `12071001702` (SVI `0.91`, 265 carless households, 41% mobile homes).
   - Point out the **Accessibility Penalty**: Nearest listed shelter is 6.4 miles away (`UNRECORDED`), while the nearest *verified* ADA shelter is 14.8 miles away.
3. **Section 2 — Live Google Maps Verification (`ShelterVerification.tsx` + `MapsAttribution.tsx`)**:
   - Show how our **Google ADK Agent** (`gemini-3.6-flash`) calls BigQuery spatial tools (`ST_DISTANCE`, `ST_DWITHIN`, `ST_INTERSECTS`) and cross-checks FEMA's `UNRECORDED` shelters against **Google Maps Grounding**.
   - Point to the live `Google Maps` source link (`place_id` citation) confirming wheelchair-accessible entrance and current operating status for **Dunbar High School**, while flagging **Sanibel Community Church** inside the NOAA storm surge zone.

---

## 1:35 – 2:20 | Equity Audit & Methodological Honesty (Why Judges Can Trust It)

- **Responsible Data Science Guardrails Built Into Code**:
  1. `UNRECORDED != NO`: Explicit 3-state SQL and UI modeling (`YES`, `NO`, `UNRECORDED`).
  2. **Scale Integrity**: County-level HHS emPOWER electricity-dependent Medicare counts (`7,420` devices in Lee County) are never falsely fabricated down to tracts; privacy-censored counties (`11` = `1–10` residents) are explicitly badged.
  3. **Proxy Clarity**: Because CDC PLACES `pct_lacktrpt` is `NULL` in FL and TX, our agent transparently uses ACS `households_no_vehicle` (car ownership) and distinguishes it from transit barrier measures.
- **Equity Audit Finding**: Present our correlation finding from `data/audit/equity_audit.py` showing how high-SVI tracts face systematically longer travel distances to *verified* ADA shelters than low-SVI tracts.

---

## 2:20 – 3:00 | Pre-Season Actionable Close

- **Section 3 — Pre-Season Action Checklist (`PreSeasonGaps.tsx`)**:
  - Show the auto-generated call sheet for the County Emergency Operations Center: top 5 high-capacity shelters to audit via phone/Maps before June 1st, plus generator dispatch for 38 nursing homes and 7,420 electricity-dependent Medicare beneficiaries.
- **Closing Line**: *"We don't just map vulnerability—we turn missing federal metadata into a verified, pre-season verification workflow before the cone of uncertainty ever forms."*
