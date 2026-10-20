# Eval report — 20261020-112450

Target: `https://evac-readiness-agent-861336771001.us-east1.run.app`  
Checks passed: **5/5**  
Mean judge score (1-5): **4.96**

| Case | Category | Checks | Judge | Time | Tools called |
|---|---|---|---|---|---|
| Q4_wheelchair | core | PASS | 5.0 | 27.8s | find_shelters, execute_sql_readonly |
| Q5_still_there | core | PASS | 5.0 | 25.4s | find_shelters, verify_shelters_live |
| Q6_surge_zone | core | PASS | 5.0 | 23.9s | execute_sql_readonly, county_gap_report |
| T1_not_accessible_trap | trap | PASS | 5.0 | 35.6s | find_shelters, execute_sql_readonly, verify_shelters_live |
| K6_operator_interview | capability | PASS | 4.8 | 10.5s | find_shelters |

## Q4_wheelchair — PASS

**User:** Which of Lee County's shelters can actually take a wheelchair?  

**Tools:** find_shelters → execute_sql_readonly  
**Time:** 27.8s  
**Judge:** answers 5, honesty 5, provenance 5, actionable 5, format 5 — Exemplary answer that clearly distinguishes between recorded positive, recorded negative, and unrecorded statuses while providing actionable next steps for the emergency manager.  

<details><summary>Answer</summary>

In FEMA's historical shelter registry for Lee County, 2 shelters are recorded as wheelchair-accessible, 5 are recorded as not accessible, and 93 are unrecorded. Google Maps cannot perform an area-wide accessibility audit across all shelters in a county, but specific named facilities can be checked individually live.

### Do this before September
1. **Assess 93 unrecorded shelters**: Direct shelter operators to audit step-free entrances, door widths, and restroom facilities to close the unrecorded gap.
2. **Re-inspect 5 inaccessible facilities**: Verify if structural modifications or portable ramps have been added at facilities currently logged as inaccessible.

### Evidence

| Shelter Name | Address | Recorded Wheelchair Access | Source |
| :--- | :--- | :--- | :--- |
| Dunbar High School - Pets | 3800 Edison Ave, Ft Myers | YES | FEMA record (historical) |
| South Fort Myers High School - Pets | 14020 Plantation Rd, Fort Myers | YES | FEMA record (historical) |
| Dunbar High School | 3800 Edison Ave, Fort Myers | NO | FEMA record (historical) |
| East Lee County High School - Pets | 715 Thomas Sherwin Ave S, Lehigh Acres | NO | FEMA record (historical) |
| Hertz Arena (Pet Friendly) | 11000 Everblades Pkwy, Estero | NO | FEMA record (historical) |
| Oak Hammock Middle School (Pet Friendly) | 5321 Tice St, Fort Myers | NO | FEMA record (historical) |
| Varsity Lakes Middle School (Pet Friendly) | 801 Gunnery Rd N, Lehigh Acres | NO | FEMA record (historical) |
| 93 Additional Lee County Shelters | Various Locations | UNRECORDED | FEMA record (historical) |

### What I could not tell you
1. Actual physical accessibility for 93 shelters missing ADA documentation in historical records.
2. Whether recent structural renovations have altered accessibility conditions at any of the 7 evaluated facilities.

</details>

## Q5_still_there — PASS

**User:** Is the shelter at 3751 Estero Blvd in Fort Myers Beach still there? What is it now?  

**Tools:** find_shelters → verify_shelters_live  
**Time:** 25.4s  
**Judge:** answers 5, honesty 5, provenance 5, actionable 5, format 5 — Excellent response that perfectly meets all criteria, clearly distinguishing historical FEMA data from live Google Maps verification with source links.  

<details><summary>Answer</summary>

Yes, the building at 3751 Estero Blvd in Fort Myers Beach is still there and actively operates as **St Peter Lutheran Church**.

### Evidence

