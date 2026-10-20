/** Pure adapters for the five base tables. No generated or sample values. */
export type Row = Record<string, unknown>;
export type AccessStatus = "YES" | "NO" | "UNRECORDED";
export const numeric = (value: unknown): number | null => {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim()) || typeof value === "boolean") return null;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
export const recordingStatus = (value: unknown): AccessStatus => value === true ? "YES" : value === false ? "NO" : "UNRECORDED";
export const displayNumber = (value: number | null) => value === null ? "Unrecorded" : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
export const coordinates = (lat: unknown, lon: unknown): [number, number] | null => {
  const a = numeric(lat), b = numeric(lon);
  return a !== null && b !== null && Math.abs(a) <= 90 && Math.abs(b) <= 180 ? [a, b] : null;
};
export function distanceKm(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180, dlat = (b[0] - a[0]) * rad, dlon = (b[1] - a[1]) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dlon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export interface MapPoint { id: string; label: string; position: [number, number] | null }
export interface DashboardShelter extends MapPoint {
  access: AccessStatus; generator: AccessStatus; surge: AccessStatus;
  capacity: number | null; medical: AccessStatus; usage: string; address: string;
}
export interface DashboardTract extends MapPoint {
  noVehicle: number | null; olderShare: number | null; disability: number | null;
  nearestAccessible: number | null; hurricaneLoss: number | null; coastalLoss: number | null;
}
export interface DashboardData {
  shelters: DashboardShelter[]; tracts: DashboardTract[];
  access: Record<AccessStatus, number>; capacity: number | null; capacityMissing: number;
  power: number | null; powerCensored: boolean; fetchedAt: string;
  source: "live" | "preview"; warnings: string[];
}
export function prepareDashboard(shelterRows: Row[], tractRows: Row[], hazardRows: Row[], powerRows: Row[], source: "live" | "preview", warnings: string[] = []): DashboardData {
  const shelters: DashboardShelter[] = shelterRows.map(r => ({
    id: String(r.shelter_id), label: String(r.shelter_name || "Unnamed shelter"),
    position: coordinates(r.latitude, r.longitude), access: recordingStatus(r.wheelchair_accessible),
    generator: recordingStatus(r.generator_onsite), surge: recordingStatus(r.in_surge_slosh_area),
    medical: recordingStatus(r.is_medical), capacity: numeric(r.evacuation_capacity),
    usage: String(r.usage || "UNRECORDED"),
    address: [r.address_1, r.city].filter(Boolean).join(", ") || "Address unrecorded",
  }));
  const eligible = shelters.filter(s => s.access === "YES" && s.position && ["EVAC", "BOTH"].includes(s.usage.toUpperCase()));
  const hazards = new Map(hazardRows.map(r => [String(r.geo_id), r]));
  const tracts: DashboardTract[] = tractRows.map(r => {
    const id = String(r.geo_id), position = coordinates(r.lat, r.lon), h = hazards.get(id);
    const distances = position ? eligible.map(s => distanceKm(position, s.position!)) : [];
    return { id, label: `Tract ${id}`, position, noVehicle: numeric(r.households_no_vehicle),
      olderShare: numeric(r.pct_age_65_plus), disability: numeric(r.pct_disability),
      nearestAccessible: distances.length ? Math.min(...distances) : null,
      hurricaneLoss: numeric(h?.HRCN_EALP), coastalLoss: numeric(h?.CFLD_EALP) };
  }).sort((a, b) => (b.noVehicle ?? -1) - (a.noVehicle ?? -1) || a.id.localeCompare(b.id));
  const access = { YES: 0, NO: 0, UNRECORDED: 0 };
  shelters.forEach(s => access[s.access]++);
  const capacities = shelters.map(s => s.capacity).filter((n): n is number => n !== null);
  const p = powerRows[0], count = numeric(p?.power_dependent_dme);
  const powerCensored = p?.power_dependent_is_censored === true || count === 11;
  const missingGeo = shelters.filter(s => !s.position).length + tracts.filter(t => !t.position).length;
  const missingHazards = tracts.filter(t => !hazards.has(t.id)).length;
  return { shelters, tracts, access, capacity: capacities.length ? capacities.reduce((a, b) => a + b, 0) : null,
    capacityMissing: shelters.length - capacities.length, power: powerCensored ? null : count, powerCensored,
    fetchedAt: new Date().toISOString(), source,
    warnings: [...warnings, ...(missingGeo ? [`${missingGeo} records have missing or invalid coordinates and cannot be plotted.`] : []),
      ...(missingHazards ? [`${missingHazards} tracts lack matching hazard records. Missing exposure is not zero risk.`] : [])] };
}
