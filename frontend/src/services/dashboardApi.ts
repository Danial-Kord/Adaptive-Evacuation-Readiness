import { SAMPLE_BQ_ROWS } from "../mocks/sampleBigQueryTables";
import { DashboardData, prepareDashboard, Row } from "./dashboardData";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
export const COUNTIES = [
  { name: "Lee", fips: "12071" }, { name: "Miami-Dade", fips: "12086" },
  { name: "Pinellas", fips: "12103" }, { name: "Hillsborough", fips: "12057" },
  { name: "Broward", fips: "12011" }, { name: "Duval", fips: "12031" },
];
async function readCounty(table: string, fips: string, signal: AbortSignal): Promise<Row[]> {
  const rows: Row[] = [];
  let total = 0;
  do {
    const qs = new URLSearchParams({ county: fips, limit: "500", offset: String(rows.length) });
    const res = await fetch(`${API_BASE}/api/admin/tables/${table}/rows?${qs}`, { signal });
    if (!res.ok) throw new Error(`Could not load ${table} (${res.status}). Check the local API and BigQuery permissions.`);
    const body = await res.json();
    if (!body.connected || !Array.isArray(body.rows)) throw new Error(`${table} did not return live BigQuery rows.`);
    total = body.total_matching_rows;
    if (!Number.isInteger(total) || total < 0) throw new Error(`Invalid row count for ${table}.`);
    rows.push(...body.rows);
    if (!body.rows.length && rows.length < total) throw new Error(`${table} returned an incomplete page. Refresh the data.`);
    if (rows.length > 10000) throw new Error(`County has too many ${table} rows for this browser view. Use Data Explorer.`);
  } while (rows.length < total);
  // Defend against cross-county responses without substituting another county.
  return rows.filter(r => table === "hazard_tracts" ? String(r.geo_id).startsWith(fips) : String(table === "power_dependent_counties" ? r.fips_code : r.county_fips) === fips);
}
export async function fetchDashboard(fips: string, mode: "live" | "preview", signal: AbortSignal): Promise<DashboardData> {
  const tables = ["shelters", "vulnerability_tracts", "hazard_tracts", "power_dependent_counties"];
  if (mode === "preview") {
    const rows = tables.map(table => (SAMPLE_BQ_ROWS[table] || []).filter(r => table === "hazard_tracts" ? String(r.geo_id).startsWith(fips) : String(table === "power_dependent_counties" ? r.fips_code : r.county_fips) === fips));
    return prepareDashboard(rows[0], rows[1], rows[2], rows[3], mode, ["Illustrative subset only. Preview totals do not describe the whole county."]);
  }
  const results = await Promise.allSettled(tables.map(table => readCounty(table, fips, signal)));
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const warnings: string[] = [];
  const rows = results.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    if (i < 2) throw result.reason;
    warnings.push(`${tables[i]} is unavailable. Its measures are unrecorded, not zero.`);
    return [];
  });
  if (!rows[0].length && !rows[1].length) throw new Error("No records for this county in the configured dataset. Select a loaded county.");
  return prepareDashboard(rows[0], rows[1], rows[2], rows[3], mode, warnings);
}
