import sampleBrief from "../mocks/sampleBrief.json";
import {
  BigQueryTableRowsResponse,
  BigQueryTablesOverviewResponse,
  SAMPLE_BQ_OVERVIEW,
  SAMPLE_BQ_ROWS,
} from "../mocks/sampleBigQueryTables";
import {
  AreaInspectResponse,
  ChatResponse,
  CountyMapPointsResponse,
  MapsGroundingChunk,
  ReadinessBriefData,
} from "../types/brief";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
export const DEPLOYED_CLOUD_RUN_URL =
  "https://evac-readiness-agent-861336771001.us-east1.run.app";

export async function fetchReadinessBrief(_state: string, _county: string): Promise<ReadinessBriefData> {
  // Returns the structured baseline brief immediately while the live agent chat handles ad-hoc queries
  return sampleBrief as ReadinessBriefData;
}

function extractMapsSourcesRecursive(
  obj: unknown,
  seenUris: Set<string>,
  out: MapsGroundingChunk[]
): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) extractMapsSourcesRecursive(item, seenUris, out);
    return;
  }
  const rec = obj as Record<string, unknown>;
  if (Array.isArray(rec.google_maps_sources)) {
    for (const src of rec.google_maps_sources) {
      if (src && typeof src === "object") {
        const s = src as Record<string, unknown>;
        const uri = typeof s.uri === "string" ? s.uri : "";
        if (uri && !seenUris.has(uri)) {
          seenUris.add(uri);
          out.push({
            place_id: (s.place_id as string) || (s.placeId as string) || null,
            title: (s.title as string) || "Google Maps Place",
            uri,
          });
        }
      }
    }
  }
  if (rec.maps && typeof rec.maps === "object") {
    const m = rec.maps as Record<string, unknown>;
    const uri = typeof m.uri === "string" ? m.uri : "";
    if (uri && !seenUris.has(uri)) {
      seenUris.add(uri);
      out.push({
        place_id: (m.placeId as string) || (m.place_id as string) || null,
        title: (m.title as string) || "Google Maps Place",
        uri,
      });
    }
  }
  for (const val of Object.values(rec)) {
    extractMapsSourcesRecursive(val, seenUris, out);
  }
}

export async function sendAgentMessage(
  message: string,
  state: string,
  county: string,
  sessionId = "manager-session-01"
): Promise<ChatResponse> {
  const contextualMessage = `[Pre-season planning context: ${county} County, ${state}] ${message}`;
  // 1. Try local FastAPI backend (/api/chat) which proxies to Cloud Run evac_agent
  try {
    const response = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: contextualMessage,
        state,
        county,
        session_id: sessionId,
      }),
    });

    if (response.ok) {
      return await response.json();
    }
  } catch {
    // Fall through to Vite proxy -> Cloud Run ADK service
  }

  // 2. Fallback: Call Cloud Run ADK service directly via Vite proxy (/adk-cloud-run)
  const t0 = performance.now();
  const userId = "emergency-manager";
  const appName = "evac_agent";

  await fetch(
    `/adk-cloud-run/apps/${appName}/users/${userId}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }
  );

  const runRes = await fetch(`/adk-cloud-run/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appName,
      userId,
      sessionId,
      newMessage: {
        role: "user",
        parts: [{ text: contextualMessage }],
      },
    }),
  });

  if (!runRes.ok) {
    const errText = await runRes.text();
    throw new Error(`Cloud Run ADK error (${runRes.status}): ${errText}`);
  }

  const events = (await runRes.json()) as Array<Record<string, unknown>>;
  const toolsCalled: string[] = [];
  const texts: string[] = [];
  const groundingChunks: MapsGroundingChunk[] = [];
  const seenUris = new Set<string>();

  for (const ev of events) {
    const content = (ev.content as Record<string, unknown>) || {};
    const parts = (content.parts as Array<Record<string, unknown>>) || [];
    for (const part of parts) {
      if (part.functionCall && typeof part.functionCall === "object") {
        const fnName = (part.functionCall as Record<string, unknown>).name;
        if (typeof fnName === "string" && !toolsCalled.includes(fnName)) {
          toolsCalled.push(fnName);
        }
      } else if (typeof part.text === "string" && !part.thought) {
        texts.push(part.text);
      }
    }
    extractMapsSourcesRecursive(ev, seenUris, groundingChunks);
  }

  const elapsedSeconds = Number(((performance.now() - t0) / 1000).toFixed(1));

  return {
    reply: texts.length ? texts[texts.length - 1].trim() : "No response generated.",
    county,
    state,
    tools_called: toolsCalled,
    elapsed_seconds: elapsedSeconds,
    agent_url: DEPLOYED_CLOUD_RUN_URL,
    grounding_chunks: groundingChunks,
  };
}

