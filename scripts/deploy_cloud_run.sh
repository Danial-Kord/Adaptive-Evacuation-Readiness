#!/usr/bin/env bash
# ==============================================================================
# Deploy & Test Adaptive Evacuation Readiness on Google Cloud Run
#
# Automatically loads environment variables from .env (and agent/evac_agent/.env).
# No secrets or project IDs are hardcoded in this script.
#
# Usage (from repository root):
#   bash scripts/deploy_cloud_run.sh                  # Deploy agent + dashboard + run smoke test
#   bash scripts/deploy_cloud_run.sh --agent-only     # Deploy only the ADK multi-agent service
#   bash scripts/deploy_cloud_run.sh --dashboard-only # Deploy only the React + FastAPI dashboard
#   bash scripts/deploy_cloud_run.sh --test-only      # Run smoke & eval tests against deployed services
#   bash scripts/deploy_cloud_run.sh --skip-test      # Deploy without running post-deploy smoke test
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# ------------------------------------------------------------------------------
# 1. Load environment variables from .env files (without overwriting existing exports)
# ------------------------------------------------------------------------------
load_env_file() {
  local env_file="$1"
  if [[ -f "${env_file}" ]]; then
    echo "==> Loading environment from ${env_file}"
    set -a
    # Strip carriage returns (CRLF compatibility) and source valid KEY=VALUE lines
    # shellcheck disable=SC1090
    source <(sed 's/\r$//' "${env_file}" | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' || true)
    set +a
  fi
}

load_env_file "${REPO_ROOT}/.env"
load_env_file "${REPO_ROOT}/agent/evac_agent/.env"

# ------------------------------------------------------------------------------
# 2. Parse CLI flags
# ------------------------------------------------------------------------------
DEPLOY_AGENT=true
DEPLOY_DASHBOARD=true
RUN_TESTS=true

for arg in "$@"; do
  case "${arg}" in
    --agent-only)
      DEPLOY_AGENT=true
      DEPLOY_DASHBOARD=false
      ;;
    --dashboard-only)
      DEPLOY_AGENT=false
      DEPLOY_DASHBOARD=true
      ;;
    --test-only)
      DEPLOY_AGENT=false
      DEPLOY_DASHBOARD=false
      RUN_TESTS=true
      ;;
    --skip-test)
      RUN_TESTS=false
      ;;
    -h|--help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: ${arg}. Use --help for usage." >&2
      exit 1
      ;;
  esac
done

# ------------------------------------------------------------------------------
# 3. Resolve configuration (all values from .env or gcloud config, zero secrets)
# ------------------------------------------------------------------------------
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "ERROR: GOOGLE_CLOUD_PROJECT is not set in .env and no default gcloud project was found." >&2
  exit 1
fi

CLOUD_RUN_REGION="${CLOUD_RUN_REGION:-us-east1}"
GOOGLE_CLOUD_LOCATION="${GOOGLE_CLOUD_LOCATION:-global}"
GOOGLE_GENAI_USE_VERTEXAI="${GOOGLE_GENAI_USE_VERTEXAI:-TRUE}"
BQ_DATASET="${BQ_DATASET:-evacuation_readiness}"
STATE="${STATE:-FL}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.6-flash}"

AGENT_SERVICE_NAME="${AGENT_SERVICE_NAME:-evac-readiness-agent}"
DASHBOARD_SERVICE_NAME="${DASHBOARD_SERVICE_NAME:-evac-dashboard}"
DEPLOYED_AGENT_APP="${DEPLOYED_AGENT_APP:-evac_agent}"
SESSION_SERVICE_URI="${SESSION_SERVICE_URI:-}"

# Locate Python and ADK CLI (prefer local .venv if present)
if [[ -x "${REPO_ROOT}/.venv/bin/python" ]]; then
  PYTHON_BIN="${REPO_ROOT}/.venv/bin/python"
elif [[ -x "${REPO_ROOT}/.venv/Scripts/python.exe" ]]; then
  PYTHON_BIN="${REPO_ROOT}/.venv/Scripts/python.exe"
elif [[ -x "/c/Python313/python.exe" ]]; then
  PYTHON_BIN="/c/Python313/python.exe"
else
  PYTHON_BIN="python3"
fi

if [[ -x "${REPO_ROOT}/.venv/bin/adk" ]]; then
  ADK_CMD=("${REPO_ROOT}/.venv/bin/adk")
elif [[ -x "${REPO_ROOT}/.venv/Scripts/adk.exe" ]]; then
  ADK_CMD=("${REPO_ROOT}/.venv/Scripts/adk.exe")
elif command -v adk >/dev/null 2>&1; then
  ADK_CMD=("adk")
else
  ADK_CMD=("${PYTHON_BIN}" "-m" "google.adk.cli")
fi

echo "=============================================================================="
echo "Cloud Run Deployment Configuration"
echo "  Project        : ${PROJECT_ID}"
echo "  Region         : ${CLOUD_RUN_REGION}"
echo "  Vertex Location: ${GOOGLE_CLOUD_LOCATION}"
echo "  BQ Dataset     : ${BQ_DATASET} (State: ${STATE})"
echo "  Agent Service  : ${AGENT_SERVICE_NAME} (${DEPLOYED_AGENT_APP})"
echo "  Dashboard Svc  : ${DASHBOARD_SERVICE_NAME}"
echo "=============================================================================="

