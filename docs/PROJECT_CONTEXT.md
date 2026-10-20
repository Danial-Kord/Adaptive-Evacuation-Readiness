# Project context — Adaptive Evacuation Readiness (A4I 2026, Challenge 4)

Handoff notes for teammates **and their coding agents**: what we built, what we decided and why, what
state it's in, and what's left. Read this before changing the agent. Last updated 2026-10-20.

> Secrets are deliberately not in this file (lab password, API keys, phone numbers). Never commit them.

---

## 1. The goal

**Scenario:** *Our agent helps a Florida county emergency manager (worked example: Lee County, where
Hurricane Ian hit) decide which neighborhoods to prioritize, where their people would go, and which
shelter records to fix — in August, before the season.* Planning only, never emergency response.

**The presentation flow (3 questions = 3 agents = the 3-minute video):**
1. Which census tracts in Florida should we prioritize for evacuation-readiness planning, and why?
2. Where would those people go, and can they actually get there (no car? wheelchair and no car?)
3. How do we know the data is accurate and up to date?

**Judging** (from the challenge README, scored from repo + Qwiklabs project + 6-slide deck + <3 min
video, no Q&A): Impact 30 · Technical execution 30 · Rigor & judgment 25 · Craft 15 · Bonus range +10.
Required: ADK + Gemini 3.x, ≥1 tool we built, ≥1 Google-managed MCP server, deployed to Google Cloud,
**Grounding with Google Maps genuinely called and acted on**, Maps attribution shown. The deck template
asks for a multi-agent (ADK/MCP) diagram, so the system is multi-agent.

---

## 2. What's built and where

| Thing | Where |
|---|---|
| Live agent (public, ADK web UI) | https://evac-readiness-agent-861336771001.us-east1.run.app/dev-ui/ → pick `evac_agent` |
| Agent code (multi-agent) | `agent/evac_agent/` — **branch `agent`** (main has the older single-agent version until merged) |
| Derived BigQuery tables (SQL) | `agent/sql/derived.sql`, built by `agent/sql/build_derived.py` |
| Eval suite (25 cases) + reports | `evals/` (`python evals/run_evals.py`), reports in `evals/results/` |
| Data findings | `docs/data_findings.md`; profiling scripts in `data/explore/` |
| Future work (voice/phone assessments) | `docs/future_work.md` |
| Frontend dashboard (teammates) | `frontend/` on `main` — calls the deployed agent's `/run` API |
| Architecture slide | Claude artifact "Evacuation Readiness Architecture" (owner can export to PPTX/PDF) |

GCP: project `qwiklabs-gcp-04-9708a89bd955`, region `us-east1`, dataset `evacuation_readiness`
(loaded with `bash scripts/load.sh FL`). Model `gemini-3.6-flash` with `GOOGLE_CLOUD_LOCATION=global`
(Gemini 3 models return 404 in `us-east1`).

---

## 3. Architecture

```
Manager ─▶ Coordinator (evac_readiness_coordinator)
             • active emergency → 911 / county EOC immediately, no tools
             • quick facts → Google-managed BigQuery MCP server (execute_sql_readonly)
             • "what to fix" → county_gap_report · shelter-operator interviews → record_shelter_assessment
             • full brief → chains Q1 → Q2 (tract ids) → Q3
   ├─ prioritization_agent (Q1): rank_priority_tracts · set_priority_weights · equity_audit
   ├─ destination_agent   (Q2): plan_destinations · set_reachability_rules · find_shelters
   └─ verification_agent  (Q3): data_quality_report · verify_shelters_live · find_shelters · google_maps
```
Specialists are wrapped with ADK `AgentTool`; session state (weights, reachability rules) is shared.
Sessions are stored in a Vertex AI Agent Engine session store (us-central1), so chats survive
redeploys — deploy with `--session_service_uri` (see `agent/evac_agent/README.md`). Before this fix, a
redeploy wiped in-memory sessions and follow-up messages hit `404 session not found` (the UI just hangs).
All on `gemini-3.6-flash` with retry/backoff (the room shares Gemini quota; 429s happen).

---

## 4. Decisions and why (defend these in the deck)

**Data rules**
- Accessibility / generator / surge / floodplain flags are **YES / NO / ❓ UNRECORDED**. Blank never
  becomes "no". (88% of FL shelters, 93 of 100 in Lee, have no wheelchair answer.)
- **Pre-landfall shelters** = usage EVAC or BOTH. POST shelters have evacuation capacity 0 *by design*.
  Shelters with null or 0 capacity are not counted as usable spaces.
- **Shelter site hazard** = FEMA NRI coastal-flood exposure of the nearest tract (the shelter's own surge
  flag is 97% blank in Lee). Tract-level, not building elevation — say so.
- Use `county_fips`/`county_name` (from coordinates), not FEMA's county text (typos, tabs).
- `median_income` = −666,666,666 in 127 tracts is an ACS sentinel → excluded.

**Q1 scoring (manager can change weights in conversation)**
- Each tract gets **0–100 points per factor** = statewide percentile: no-car households 📊, residents
  65+ 📊, adults with mobility disability 🧮 (CDC PLACES, modeled), mobile homes 📊, coastal-flood share 🌊.
- Priority points = weighted average. Default weights: **no-car ×2**, others ×1 (no-car is the measured
  signal of not being able to leave).
- **Main need** = the tract's highest-scoring people factor.
- **Gate:** only tracts an evacuation order would target are ranked — ≥25% coastal-flood exposure or
  ≥10% mobile homes ("run from water, hide from wind").
