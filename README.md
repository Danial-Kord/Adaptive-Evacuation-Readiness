# Hurricane Readiness

**An AI planning partner that finds the people a hurricane plan forgets, before the season.**
Agents for Impact 2026 · Challenge 4: Adaptive Evacuation Readiness & Vulnerable Community Planning ·
Track: shelter readiness + getting people out · State: **Florida** (worked example: **Lee County**).

> *Our agent helps a Florida county emergency manager decide, in August, which neighborhoods to
> prioritize, where their people could actually go, and which shelter records to fix before September.*

| | |
|---|---|
| **Dashboard (demo)** | https://evac-dashboard-861336771001.us-east1.run.app |
| **Agent (ADK web UI)** | https://evac-readiness-agent-861336771001.us-east1.run.app/dev-ui/ → `evac_agent` |
| **Pitch kit** | [docs/SUBMISSION.md](docs/SUBMISSION.md) |
| **Design decisions & context** | [docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md) |
| **Challenge brief** | [docs/CHALLENGE_BRIEF.md](docs/CHALLENGE_BRIEF.md) |

## What it answers
1. **Who would struggle to leave?** Neighborhoods an evacuation order would cover, scored 0–100 per factor
   against all of Florida (no-car households, 65+, mobility disability (modeled), mobile homes, coastal-flood
   exposure), with each one's main need. The manager can change the weights.
2. **Where would they go?** By household: with a car (live Google Maps drive time, reachable ≤ 30 min),
   without a car (shelter within a 1-mile walk, else a pickup point), without a car and with a wheelchair user
   (door-to-door pickup). Shelters FEMA records inside the storm-surge zone are excluded.
3. **Can we trust the shelter list?** What was never recorded (93 of Lee's 100 shelters for wheelchair
   access), records that contradict themselves, and live building checks with Grounding with Google Maps.

## How it's built
```
Coordinator agent (ADK, gemini-3.6-flash)
 ├─ prioritization_agent   Q1  rank_priority_tracts · set_priority_weights · equity_audit
 ├─ destination_agent      Q2  plan_destinations · set_reachability_rules (Google Maps routing)
 ├─ verification_agent     Q3  data_quality_report · verify_shelters_live (Grounding with Google Maps)
 └─ Google-managed BigQuery MCP server for quick facts · county_gap_report · operator interviews
BigQuery (5 federal tables + derived tables) · Vertex AI Agent Engine sessions · Cloud Run (agent + dashboard)
```
| Requirement | Where |
|---|---|
| ADK + Gemini 3.x | `agent/evac_agent/agent.py` |
| Tools we built | `agent/evac_agent/{prioritize,destination,quality,verify,data}.py` |
| Managed MCP server | BigQuery MCP (`https://bigquery.googleapis.com/mcp`) in the coordinator |
| Grounding with Google Maps, acted on | `verify.py`: drops closed or moved shelters, flags renames, real drive times; accessibility accepted only when Maps is cited |
| Deployed | Cloud Run: `evac-readiness-agent`, `evac-dashboard` |

## Rules we never break
- **Unrecorded ≠ "no".** Every flag is YES / NO / UNRECORDED.
- **Every fact is labelled:** historical (FEMA) vs live (Google Maps); measured (Census) vs modeled (CDC);
  county-level only (HHS emPOWER); straight-line vs drive time.
- **Race is never a ranking input**; it is used only to audit the output ([equity audit](docs/PROJECT_CONTEXT.md)).
- **No individual-level data**; only aggregates. Google Maps content is shown, never stored (only `place_id`).
- **Planning only:** active emergencies are sent to 911 / the county EOC.

## Evidence it works
- 25-case eval suite against the deployed agent, including traps (blank ≠ no, requests for personal data, an
  active emergency, race as an input, other states): [evals/](evals/).
- Data findings and defects: [docs/data_findings.md](docs/data_findings.md).

## Limits we state openly
Flood exposure is tract-level (not building elevation) · walking distance is straight-line · disability is a CDC
estimate · power dependence is county-level · only Florida is loaded · an accessible entrance on Google Maps
isn't proof a wheelchair user can use a shelter unaccompanied. Next: voice interviews with shelter operators
([docs/future_work.md](docs/future_work.md)).

## Run it
See [agent/evac_agent/README.md](agent/evac_agent/README.md) (agent, deploy, evals) and the root `Dockerfile`
(dashboard: React frontend + FastAPI API, `gcloud run deploy evac-dashboard --source .`).
Data load: `bash scripts/load.sh FL`, then `python agent/sql/build_derived.py`.
