# evac_agent — multi-agent evacuation readiness (deployed)

Live (public): https://evac-readiness-agent-861336771001.us-east1.run.app/dev-ui/ → pick `evac_agent`.
Cloud Run service `evac-readiness-agent`, us-east1, min-instances 1. Model: `gemini-3.6-flash`.

## Architecture: one coordinator, three specialists — one per question the manager asks

```
Emergency manager
      │
Coordinator (evac_readiness_coordinator)
  routes, chains, writes the answer · BigQuery MCP for quick facts · county_gap_report · operator interviews
  ├── prioritization_agent  Q1  Which tracts in Florida should we prioritize, and why?
  │     rank_priority_tracts · set_priority_weights · equity_audit
  ├── destination_agent     Q2  Where would those people go, and can they get there?
  │     plan_destinations · set_reachability_rules · find_shelters
  └── verification_agent    Q3  Is the record accurate and up to date?
        data_quality_report · verify_shelters_live (Grounding with Google Maps) · google_maps
```

Routing, from the manager's point of view:
| Question shape | Who answers | Why |
|---|---|---|
| Active emergency ("hitting now, where do I send this family") | Coordinator, instantly, no tools | 911 / county EOC. A planning tool must not pretend to know what's open today |
| Quick fact ("Florida's total shelter capacity") | Coordinator + BigQuery MCP | One query; no reason to wait on three agents |
| Q1 / Q2 / Q3 | The matching specialist | Each owns its tools and rules |
| Full brief / "walk me through it" | Q1 → Q2 (with Q1's tract ids) → Q3 | The presentation flow |

## Q1 — scoring (manager-adjustable)
Each tract gets **0–100 points per factor** = its statewide percentile in Florida:
no-car households 📊, residents 65+ 📊, adults with a mobility disability 🧮, mobile homes 📊,
coastal-flood exposure 🌊. **Priority points** = weighted average (default weights: no-car ×2, others ×1 —
no-car is the measured signal of not being able to leave). **Main need** = the tract's highest-scoring
people factor ("no car: needs organized transport", …). **Gate:** only tracts an evacuation order would
target are ranked (≥25% coastal-flood exposure or ≥10% mobile homes) — "run from water, hide from wind".
`set_priority_weights` changes weights for the conversation; `equity_audit` checks the result.

## Q2 — reachability (manager-adjustable)
| Household | Reachable if… | Distance label |
|---|---|---|
| Has a car | ≤ 30 min drive | 🚗 Google Maps drive time |
| No car | ≤ 1 mile walk (~20 min with a go-bag) | 📏 straight-line |
| No car + mobility disability | nothing is walkable → door-to-door pickup (counted, 🧮 modeled) | — |

**Surge rule:** shelters FEMA records inside the storm surge zone are excluded. Shelters on tracts with
≥25% coastal-flood exposure stay in but are flagged "confirm elevation" (excluding them would delete 62%
of Lee County's capacity on a tract-level proxy). Shelters with no recorded capacity are not counted.
`set_reachability_rules` changes the drive/walk limits for the conversation.

## Q3 — accuracy and freshness
- `data_quality_report`: unrecorded counts per field, self-contradicting records (e.g. Dunbar High School:
  wheelchair YES in one record, NO in another), suspicious records (name says INACTIVE, 0 capacity,
  county text vs coordinates), reporting bias (15 counties recorded zero wheelchair answers).
- `verify_shelters_live`: one building at a time against Google Maps — CONFIRMED / RENAMED / CLOSED /
  NOT_FOUND / DIFFERENT_PLACE / FOUND_AT_DIFFERENT_ADDRESS / UNVERIFIED. Accessibility is accepted only
  when Gemini's grounding metadata cites a Maps source; only `place_id` is stored.

## Labels on every fact
🕰️ FEMA record (historical) · 🟢 Google Maps (live) · 📊 measured (Census) · 🧮 modeled (CDC) ·
🌊 FEMA hazard model · ❓ unrecorded (never "no") · 🗺️ county-level only · 📏 straight-line · 🚗 Google Maps drive time

## Sessions survive redeploys
Conversations are stored in a Vertex AI Agent Engine session store
(`projects/861336771001/locations/us-central1/reasoningEngines/4476142897879580672`), not in server
memory, so a redeploy or restart no longer breaks an open chat. **Always deploy with
`--session_service_uri`** (below); without it ADK falls back to in-memory sessions.

## Run / deploy / evaluate
```bash
python -m venv .venv && .venv/bin/pip install -r agent/evac_agent/requirements.txt
cp agent/evac_agent/.env.example agent/evac_agent/.env && gcloud auth application-default login
.venv/bin/python agent/sql/build_derived.py              # after scripts/load.sh FL
cd agent && ../.venv/bin/python run_test.py "Which census tracts in Florida should we prioritize, and why?"
adk deploy cloud_run --project qwiklabs-gcp-04-9708a89bd955 --region us-east1 \
  --service_name evac-readiness-agent --with_ui \
  --session_service_uri "agentengine://projects/861336771001/locations/us-central1/reasoningEngines/4476142897879580672" \
  --env GOOGLE_GENAI_USE_VERTEXAI=TRUE --env GOOGLE_CLOUD_PROJECT=qwiklabs-gcp-04-9708a89bd955 \
  --env GOOGLE_CLOUD_LOCATION=global \
  --provider-args=--min-instances=1 --provider-args=--memory=2Gi --provider-args=--timeout=600 evac_agent
python evals/run_evals.py                                 # 25 cases vs the deployed agent
```