- **Race is never an input.** `equity_audit` joins the ranking to ACS 2020 race data afterwards.
  Finding (Lee, top 20): priority tracts 3.8% Black vs 8.4% rest of county, 74.1% vs 65.4% white —
  likely driven by the 65+ and mobile-home weights. Recording rates are equal (8.0% vs 7.8%), so the
  ranking follows need, not paperwork. State it plainly.

**Q2 reachability (manager can change)**
| Household | Reachable if | Label |
|---|---|---|
| Has a car | ≤ 30 min drive | 🚗 Google Maps drive time |
| No car | ≤ 1 mile walk (~20 min with a go-bag) | 📏 straight-line |
| No car + mobility disability | nothing is walkable → door-to-door pickup (modeled count) | — |
- **Surge rule:** exclude shelters FEMA *records* in the surge zone; shelters on high coastal-flood
  ground stay in but are flagged "confirm elevation" (excluding them would remove 62% of Lee's capacity
  on a tract-level proxy).
- Every distance is labelled straight-line or drive time — never ambiguous.

**Q3 accuracy**
- `data_quality_report`: unrecorded counts, self-contradicting records, suspicious records, reporting
  bias (15 counties recorded zero wheelchair answers), freshness per source.
- `verify_shelters_live`: Grounding with Google Maps, **one named building at a time** (area questions
  about accessibility return nothing). Verdicts: CONFIRMED_EXISTS, RENAMED_OR_REBRANDED, CLOSED,
  NOT_FOUND_ON_MAPS, DIFFERENT_PLACE_AT_ADDRESS, FOUND_AT_DIFFERENT_ADDRESS, UNVERIFIED.
- An accessibility claim from Maps counts **only if Gemini's grounding metadata cites a Maps source**;
  an accessible entrance ≠ usable unaccompanied.
- Only `place_id` is stored (Maps terms). Hard time budget (75 s) so quota stalls return UNVERIFIED
  instead of hanging.

**Fact labels used in every answer**
🕰️ FEMA record (historical) · 🟢 Google Maps (live) · 📊 measured (Census) · 🧮 modeled (CDC) ·
🌊 FEMA hazard model · ❓ unrecorded · 🗺️ county-level only (HHS emPOWER) · 📏 straight-line · 🚗 drive time

**Answer format (designed for a busy manager who forwards answers):** bottom line first → "Do this
before September" numbered assignable actions → evidence table with labels → "What I could not tell
you" (counted) → legend. Miles and minutes; place names before tract ids; ~300 words, full brief ≤ ~700.

**Boundaries:** never identify individuals (emPOWER terms) → offer aggregates + county special-needs
registry; Florida only loaded; active emergencies → 911/EOC; no area-wide accessibility via Maps.

---

## 5. Findings worth a slide (Florida / Lee County)
- 61 of Lee's 84 pre-landfall shelters (20,980 of 34,000 spaces) sit on high coastal-flood ground.
- 4,063 no-car households in 90 Lee evacuation-zone tracts have no shelter within 1 mile.
- Lee: 7,381 power-dependent Medicare beneficiaries (county-level only); 9 medical-needs shelters,
  generator status unrecorded for all 9; 15 of 20 nursing homes on flood-hazard ground.
- **Dunbar High School** (3800 Edison Ave): wheelchair YES in one FEMA record, NO in another.
- **"INACTIVE Grace Church"** is still in the registry; Google Maps can't find it at that address.
- **Alva Middle School**: Google Maps finds "The Alva School" at a different address.
- **Cultural Center of Charlotte County**: FEMA coordinates place it in Lee; Maps: temporarily closed.
- Statewide #1 priority tract: near Hollywood, Broward (12011110354); Lee's Bonita Springs tract is #2.
- The YMCA in Bonita Springs moved; the registry address is now the city recreation center.

---

## 6. Quality status
- 25-case eval suite against the deployed agent: 22/25 on revision 7; the 3 failures were fixed and
  re-passed on revision 8 (`evals/results/`). Traps covered: blank ≠ no, area Maps questions,
  individuals, active emergency, race as input, other states, block-level power dependence.
- Known: full brief takes 1.5–2.5 min (three agents + live checks) — record demo questions separately.
- Known: Gemini occasionally returns an empty reply after a tool call → coordinator retries once.

---

## 7. Open items (as of this writing)
1. Fill the 6-slide deck (slides 4–7 still template; team name; team table).
2. Record the <3 min video (hook → architecture → Q1 → Q2 → Q3 → rigor → next step).
3. Merge `agent` → `main` (main still has the single-agent version); add a project README at repo root;
   remove or label the old `agent/evacuation_agent` skeleton.
4. Frontend: Maps attribution box reads grounding chunks, which multi-agent replies don't surface at the
   top level — the links are in the answer text; verify before recording.
5. Optional: 65+-living-alone layer (ACS B11007, needs a Census API key), voice operator interviews
   (see `docs/future_work.md`).

---

## 8. For coding agents working on this repo
- Work on the `agent` branch for agent changes; don't commit `.env` or keys.
- Rebuild derived tables after data changes: `python agent/sql/build_derived.py`.
- Test locally: `cd agent && python run_test.py "<question>"`; run evals: `python evals/run_evals.py --local --only <ids>`.
- Deploy: see `agent/evac_agent/README.md` (keep `--min-instances=1`; `requirements.txt` must be inside `evac_agent/`).
- Keep the rules in §4: three-state flags, labels, attribution, no individual data, race only as audit.
