# Frontend

React + TypeScript + Vite frontend, following the current `main` design:

- **Data Management (BigQuery):** table overview, schemas, filters, search, and pagination.
- **Agent Chat (Cloud Run):** deployed `evac_agent`, formatted responses, tool names, timings, and Maps sources.

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

The table explorer calls the local FastAPI server on port 8080. Configure the
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
Data Management → /api/admin/tables → local FastAPI → BigQuery
Table rows      → /api/admin/tables/{table_name}/rows → local FastAPI → BigQuery
Agent Chat      → /api/chat → local FastAPI → deployed Cloud Run evac_agent
Chat fallback   → /adk-cloud-run → Vite proxy → deployed Cloud Run evac_agent
```

The old UI branch's `/api/brief` endpoint and readiness dashboard were removed
when rebasing onto main. They are not part of the active interface.

The table explorer falls back to sample table data when the local API is
unavailable or unsuccessful. Check its connection indicator before treating
displayed rows as live data. A running frontend alone does not verify BigQuery
connectivity. Chat can use Vite's Cloud Run proxy without the local API, subject
to network connectivity and the deployed service's availability and access rules.

## Test manually

1. Open http://localhost:8080/health to confirm the local API is running.
   This checks process health, not Google Cloud permissions.
2. Open http://localhost:5173. In **Data Management (BigQuery)**, verify the
   connection status, select a table, and try filters, search, and pagination.
3. Open http://localhost:8080/api/admin/tables to check the actual backend
   result if the frontend is showing sample data.
4. Switch to **Agent Chat (Cloud Run)** and ask:

   > Which shelters in Lee County can take a wheelchair, and how many are unrecorded?

5. Confirm a response appears; tool names, elapsed time, and Maps attribution
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
npm run preview
```

Build checks TypeScript and generates `dist/`. Preview serves the build on port
4173. Vite's development proxies are not configured for preview or production;
those environments need backend routing configured separately, including the
Cloud Run fallback path if used.

For details about the deployed agent, see `../agent/evac_agent/README.md`.