export async function fetchBigQueryTablesOverview(): Promise<BigQueryTablesOverviewResponse> {
  try {
    const res = await fetch(`${API_BASE}/api/admin/tables`);
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Fallback to preview dataset when backend or BigQuery auth is offline
  }
  return SAMPLE_BQ_OVERVIEW;
}

export async function fetchBigQueryTableRows(params: {
  tableName: string;
  limit?: number;
  offset?: number;
  county?: string;
  search?: string;
  quickFilter?: string;
}): Promise<BigQueryTableRowsResponse> {
  const { tableName, limit = 50, offset = 0, county = "", search = "", quickFilter = "" } = params;
  const qs = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (county) qs.set("county", county);
  if (search) qs.set("search", search);
  if (quickFilter) qs.set("quick_filter", quickFilter);

  try {
    const res = await fetch(`${API_BASE}/api/admin/tables/${encodeURIComponent(tableName)}/rows?${qs.toString()}`);
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Fallback to local sample rows when backend or BigQuery auth is offline
  }

  const tableMeta = SAMPLE_BQ_OVERVIEW.tables.find((t) => t.table_name === tableName);
  let rows = [...(SAMPLE_BQ_ROWS[tableName] || [])];

  if (search.trim()) {
    const q = search.trim().toLowerCase();
    rows = rows.filter((r) =>
      Object.values(r).some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(q))
    );
  }

  if (quickFilter) {
    if (tableName === "shelters") {
      if (quickFilter === "ada_unrecorded") rows = rows.filter((r) => r.wheelchair_accessible === null);
      if (quickFilter === "ada_yes") rows = rows.filter((r) => r.wheelchair_accessible === true);
      if (quickFilter === "ada_no") rows = rows.filter((r) => r.wheelchair_accessible === false);
      if (quickFilter === "medical") rows = rows.filter((r) => r.is_medical === true);
      if (quickFilter === "surge") rows = rows.filter((r) => r.in_surge_slosh_area === true);
    } else if (tableName === "vulnerability_tracts") {
      if (quickFilter === "high_no_vehicle") rows = rows.filter((r) => Number(r.pct_no_vehicle || 0) >= 15);
      if (quickFilter === "high_disability") rows = rows.filter((r) => Number(r.pct_disability || 0) >= 20);
    } else if (tableName === "power_dependent_counties") {
      if (quickFilter === "censored") rows = rows.filter((r) => r.power_dependent_is_censored === true);
    }
  }

  const whereParts: string[] = [];
  if (quickFilter === "ada_unrecorded") whereParts.push("wheelchair_accessible IS NULL");
  if (quickFilter === "ada_yes") whereParts.push("wheelchair_accessible IS TRUE");
  if (quickFilter === "ada_no") whereParts.push("wheelchair_accessible IS FALSE");
  if (quickFilter === "medical") whereParts.push("is_medical IS TRUE");
  if (quickFilter === "surge") whereParts.push("in_surge_slosh_area IS TRUE");
  if (quickFilter === "censored") whereParts.push("power_dependent_is_censored IS TRUE");
  if (search.trim()) whereParts.push(`/* search: '${search.trim()}' */`);

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")} ` : "";
  const sql = `SELECT * FROM \`${SAMPLE_BQ_OVERVIEW.project}.${SAMPLE_BQ_OVERVIEW.dataset}.${tableName}\` ${whereClause}LIMIT ${limit} OFFSET ${offset}`;

  return {
    connected: false,
    table_name: tableName,
    project: SAMPLE_BQ_OVERVIEW.project,
    dataset: SAMPLE_BQ_OVERVIEW.dataset,
    total_matching_rows: rows.length,
    limit,
    offset,
    executed_sql: sql,
    columns: tableMeta?.columns || [],
    rows: rows.slice(offset, offset + limit),
  };
}

export async function fetchCountyMapPoints(county: string): Promise<CountyMapPointsResponse> {
  const res = await fetch(`${API_BASE}/api/area/map-points?county=${encodeURIComponent(county)}`);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to fetch map points (${res.status}): ${errText}`);
  }
  return res.json();
}

export async function fetchAreaInspection(params: {
  lat: number;
  lng: number;
  radiusKm?: number;
  includeMaps?: boolean;
}): Promise<AreaInspectResponse> {
  const { lat, lng, radiusKm = 15, includeMaps = true } = params;
  const qs = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    radius_km: String(radiusKm),
    include_maps: String(includeMaps),
  });
  const res = await fetch(`${API_BASE}/api/area/inspect?${qs.toString()}`);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to inspect area (${res.status}): ${errText}`);
  }
  return res.json();
}


