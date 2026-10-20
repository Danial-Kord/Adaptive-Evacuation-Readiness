#!/usr/bin/env bash
# ==============================================================================
# Deploy Adaptive Evacuation Readiness (ADK Backend + React Frontend) to Cloud Run
# Usage:
#   export GOOGLE_CLOUD_PROJECT="your-gcp-project-id"
#   export GOOGLE_CLOUD_LOCATION="us-central1"
#   ./scripts/deploy_cloud_run.sh
# ==============================================================================
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:?Error: GOOGLE_CLOUD_PROJECT environment variable is required}"
REGION="${GOOGLE_CLOUD_LOCATION:-us-central1}"
BQ_DATASET="${BQ_DATASET:-challenge4_evacuation}"
ADK_MODEL="${ADK_MODEL:-gemini-3.6-flash}"

BACKEND_SERVICE="evacuation-adk-agent"
FRONTEND_SERVICE="evacuation-react-ui"

echo "==> [1/2] Deploying ADK Agent Backend (${BACKEND_SERVICE}) to Cloud Run (${REGION})..."
gcloud run deploy "${BACKEND_SERVICE}" \
  --source ./agent \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --allow-unauthenticated \
  --set-env-vars="GOOGLE_GENAI_USE_VERTEXAI=TRUE,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${REGION},BQ_PROJECT=${PROJECT_ID},BQ_DATASET=${BQ_DATASET},ADK_MODEL=${ADK_MODEL}"

BACKEND_URL=$(gcloud run services describe "${BACKEND_SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format="value(status.url)")

echo "==> ADK Backend live at: ${BACKEND_URL}"

echo "==> [2/2] Deploying React Frontend (${FRONTEND_SERVICE}) to Cloud Run (${REGION})..."
gcloud run deploy "${FRONTEND_SERVICE}" \
  --source ./frontend \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --allow-unauthenticated \
  --set-build-env-vars="VITE_AGENT_API_URL=${BACKEND_URL}"

FRONTEND_URL=$(gcloud run services describe "${FRONTEND_SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --format="value(status.url)")

echo "=============================================================================="
echo "Deployment Complete!"
echo "  Backend (ADK + FastAPI): ${BACKEND_URL}"
echo "  Frontend (React + Vite): ${FRONTEND_URL}"
echo "=============================================================================="
