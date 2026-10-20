import sampleBrief from "../mocks/sampleBrief.json";
import {
  BigQueryTableRowsResponse,
  BigQueryTablesOverviewResponse,
  SAMPLE_BQ_OVERVIEW,
  SAMPLE_BQ_ROWS,
} from "../mocks/sampleBigQueryTables";
import { ChatResponse, ReadinessBriefData } from "../types/brief";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

export async function fetchReadinessBrief(_state: string, _county: string): Promise<ReadinessBriefData> {
  // Returns the structured baseline brief immediately while the live agent chat handles ad-hoc queries
  return sampleBrief as ReadinessBriefData;
}

export async function sendAgentMessage(
  message: string,
  state: string,
  county: string,
  sessionId = "manager-session-01"
): Promise<ChatResponse> {
  const response = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      state,
      county,
      session_id: sessionId,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Agent API error (${response.status}): ${errText}`);
  }

  return response.json();
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

