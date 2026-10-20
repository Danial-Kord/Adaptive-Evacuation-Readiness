# evac_agent — working ADK agent (deployed)

Live (public): https://evac-readiness-agent-861336771001.us-east1.run.app/dev-ui/ → pick `evac_agent`.
Cloud Run service `evac-readiness-agent`, us-east1, min-instances 1.

Scenario: helps the Lee County, FL emergency manager decide which shelters to verify and where to stage
transport for households without a car, before September.

## What's in it
| File | Role |
|---|---|
| `agent.py` | Root agent on `gemini-3.6-flash`: system instruction, custom tools, `google_maps_grounding`, Google-managed BigQuery MCP server (read-only tools) |
| `data.py` | BigQuery tools: `find_people_who_cannot_self_evacuate`, `shelter_options_for_tract`, `find_shelters`, `county_gap_report`, `equity_audit`, `record_shelter_assessment` |
| `verify.py` | `verify_shelters_live`: Grounding with Google Maps (places + routing), one building at a time. Verdicts CONFIRMED / RENAMED / CLOSED / NOT_FOUND / UNVERIFIED; accessibility accepted only when grounding metadata cites a Maps source; stores `place_id` only |
| `brief.py` | `build_readiness_brief`: the 4-segment Readiness Brief; live verdicts drop or flag shelters |
| `config.py` | Thresholds: walk 1.6 km, drive 25 km, coastal-flood share 25%; retry/backoff for shared Gemini quota |
| `../sql/derived.sql` | Derived tables: `shelters_enriched`, `tract_readiness`, `care_enriched`, `counties`, `shelter_place_ids`, `shelter_assessments` |

## Modeling decisions (defend these in the deck)
- Flags are YES / NO / UNRECORDED; NULL never becomes NO.
- Pre-landfall shelters = usage EVAC/BOTH (+ unknown usage, flagged). POST capacity 0 is by design, not missing.
- Shelter site hazard = nearest tract's FEMA NRI coastal-flood exposure (shelter surge flag is 97% blank in Lee).
- Evacuation-zone tract = ≥25% of residents exposed to coastal flooding, or ≥10% mobile homes ("run from water, hide from wind").
- Need score = within-county percentile of counts: no-vehicle households ×2, modeled mobility disability, 65+, mobile homes. No race input; race is audited after.

## Run
```bash
python -m venv .venv && .venv/bin/pip install -r agent/evac_agent/requirements.txt
cp agent/evac_agent/.env.example agent/evac_agent/.env
gcloud auth application-default login
.venv/bin/python agent/sql/build_derived.py          # after scripts/load.sh FL
cd agent && ../.venv/bin/python run_test.py "Give me the readiness brief for Lee County"
../.venv/bin/adk web                                    # local UI
```

## Deploy
```bash
cd agent && adk deploy cloud_run --project qwiklabs-gcp-04-9708a89bd955 --region us-east1 \
  --service_name evac-readiness-agent --with_ui \
  --env GOOGLE_GENAI_USE_VERTEXAI=TRUE --env GOOGLE_CLOUD_PROJECT=qwiklabs-gcp-04-9708a89bd955 \
  --env GOOGLE_CLOUD_LOCATION=global \
  --provider-args=--min-instances=1 --provider-args=--memory=2Gi --provider-args=--timeout=600 evac_agent
```

Data findings: `docs/data_findings.md`. Profiling scripts: `data/explore/`.