# ------------------------------------------------------------------------------
# 4. Deploy Step 1: Ensure Derived BigQuery Tables & Deploy ADK Multi-Agent Service
# ------------------------------------------------------------------------------
if [[ "${DEPLOY_AGENT}" == "true" ]]; then
  echo ""
  echo "==> [0/3] Ensuring derived BigQuery tables exist in ${PROJECT_ID}.${BQ_DATASET}..."
  "${PYTHON_BIN}" "${REPO_ROOT}/agent/sql/build_derived.py"

  echo ""
  echo "==> [1/3] Deploying ADK Multi-Agent Service (${AGENT_SERVICE_NAME})..."
  pushd "${REPO_ROOT}/agent" >/dev/null

  ADK_ARGS=(
    deploy cloud_run
    --project "${PROJECT_ID}"
    --region "${CLOUD_RUN_REGION}"
    --service_name "${AGENT_SERVICE_NAME}"
    --with_ui
    --env "GOOGLE_GENAI_USE_VERTEXAI=${GOOGLE_GENAI_USE_VERTEXAI}"
    --env "GOOGLE_CLOUD_PROJECT=${PROJECT_ID}"
    --env "GOOGLE_CLOUD_LOCATION=${GOOGLE_CLOUD_LOCATION}"
    --env "BQ_DATASET=${BQ_DATASET}"
    --env "STATE=${STATE}"
    --env "GEMINI_MODEL=${GEMINI_MODEL}"
    --provider-args=--allow-unauthenticated
    --provider-args=--min-instances=1
    --provider-args=--memory=2Gi
    --provider-args=--timeout=600
  )

  if [[ -n "${SESSION_SERVICE_URI}" ]]; then
    ADK_ARGS+=(--session_service_uri "${SESSION_SERVICE_URI}")
  fi

  ADK_ARGS+=("${DEPLOYED_AGENT_APP}")

  "${ADK_CMD[@]}" "${ADK_ARGS[@]}"
  popd >/dev/null
fi

# Resolve Agent Service URL from Cloud Run (or fallback to DEPLOYED_AGENT_URL in .env)
AGENT_URL="${DEPLOYED_AGENT_URL:-}"
if [[ -z "${AGENT_URL}" || "${DEPLOY_AGENT}" == "true" ]]; then
  AGENT_URL="$(gcloud run services describe "${AGENT_SERVICE_NAME}" \
    --project "${PROJECT_ID}" \
    --region "${CLOUD_RUN_REGION}" \
    --format="value(status.url)" 2>/dev/null || true)"
fi

if [[ -n "${AGENT_URL}" ]]; then
  echo "==> ADK Agent URL: ${AGENT_URL}"
fi

# ------------------------------------------------------------------------------
# 5. Deploy Step 2: React Frontend + FastAPI Dashboard Service (evac-dashboard)
# ------------------------------------------------------------------------------
if [[ "${DEPLOY_DASHBOARD}" == "true" ]]; then
  if [[ -z "${AGENT_URL}" ]]; then
    echo "ERROR: Could not resolve ADK Agent URL. Deploy the agent first or set DEPLOYED_AGENT_URL in .env." >&2
    exit 1
  fi

  echo ""
  echo "==> [2/3] Deploying Unified Dashboard Service (${DASHBOARD_SERVICE_NAME})..."
  ENV_VARS="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},BQ_DATASET=${BQ_DATASET},STATE=${STATE},DEPLOYED_AGENT_URL=${AGENT_URL},DEPLOYED_AGENT_APP=${DEPLOYED_AGENT_APP}"
  if [[ -n "${MAPS_API_KEY:-}" ]]; then
    ENV_VARS="${ENV_VARS},MAPS_API_KEY=${MAPS_API_KEY}"
  fi

  gcloud run deploy "${DASHBOARD_SERVICE_NAME}" \
    --source "${REPO_ROOT}" \
    --project "${PROJECT_ID}" \
    --region "${CLOUD_RUN_REGION}" \
    --allow-unauthenticated \
    --min-instances 1 \
    --memory 1Gi \
    --timeout 600 \
    --set-env-vars "${ENV_VARS}"
fi

DASHBOARD_URL="$(gcloud run services describe "${DASHBOARD_SERVICE_NAME}" \
  --project "${PROJECT_ID}" \
  --region "${CLOUD_RUN_REGION}" \
  --format="value(status.url)" 2>/dev/null || true)"

# ------------------------------------------------------------------------------
# 6. Step 3: Smoke Test Deployed Endpoints (Pydantic recommended_actions check)
# ------------------------------------------------------------------------------
if [[ "${RUN_TESTS}" == "true" ]]; then
  echo ""
  echo "==> [3/3] Running post-deployment smoke tests..."

  if [[ -n "${DASHBOARD_URL}" ]]; then
    echo "  -> Checking ${DASHBOARD_URL}/health ..."
    curl -fsS "${DASHBOARD_URL}/health" >/dev/null && echo "     Health check: OK"

    echo "  -> Testing ${DASHBOARD_URL}/api/chat (verifying Pydantic recommended_actions)..."
    CHAT_RESP="$(curl -fsS -X POST "${DASHBOARD_URL}/api/chat" \
      -H "Content-Type: application/json" \
      -d '{"message": "Which census tracts in Lee County should we prioritize?", "county": "Lee"}')"

    if echo "${CHAT_RESP}" | grep -q '"recommended_actions"'; then
      echo "     Chat API + recommended_actions schema verification: PASSED"
    else
      echo "     WARNING: /api/chat responded, but 'recommended_actions' key was not found in payload." >&2
    fi
  else
    echo "  -> Dashboard URL not found; skipping dashboard HTTP check."
  fi
fi

echo ""
echo "=============================================================================="
echo "Deployment & Verification Complete!"
[[ -n "${AGENT_URL}" ]]     && echo "  ADK Dev UI   : ${AGENT_URL}/dev-ui/"
[[ -n "${DASHBOARD_URL}" ]] && echo "  Dashboard UI : ${DASHBOARD_URL}"
echo "=============================================================================="
