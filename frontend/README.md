# Frontend

React + TypeScript + Vite frontend, implementing the approved map-centered
planning dashboard while preserving main's data explorer and Cloud Run agent:

- **Overview:** county metrics, interactive shelter map, priority tract table,
  accessibility records, and a persistent planning assistant.
- **Priority tracts / Shelters:** map-linked records and accessibility filters.
- **Planning gaps / Sources & gaps:** practical checks and five-table coverage.
- **Data Explorer:** main's table overview, schemas, filters, search, and pagination.
- **Planning assistant:** deployed `evac_agent`, formatted responses, tool names,
  timings, and Maps sources. Selecting a record can draft a question to send.

See [DATA_GAPS.md](DATA_GAPS.md) for the field-by-field data coverage and backend
handoff requirements. No backend code or database schema is changed by this UI.

## Start locally

Use Node.js 20+ and npm. From the repository root:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173, or the URL printed by Vite. Keep the terminal
running; changes reload automatically. Press Ctrl+C to stop.

## Start the local API for live BigQuery data

The overview and table explorer call the local FastAPI server on port 8080. Configure the
repository-root `.env` with your team's `GOOGLE_CLOUD_PROJECT`, `BQ_DATASET`,
and Vertex AI settings. If it does not exist, copy `.env.example` first.
The BigQuery tables must already exist in that project.

Authenticate an account with access to the project's data:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

Replace `YOUR_PROJECT_ID` with your configured project ID. In another terminal,
from the repository root, use Python 3.11+:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r agent/requirements.txt
cd agent
python -m uvicorn server:app --reload --port 8080
```

For subsequent starts, from the repository root:

```bash
cd agent
../.venv/bin/python -m uvicorn server:app --reload --port 8080
```

## Request flow

```text
Overview        → /api/admin/tables/{table}/rows → local FastAPI → BigQuery
Data Management → /api/admin/tables → local FastAPI → BigQuery
Table rows      → /api/admin/tables/{table_name}/rows → local FastAPI → BigQuery
Agent Chat      → /api/chat → local FastAPI → deployed Cloud Run evac_agent
Chat fallback   → /adk-cloud-run → Vite proxy → deployed Cloud Run evac_agent
```

The old `/api/brief` endpoint is not used. The new overview adapts the existing
base-table endpoints in `dashboardApi.ts`; aggregation, null handling, and
straight-line distances are isolated in `dashboardData.ts`.

Overview defaults to **Live BigQuery** and never silently falls back to samples.
Choose **Preview subset** explicitly for an illustrative layout without a
working backend. Preview is not full-county data and does not simulate the agent.

The table explorer falls back to sample table data when the local API is
unavailable or unsuccessful. Check its connection indicator before treating
displayed rows as live data. A running frontend alone does not verify BigQuery
connectivity. Chat can use Vite's Cloud Run proxy without the local API, subject
to network connectivity and the deployed service's availability and access rules.

## Test manually

1. Open http://localhost:8080/health to confirm the local API is running.
   This checks process health, not Google Cloud permissions.
2. Open http://localhost:5173. Overview defaults to Lee County, FL. Confirm the
   Live BigQuery indicator and retrieval time; change to Miami-Dade and verify
   records change. Use Refresh data to query again. If offline, try the clearly
   labeled Preview subset mode; there is no automatic sample substitution.
3. Toggle map layers and Recorded YES only. Pan/zoom; click a shelter or a tract
   row to open record details. Ask assistant drafts a context-aware question;
   review it and press Send. Maps verification stays pending until a live check.
4. Open Shelters and filter YES/NO/UNRECORDED. Open Sources & gaps to review
   missing inputs. On a narrow viewport the assistant stacks below the overview.
5. In **Data Explorer**, verify its independent connection status, select a
   table, and try filters, search, and pagination. Overview's county and mode do
   not change Data Explorer's own filters or fallback behavior.
6. Open http://localhost:8080/api/admin/tables to check the actual backend
   result if the frontend is showing sample data.
7. In the right-side **Planning assistant**, ask:

   > Which shelters in Lee County can take a wheelchair, and how many are unrecorded?

8. Confirm a response appears; tool names, elapsed time, and Maps attribution
   appear when supplied by the agent. Use **New Session** to start over.

Interactive local API documentation is available at http://localhost:8080/docs.

## Configuration

Vite's development proxies are defined in `vite.config.ts`:

- `/api` forwards to `http://localhost:8080`.
- `/adk-cloud-run` forwards to the deployed Cloud Run service.

For a separate API origin, set `VITE_API_BASE_URL` in `frontend/.env.local` and
restart Vite. All `VITE_` settings are public browser configuration, not secrets.
The repository-root `.env` is for Python and is not automatically loaded by Vite.

The Cloud Run proxy target can be overridden with the process environment
variable `VITE_DEPLOYED_AGENT_URL` when launching Vite. The displayed service URL
also has a constant in `src/services/agentApi.ts`; update it if changing services.

## Build

From `frontend/`:

```bash
npm run build
npm test
npm run preview
```

Build checks TypeScript and generates `dist/`. Preview serves the build on port
4173. Vite's development proxies are not configured for preview or production;
those environments need backend routing configured separately, including the
Cloud Run fallback path if used.

For details about the deployed agent, see `../agent/evac_agent/README.md`.
