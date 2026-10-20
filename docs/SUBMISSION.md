# Submission kit — deck text, video script, checklist

Every number here was verified against our BigQuery tables or a live run on 2026-10-20.
Do not use figures from older drafts (e.g. `pitch_outline.md`), several of which don't match the data.

**Live:** dashboard https://evac-dashboard-861336771001.us-east1.run.app ·
agent https://evac-readiness-agent-861336771001.us-east1.run.app/dev-ui/ (pick `evac_agent`)

---

## 1. Submission checklist (portal: https://portal.angelhack.com/a4i-console)

- [ ] **GitHub repo link** — https://github.com/Danial-Kord/Adaptive-Evacuation-Readiness (make sure `main` has the latest: merge open PRs first)
- [ ] **Google Skills (Qwiklabs) project link** — copy from the lab page (project `qwiklabs-gcp-04-9708a89bd955`)
- [ ] **Pitch deck** — the 6-slide template, filled from section 2 below; team name + team table complete
- [ ] **Pitch video** — under 3:00, screen share with narration (section 3)
- [ ] Repo is **public**; no keys or passwords committed
- [ ] Don't redeploy while recording (sessions survive, but quota and timing get unpredictable)

---

## 2. Deck text (paste into the template)

### Slide 2 — Title
**Hurricane Readiness** · *An AI planning partner that finds the people a hurricane plan forgets — before the season.*
Team [name] · Agents for Impact 2026 · Challenge 4: Adaptive Evacuation Readiness

### Slide 3 — Our Team
(fill in names, emails, filming availability, sharing)

### Slide 4 — Real-world challenge
**The plan assumes everyone can drive. The people who can't are findable months ahead.**
- After Hurricane Ian (2022), the median age of those who died was in their seventies.
- Evacuation plans quietly assume a car, a relative inland, and a working body. A large minority has none of these.
- The shelter list a county relies on is a historical federal registry: **88% of Florida's 2,793 shelters have no record of whether a wheelchair user can get in.** Unknown is not "no", but plans treat it as one or the other.
- **Who benefits:** county emergency managers writing the August readiness brief; and residents with no car, a disability, or powered medical equipment, who depend on that plan.

### Slide 5 — Our agent
**Three questions, answered in plain language, before September.**
1. **Who would struggle to leave?** Ranks neighborhoods by no-car households, 65+, mobility disability (estimated), mobile homes and coastal-flood exposure, and names each one's main need. The manager can change what matters most.
2. **Where would they go?** Separately for households with a car (live Google Maps drive time), without a car (walkable shelter, or a pickup point), and without a car with a wheelchair user (door-to-door pickup).
3. **Can we trust the shelter list?** Counts what was never recorded, finds records that contradict each other, and checks buildings live on Google Maps.
**Outcome for Lee County, FL:** 4,063 households without a car in evacuation zones have no shelter within a 1-mile walk; 61 of 84 evacuation shelters sit on high coastal-flood ground; 93 of 100 shelters have never been checked for wheelchair access; one registered shelter is literally named "INACTIVE Grace Church" and can't be found on Google Maps. Every fact is labelled historical (FEMA) or live (Google Maps), measured (Census) or estimated (CDC).

### Slide 6 — Data ecosystem
| Source | What it gives us | In BigQuery as |
|---|---|---|
| FEMA National Shelter System | 2,793 FL shelters: capacity, wheelchair, generator, surge flags | `shelters` → `shelters_enriched` |
| Census ACS + CDC SVI + CDC PLACES | per-tract no-car households, 65+, disability (modeled), mobile homes | `vulnerability_tracts` → `tract_readiness` |
| FEMA National Risk Index | per-tract hurricane and coastal-flood exposure | `hazard_tracts` |
| CMS nursing homes | 694 FL facilities with beds and coordinates | `care_facilities` → `care_enriched` |
| HHS emPOWER | residents on powered medical equipment (county-level only) | `power_dependent_counties` |
| ACS 2020 race/ethnicity (public BigQuery) | **audit only**, never a ranking input | joined at audit time |
| **Grounding with Google Maps** (places + routing) | live: still there? renamed? closed? accessible entrance? drive time | not stored (only `place_id`) |
Defects we found and handled: blank ≠ "no" (three-state flags); a Census placeholder of −666,666,666 in income; Dunbar High School recorded both accessible and not; registry county text vs coordinates.

