import { SAMPLE_BQ_ROWS } from "../mocks/sampleBigQueryTables";
import { MapsGroundingChunk } from "../types/brief";
import {
  AccessStatus,
  DashboardData,
  DashboardShelter,
  MapsAccessStatus,
  prepareDashboard,
  reconcileShelterAccessibility,
  Row,
  ShelterAccessReconciliation,
} from "./dashboardData";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

export interface ShelterGoogleMapsDetail {
  shelterId: string;
  found: boolean;
  mapsName: string;
  mapsAddress: string;
  placeType: string;
  businessStatus: string;
  openHours: string;
  mapsAccess: MapsAccessStatus;
  accessibilityAttributes: string;
  notes: string;
  reconciliation: ShelterAccessReconciliation;
  groundingChunks: MapsGroundingChunk[];
  error: string | null;
}

export async function fetchShelterGoogleMaps(
  shelter: DashboardShelter,
  signal?: AbortSignal
): Promise<ShelterGoogleMapsDetail> {
  const qs = new URLSearchParams({
    shelter_id: shelter.id,
    name: shelter.label,
    address: shelter.streetAddress || shelter.address,
    city: shelter.city,
    zip_code: shelter.zip,
    bq_access: shelter.access,
  });

  try {
    const res = await fetch(`${API_BASE}/api/shelters/google-maps?${qs.toString()}`, { signal });
    if (res.ok) {
      const body = await res.json();
      const mapsAccess: MapsAccessStatus =
        body.maps_access === "YES" || body.maps_access === "NO" ? body.maps_access : "UNLISTED";
      return {
        shelterId: shelter.id,
        found: Boolean(body.found),
        mapsName: String(body.maps_name || shelter.label),
        mapsAddress: String(body.maps_address || shelter.address),
        placeType: String(body.place_type || "Not listed"),
        businessStatus: String(body.business_status || "UNKNOWN"),
        openHours: String(body.open_hours || "Not listed on Google Maps"),
        mapsAccess,
        accessibilityAttributes: String(body.accessibility_attributes || "None listed"),
        notes: String(body.notes || ""),
        reconciliation: reconcileShelterAccessibility(shelter.access, mapsAccess),
        groundingChunks: Array.isArray(body.grounding_chunks) ? body.grounding_chunks : [],
        error: body.error ? String(body.error) : null,
      };
    }
  } catch (err) {
    if (signal?.aborted) throw err;
  }

  // Fallback to /api/area/inspect if the running server process has not reloaded /api/shelters/google-maps yet
  if (shelter.position) {
    const inspectQs = new URLSearchParams({
      lat: String(shelter.position[0]),
      lng: String(shelter.position[1]),
      radius_km: "5",
      include_maps: "true",
    });
    const res = await fetch(`${API_BASE}/api/area/inspect?${inspectQs.toString()}`, { signal });
    if (res.ok) {
      const body = await res.json();
      const live = body.google_maps_live || {};
      const summary = String(live.summary || "");
      const lower = summary.toLowerCase();
      let mapsAccess: MapsAccessStatus = "UNLISTED";
      if (lower.includes("not wheelchair") || lower.includes("no wheelchair")) {
        mapsAccess = "NO";
      } else if (lower.includes("wheelchair-accessible") || lower.includes("wheelchair accessible")) {
        mapsAccess = "YES";
      }
      const statusMatch = summary.match(/\b(OPERATIONAL|CLOSED_PERMANENTLY|CLOSED_TEMPORARILY)\b/i);
      const hoursMatch = summary.match(/(?:hours|open)[^.\n]*[:\-]\s*([^.\n]+)/i);
      return {
        shelterId: shelter.id,
        found: Boolean(live.grounding_chunks?.length),
        mapsName: live.grounding_chunks?.[0]?.title?.replace(/\s*-\s*Google Maps$/i, "") || shelter.label,
        mapsAddress: shelter.address,
        placeType: "Shelter / Public Facility",
        businessStatus: statusMatch ? statusMatch[1].toUpperCase() : "OPERATIONAL",
        openHours: hoursMatch ? hoursMatch[1].trim() : "See Google Maps place listing",
        mapsAccess,
        accessibilityAttributes:
          mapsAccess === "YES"
            ? "Wheelchair-accessible entrance"
            : mapsAccess === "NO"
            ? "No wheelchair-accessible entrance listed"
            : "Not listed on Google Maps",
        notes: summary,
        reconciliation: reconcileShelterAccessibility(shelter.access, mapsAccess),
        groundingChunks: Array.isArray(live.grounding_chunks) ? live.grounding_chunks : [],
        error: live.error ? String(live.error) : null,
      };
    }
  }

  return {
    shelterId: shelter.id,
    found: false,
    mapsName: shelter.label,
    mapsAddress: shelter.address,
    placeType: "Not listed",
    businessStatus: "UNKNOWN",
    openHours: "Not listed on Google Maps",
    mapsAccess: "UNLISTED",
    accessibilityAttributes: "None listed",
    notes: "",
    reconciliation: reconcileShelterAccessibility(shelter.access, "UNLISTED"),
    groundingChunks: [],
    error: "Google Maps live lookup unavailable.",
  };
}

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