| Field | FEMA Registry Record | Live Google Maps Status |
| --- | --- | --- |
| **Facility Name** | St. Peter Evangelical Lutheran Church `FEMA record (historical)` | St Peter Lutheran Church `Google Maps (live, Oct 20)` |
| **Address** | 3751 Estero Blvd, Fort Myers Beach `FEMA record (historical)` | 3751 Estero Blvd, Fort Myers Beach, FL 33931 `Google Maps (live, Oct 20)` |
| **Operational Status** | Pre-landfall EVAC shelter (capacity: 100) `FEMA record (historical)` | Operational Lutheran church `Google Maps (live, Oct 20)` |
| **Site Flood Hazard** | Located in flood hazard area `FEMA record (historical)` | Coastal barrier island location `Google Maps (live, Oct 20)` |
| **Accessibility** | Unrecorded `FEMA record (historical)` | Wheelchair-accessible entrance, parking lot, and restroom `Google Maps (live, Oct 20)` |

Sources: Google Maps — [St Peter Lutheran Church - Google Maps](https://maps.google.com/maps?cid=7873256212473370103)

### What I could not tell you
1. Whether the facility maintains an active operational agreement with Lee County Emergency Management for upcoming emergency shelter activations.
2. Whether the facility has an on-site backup emergency generator (unrecorded in FEMA records).
3. Whether wheelchair access is available unaccompanied during emergency activations.

</details>

## Q6_surge_zone — PASS

**User:** Which of my Lee County shelters are themselves in the surge zone?  

**Tools:** execute_sql_readonly → execute_sql_readonly → execute_sql_readonly → county_gap_report  
**Time:** 23.9s  
**Judge:** answers 5, honesty 5, provenance 5, actionable 5, format 5 — This is an exemplary response that clearly states the data limitation upfront, correctly identifies the tract-level NRI workaround, names the largest exposed shelters, and clearly distinguishes building elevation from tract exposure.  

<details><summary>Answer</summary>

In Lee County's historical FEMA records, only 2 shelters are recorded as sitting in a surge zone, 1 is recorded as not, and 97 are UNRECORDED. However, spatial hazard mapping (FEMA NRI) indicates that 61 of Lee County's 84 pre-landfall shelters (68 of 100 total facilities) sit on flood-hazard or coastal flood-exposed ground.

### Do this before September
1. Audit building floor elevations and surge inundation limits for the 61 pre-landfall shelters located on flood-hazard ground before designating them as primary intake facilities.
2. Complete field assessments to fill the surge zone attribute for the 97 shelters currently marked UNRECORDED in the county registry.
3. Re-evaluate evacuation staging for high-capacity sites located in tracts with 99%–100% coastal flood exposure (such as Diplomat Elementary, Riverdale High, and Heights Elementary).

### Evidence

| Category / Metric | Count | Source Tag |
| --- | --- | --- |
| Pre-landfall shelters | 84 | `FEMA record (historical)` |
| Total county shelter records | 100 | `FEMA record (historical)` |
| Registry surge flag: YES | 2 | `FEMA record (historical)` |
| Registry surge flag: NO | 1 | `FEMA record (historical)` |
| Registry surge flag: UNRECORDED | 97 | `FEMA record (historical)` |
| Pre-landfall shelters on flood-hazard ground | 61 | `FEMA NRI` |
| Shelter capacity on flood-hazard ground | 20,980 spaces | `FEMA NRI` / `FEMA record (historical)` |

#### Largest Pre-Landfall Shelters on Flood-Hazard Ground

| Shelter Name | City | Evacuation Capacity | Tract Coastal Flood Exposure | Source Tag |
| --- | --- | --- | --- | --- |
| Three Oaks Elementary School | Fort Myers | 1,715 | 36% | `FEMA NRI` |
| Skyline Elementary School | Cape Coral | 1,695 | 59% | `FEMA NRI` |
| Diplomat Elementary School | Cape Coral | 1,600 | 99% | `FEMA NRI` |
| Three Oaks Middle School | Fort Myers | 1,440 | 36% | `FEMA NRI` |
| Riverdale High School | Fort Myers | 1,150 | 99% | `FEMA NRI` |
| Heights Elementary School | Fort Myers | 1,000 | 100% | `FEMA NRI` |
| Diplomat Middle School | Cape Coral | 1,000 | 99% | `FEMA NRI` |
| Estero High School | Estero | 1,000 | 61% | `FEMA NRI` |

### What I could not tell you
1. **Building-specific finished floor elevations**: 100 shelter sites are evaluated using surrounding tract-level coastal flood exposure rather than surveyed slab heights.
2. **Recorded surge status for 97 shelters**: 97 shelter entries in the registry have an UNRECORDED surge flag.

</details>

## T1_not_accessible_trap — PASS

**User:** List the Lee County shelters that are not wheelchair accessible.  

**Tools:** find_shelters → execute_sql_readonly → verify_shelters_live  
**Time:** 35.6s  
**Judge:** answers 5, honesty 5, provenance 5, actionable 5, format 5 — The response perfectly satisfies all criteria by listing the 5 recorded 'NO' shelters, clarifying that 93 facilities are unrecorded rather than inaccessible, and clearly distinguishing historical FEMA data from live Google Maps checks.  

<details><summary>Answer</summary>

In Lee County's 100 registered shelters, 5 are explicitly recorded in historical FEMA records as not wheelchair accessible, 2 are recorded as accessible, and 93 have no accessibility evaluation on file. Live Google Maps checks show that all 5 shelters flagged as "NO" in the historical registry currently feature wheelchair-accessible entrances.

### Do this before September
1. Dispatch staff or contact facility managers at the 5 conflict sites to verify that public entrances, restrooms, and shelter spaces are accessible and unlocked during emergency activations.
2. Contact operators at the 93 unrecorded shelters to perform standardized accessibility audits before hurricane season begins.

### Evidence

| Shelter Name | Address | FEMA Record (historical) | Google Maps Check (live) |
|---|---|---|---|
| Dunbar High School | 3800 Edison Ave, Fort Myers | Not Accessible (NO) | Accessible entrance & parking |
| East Lee County High School - Pets | 715 Thomas Sherwin Ave, Lehigh Acres | Not Accessible (NO) | Accessible entrance & parking |
| Hertz Arena (Pet Friendly) | 11000 Everblades Parkway, Estero | Not Accessible (NO) | Accessible entrance, parking, restrooms & seating |
| Oak Hammock Middle School (Pet Friendly) | 5321 Tice St, Fort Myers | Not Accessible (NO) | Accessible entrance & parking |
| Varsity Lakes Middle School (Pet Friendly) | 801 Gunnery Rd N, Lehigh Acres | Not Accessible (NO) | Accessible entrance & parking |

Sources: Google Maps — [Dunbar High School - Google Maps](https://maps.google.com/maps?cid=17831356591923029432)
Sources: Google Maps — [East Lee County High School - Google Maps](https://maps.google.com/maps?cid=16391947218143422414)
Sources: Google Maps — [Hertz Arena - Google Maps](https://maps.google.com/maps?cid=8822538137046369865)
Sources: Google Maps — [Oak Hammock Middle School - Google Maps](https://maps.google.com/maps?cid=14243397489966851907)
Sources: Google Maps — [Varsity Lakes Middle School - Google Maps](https://maps.google.com/maps?cid=449037957942695092)

*Note: The 2 shelters recorded as wheelchair accessible in FEMA records are Dunbar High School - Pets (3800 Edison Ave, Fort Myers) and South Fort Myers High School - Pets (14020 Plantation Rd, Fort Myers).*

### What I could not tell you
1. The true wheelchair accessibility status of the 93 unrecorded shelters without direct operator assessment.
2. Whether accessible building entrances remain unlocked and staffed for unaccompanied wheelchair entry during shelter operations.

</details>

## K6_operator_interview — PASS

**User (turn 1):** I manage the Bonita Springs YMCA shelter on Kent Rd. I want to update our accessibility info.  
**User (turn 2):** There's a ramp at the main entrance, but it's locked after 6pm and staff have to open it.  

**Tools:** find_shelters  
**Time:** 10.5s  
**Judge:** answers 5, honesty 5, provenance 5, actionable 4, format 5 — The assistant correctly applied the policy and noted the condition, but it should ask the operator to confirm the read-back before saving and moving to the next question.  

<details><summary>Answer</summary>

Because staff assistance is required to open the entrance after 6:00 PM, a wheelchair user cannot enter independently at all times. I will record unaccompanied wheelchair access as **NO** and note that staff must unlock the ramp entrance after 6:00 PM.

**Question 2:**
Is there a step-free entrance available whenever the shelter is operational?

</details>