### Slide 7 — Architecture (use the architecture slide artifact)
Coordinator agent (ADK, Gemini 3.6 Flash) → three specialist agents called as tools (AgentTool):
prioritization (Q1), destination (Q2), verification (Q3, Grounding with Google Maps). Quick facts through
Google's **managed BigQuery MCP server**. Sessions in Vertex AI Agent Engine. Agent + dashboard on Cloud Run.

---

## 3. Video script (target 2:45; record each segment separately, cut the waiting)

**0:00 – 0:20 · Hook** *(title slide or dashboard hero)*
"After Hurricane Ian, most of the people who died were in their seventies. Evacuation plans assume everyone can drive. The people who can't are findable months in advance, from public data. We built the tool that finds them, for a county emergency manager in August."

**0:20 – 0:35 · How it's built** *(architecture slide)*
"Three questions, three specialist agents and a coordinator, built with Google's Agent Development Kit and Gemini. BigQuery is the memory; Grounding with Google Maps is the eyes."

**0:35 – 1:05 · Q1 Who would struggle to leave?** *(dashboard, section 1)*
Show the hero numbers, then the ranked neighborhoods and map.
"In Lee County, half a million people live where an evacuation order would apply. Our agent ranks neighborhoods by who would struggle to leave and names the main need: near Bonita Springs it's older residents; in North Fort Myers, mobile homes."
*(Optional, if time: open the assistant, "Weight disability double", show the ranking change.)*

**1:05 – 1:40 · Q2 Where would they go?** *(section 2, Bonita Springs selected)*
"For households with a car, it's an 8-minute drive, a live Google Maps route. Without a car, there's one shelter within a mile. And for the roughly 44 households with no car and a wheelchair user, walking distance doesn't apply: they need door-to-door pickup. That's the difference between a plan and a list."

**1:40 – 2:20 · Q3 Can we trust the list?** *(section 3, then "Check these buildings on Google Maps now")*
"93 of Lee County's 100 shelters were never checked for wheelchair access. Unknown is not 'no', so we never say no. Dunbar High School is recorded as accessible and not accessible. One shelter is still registered as 'INACTIVE Grace Church': Google Maps can't find it, so it comes out of the plan."

**2:20 – 2:40 · Rigor** *(Before September checklist, then a slide)*
"Each finding becomes an assignable action: 4,063 households need pickup points, starting with these neighborhoods. We audited our own ranking: it follows need, not paperwork. And it surfaced a demographic gap we report openly rather than hide. 25 test cases, including traps like requests for personal data, run against the deployed agent."

**2:40 – 2:55 · Close**
"Next: the same agent interviews shelter operators by voice to turn 'unknown' into data. Hurricane Readiness: find them while there's still time."

**Pre-recording checklist:** hard-refresh the dashboard; open Lee County; click section 3's live check once beforehand (it takes ~20 s); keep the assistant drawer closed until you need it; record at 1440 px wide or larger.

---

## 4. Lines judges look for (say them, they're on the rubric)
- "Blank isn't 'no': 93 of 100 shelters were never assessed, and we say so."
- "Google Maps changed our answer: it removed a shelter that no longer exists and gave real drive times."
- "Reachable means: 30 minutes by car, 1 mile on foot, door-to-door if you use a wheelchair and have no car. The manager can change it."
- "We audited the ranking: priority tracts are 3.8% Black vs 8.4% in the rest of the county, likely because the ranking weights older residents and mobile homes. Recording rates are the same (8.0% vs 7.8%), so it follows need, not paperwork."
- "Power dependence is county-level only: we can say how many (7,381 in Lee), never which block."
- Limits: tract-level flood exposure (not building elevation); straight-line walking distance; disability is a CDC estimate; Florida only loaded.
