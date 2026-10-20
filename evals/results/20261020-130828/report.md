# Eval report — 20261020-130828

Target: `https://evac-readiness-agent-861336771001.us-east1.run.app`  
Checks passed: **2/3**  
Mean judge score (1-5): **4.87**

| Case | Category | Checks | Judge | Time | Tools called |
|---|---|---|---|---|---|
| Q1_who_struggles | core | PASS | 4.6 | 43.9s | prioritization_agent |
| Q2_power_dependent | core | PASS | 5.0 | 10.4s | execute_sql_readonly |
| Q7_what_to_fix | core | FAIL | 5.0 | 24.9s | county_gap_report |

## Q1_who_struggles — PASS

**User:** Which neighborhoods in Lee County would struggle most to self-evacuate?  

**Tools:** prioritization_agent  
**Time:** 43.9s  
**Judge:** answers 5, honesty 5, provenance 5, actionable 5, format 3 — The answer heavily relies on internal priority points and factor scores (e.g., '93.7 priority points', '92 pts'), violating the requirement to avoid internal scoring jargon.  

<details><summary>Answer</summary>

### Bottom Line
In Lee County, **tract 12071050402 near Bonita Springs** ranks highest for self-evacuation struggle with **93.7 priority points**, driven by high concentrations of older residents (📊 2,033), mobility disabilities (🧮 1,228), and 100% coastal flood exposure (🌊).

---

### Do This Before September
1. **Pre-position transport buses near Bonita Springs (tract 12071050402):** Target outreach and pickup routes for 📊 260 zero-vehicle households and 🧮 1,228 residents with mobility disabilities.
2. **Issue early evacuation advisories in North Fort Myers (tracts 12071020801 & 12071020501):** Establish direct communications with park managers covering 📊 3,113 combined mobile home units.
3. **Conduct targeted registry sign-ups in Fort Myers (tract 12071030202):** Coordinate Special Needs Registry door-to-door outreach for 🧮 1,166 residents with mobility limitations living in a 🌊 100% flood hazard zone.

---

### Evidence: Priority Neighborhood Ranking

| Location (Census Tract) | Priority Points | No Car | 65+ | Disability 🧮 | Mobile Homes | Flood 🌊 | Main Need |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **near Bonita Springs** *(12071050402)* | **93.7** | 92 pts<br>(📊 260 hh) | 96 pts<br>(📊 2,033 pop) | 95 pts<br>(🧮 1,228 pop) | 95 pts<br>(📊 855 units) | 92 pts<br>(🌊 100%) | Older residents: needs check-ins and help leaving |
| **near North Fort Myers** *(12071020801)* | **85.5** | 98 pts<br>(📊 401 hh) | 86 pts<br>(📊 1,383 pop) | 55 pts<br>(🧮 633 pop) | 99 pts<br>(📊 1,611 units) | 77 pts<br>(🌊 64%) | Mobile homes: must leave in any hurricane |
| **near Fort Myers** *(12071030202)* | **84.2** | 73 pts<br>(📊 124 hh) | 86 pts<br>(📊 1,370 pop) | 94 pts<br>(🧮 1,166 pop) | 83 pts<br>(📊 333 units) | 96 pts<br>(🌊 100%) | Mobility disability: needs accessible transport/shelter |
| **near North Fort Myers** *(12071020501)* | **83.0** | 76 pts<br>(📊 136 hh) | 95 pts<br>(📊 1,941 pop) | 77 pts<br>(🧮 838 pop) | 99 pts<br>(📊 1,502 units) | 75 pts<br>(🌊 56%) | Mobile homes: must leave in any hurricane |
| **near Bonita Springs** *(12071050401)* | **82.7** | 79 pts<br>(📊 150 hh) | 85 pts<br>(📊 1,337 pop) | 70 pts<br>(🧮 763 pop) | 86 pts<br>(📊 435 units) | 97 pts<br>(🌊 100%) | Mobile homes: must leave in any hurricane |

**Method & Weights:** Each factor score represents a statewide percentile (0–100 scale, where 100 is highest vulnerability in Florida). Priority points are computed using standard default weights: **No Car (25%)**, **Older Adults 65+ (20%)**, **Mobility Disability (20%)**, **Mobile Homes (20%)**, and **Coastal Flood Exposure (15%)**. Only tracts targeted by evacuation orders (≥25% coastal flood exposure or ≥10% mobile homes) are ranked. *Let me know if you would like to adjust these weights or audit the ranking for equity.*

---

### What I Could Not Tell You
- **Specific household vehicle access changes:** 📊 ACS Census estimates reflect survey baseline data rather than real-time vehicle ownership changes.
- **Exact mobility disability counts:** 🧮 CDC PLACES mobility figures are statistical modeled estimates, not a direct door-to-door census count.
- **Shelter reachability & transit routes:** Destination routing and drive times for these specific tracts require running a destination accessibility analysis.

---
<small>🕰️ historical FEMA record · 🟢 live Google Maps check · 📊 measured (Census) · 🧮 modeled (CDC) · 🌊 FEMA hazard model · ❓ unrecorded · 🗺️ county-level only · 📏 straight-line · 🚗 Google Maps drive time</small>

</details>

## Q2_power_dependent — PASS

**User:** How many people in Lee County depend on electricity for medical equipment?  

