# Dashboard service: the React frontend + the FastAPI dashboard API (agent/server.py) on one origin.
# The ADK agent itself is a separate Cloud Run service (evac-readiness-agent); /api/chat forwards to it.
FROM node:20-slim AS ui
WORKDIR /ui
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
ENV VITE_API_BASE_URL=""
RUN npm run build

FROM python:3.11-slim
WORKDIR /app
COPY agent/requirements.txt ./requirements.txt
COPY agent/evac_agent/requirements.txt ./requirements-agent.txt
RUN pip install --no-cache-dir -r requirements.txt -r requirements-agent.txt
COPY agent/ ./
COPY --from=ui /ui/dist ./static
ENV PORT=8080 GOOGLE_CLOUD_LOCATION=global GOOGLE_GENAI_USE_VERTEXAI=True
CMD exec uvicorn server:app --host 0.0.0.0 --port ${PORT}