**Tools:** execute_sql_readonly  
**Time:** 10.4s  
**Judge:** answers 5, honesty 5, provenance 5, actionable 5, format 5 — Excellent response that directly answers the question, includes the required breakouts and HHS emPOWER source attribution, and clearly explains county-level data limitations.  

<details><summary>Answer</summary>

**Bottom Line:**
There are **7,381** Medicare beneficiaries in Lee County who depend on electricity for durable medical equipment (DME) 🗺️.

### Evidence

| Medical Power-Dependence Category | Beneficiary Count 🗺️ | Source |
| :--- | :--- | :--- |
| Power-Dependent Durable Medical Equipment (DME) | 7,381 | HHS emPOWER 🗺️ |
| Oxygen Services (Any DME) | 1,890 | HHS emPOWER 🗺️ |
| ESRD Dialysis Facility Services (Any DME) | 286 | HHS emPOWER 🗺️ |

### What I could not tell you
1. **Sub-county distribution:** Power-dependence data is tracked at the 🗺️ county-level only, so tract-level geographic distribution within Lee County is not available in this dataset.
2. **Non-Medicare population:** HHS emPOWER data tracks Medicare beneficiaries and does not account for power-dependent individuals covered solely by private insurance or Medicaid.

<small>🕰️ historical FEMA record · 🟢 live Google Maps check · 📊 measured (Census) · 🧮 modeled (CDC) · 🌊 FEMA hazard model · ❓ unrecorded · 🗺️ county-level only · 📏 straight-line · 🚗 Google Maps drive time</small>

</details>

## Q7_what_to_fix — FAIL

**User:** What should I fix before the season in Lee County?  

**Tools:** county_gap_report  
**Time:** 24.9s  
**Check failures:** missing /pickup|transport|bus/  
**Judge:** answers 5, honesty 5, provenance 5, actionable 5, format 5 — Excellent response that directly answers the question with prioritized, actionable recommendations, exact counts, named locations, and robust data provenance tags.  

<details><summary>Answer</summary>

### Bottom Line
Lee County has **20,980 pre-landfall shelter capacity 🕰️** across 61 shelters located on flood-hazard ground 🌊, while **4,063 zero-vehicle households 📊** in evacuation zones live over 1 mile 📏 from any pre-landfall shelter. Furthermore, 93 of 100 registered county shelters lack recorded wheelchair accessibility assessments ❓.

---

### Do This Before September
1. **Audit flood-hazard pre-landfall shelters**: Re-evaluate evacuation protocols for 61 pre-landfall shelters (20,980 capacity 🕰️) on flood-hazard ground 🌊 (e.g., Diplomat Middle & Elementary in Cape Coral, Heights Elementary in Fort Myers).
2. **Conduct shelter accessibility & generator assessments**: Survey operators across 93 shelters with unrecorded wheelchair access ❓ and 94 with unrecorded generator status ❓, prioritizing all 9 medical-needs shelters (2,497 capacity 🕰️) whose backup generator availability remains unrecorded ❓.
3. **Deploy targeted transit plans for carless residents**: Establish emergency shuttles for 90 evacuation-zone tracts where 4,063 zero-vehicle households 📊 have no shelter within 1 mile 📏 (start with Census Tract 12071001915: 456 carless households 📊, 4.5 miles 📏 to nearest shelter).
4. **Confirm healthcare facility evacuation & power contingencies**: Review evacuation plans for 15 nursing homes (1,569 beds) on flood-hazard ground 🌊 and confirm utility power backup plans for 7,381 power-dependent residents 🗺️ and 286 facility dialysis patients 🗺️.

---

### Evidence

| Gap Category | Findings & Impact | Data Sources & Details |
| :--- | :--- | :--- |
| **Shelter Flood Exposure** | 61 of 84 pre-landfall shelters (20,980 / 34,000 capacity 🕰️) on flood-hazard ground 🌊 | 🕰️ FEMA record · 🌊 FEMA hazard model |
| **Walking & Transit Access Gaps** | 90 evacuation tracts (4,063 zero-vehicle HHs 📊 / 263,661 pop 📊) > 1 mi 📏 from shelter | 📊 Census ACS · 📏 straight-line distance |
| **Nursing Home Risk Exposure** | 15 of 20 nursing homes (1,569 / 2,177 beds) on flood-hazard ground 🌊 | 🕰️ FEMA record · 🌊 FEMA hazard model |
| **Medical & Power Dependence** | 7,381 power-dependent residents 🗺️; 9 medical shelters (2,497 cap 🕰️) | 🗺️ HHS emPOWER · ❓ 0/9 medical shelters have recorded generators |
| **Accessibility Data Gaps** | 93 shelters missing wheelchair assessments ❓; 94 missing generator records ❓ | 🕰️ FEMA record · ❓ unrecorded fields |

---

### What I Could Not Tell You
* **Accessibility status**: 93 shelters missing wheelchair access records ❓; 94 missing generator records ❓.
* **Exact locations for power-dependent residents**: HHS emPOWER totals are county-level only 🗺️ (7,381 residents).
* **Shelter capacity & usage**: 21 shelter capacities ❓ and 12 shelter usage types ❓ remain unrecorded in the dataset.

<small>🕰️ historical FEMA record · 🟢 live Google Maps check · 📊 measured (Census) · 🧮 modeled (CDC) · 🌊 FEMA hazard model · ❓ unrecorded · 🗺️ county-level only · 📏 straight-line · 🚗 Google Maps drive time</small>

</details>
