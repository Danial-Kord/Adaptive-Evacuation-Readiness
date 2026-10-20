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
export function titleCaseCity(city: string): string {
  return city.trim().toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}
export function formatTractName(geoId: string, nearCity: string | null = null): string {
  const clean = geoId.trim();
  let base = `Tract ${clean}`;
  if (/^\d{11}$/.test(clean)) {
    const whole = Number(clean.slice(5, 9));
    const dec = clean.slice(9, 11);
    const num = dec === "00" ? String(whole) : `${whole}.${dec}`;
    base = `Census Tract ${num}`;
  }
  return nearCity ? `${base} (near ${nearCity})` : base;
}
export type MapsAccessStatus = "YES" | "NO" | "UNLISTED";
export type ResolvedAccessSource = "BigQuery" | "Google Maps" | "Unrecorded";
export interface ShelterAccessReconciliation {
  state: "MATCH" | "CONFLICT" | "FROM_GOOGLE_MAPS" | "FROM_BIGQUERY_ONLY" | "UNRECORDED";
  validationTrue: boolean | null;
  bqAccess: AccessStatus;
  mapsAccess: MapsAccessStatus;
  resolvedAccess: AccessStatus;
  resolvedSource: ResolvedAccessSource;
  badgeText: string;
  summary: string;
  detail: string;
}
export function reconcileShelterAccessibility(bqAccess: AccessStatus, mapsAccess: MapsAccessStatus): ShelterAccessReconciliation {
  if ((bqAccess === "YES" && mapsAccess === "YES") || (bqAccess === "NO" && mapsAccess === "NO")) {
    return {
      state: "MATCH",
      validationTrue: true,
      bqAccess,
      mapsAccess,
      resolvedAccess: bqAccess,
      resolvedSource: "BigQuery",
      badgeText: `♿ ${bqAccess} · Source: BigQuery`,
      summary: `${bqAccess} · Source: BigQuery (validated by Google Maps)`,
      detail: `Both sources agree: showing BigQuery (${bqAccess}), validated by Google Maps.`,
    };
  }
  if ((bqAccess === "YES" && mapsAccess === "NO") || (bqAccess === "NO" && mapsAccess === "YES")) {
    return {
      state: "CONFLICT",
      validationTrue: false,
      bqAccess,
      mapsAccess,
      resolvedAccess: mapsAccess,
      resolvedSource: "Google Maps",
      badgeText: `♿ ${mapsAccess} · Source: Google Maps`,
      summary: `${mapsAccess} · Source: Google Maps (conflict with BigQuery: ${bqAccess})`,
      detail: `Conflict between sources: showing Google Maps (${mapsAccess}); BigQuery records ${bqAccess}.`,
    };
  }
  if (bqAccess === "UNRECORDED" && (mapsAccess === "YES" || mapsAccess === "NO")) {
    return {
      state: "FROM_GOOGLE_MAPS",
      validationTrue: null,
      bqAccess,
      mapsAccess,
      resolvedAccess: mapsAccess,
      resolvedSource: "Google Maps",
      badgeText: `♿ ${mapsAccess} · Source: Google Maps`,
      summary: `${mapsAccess} · Source: Google Maps (BigQuery unrecorded)`,
      detail: `BigQuery is unrecorded: showing Google Maps accessibility result (${mapsAccess}).`,
    };
  }
  if ((bqAccess === "YES" || bqAccess === "NO") && mapsAccess === "UNLISTED") {
    return {
      state: "FROM_BIGQUERY_ONLY",
      validationTrue: null,
      bqAccess,
      mapsAccess,
      resolvedAccess: bqAccess,
      resolvedSource: "BigQuery",
      badgeText: `♿ ${bqAccess} · Source: BigQuery`,
      summary: `${bqAccess} · Source: BigQuery (unlisted on Google Maps)`,
      detail: `Showing BigQuery (${bqAccess}); Google Maps does not list wheelchair accessibility.`,
    };
  }
  return {
    state: "UNRECORDED",
    validationTrue: null,
    bqAccess,
    mapsAccess,
    resolvedAccess: "UNRECORDED",
    resolvedSource: "Unrecorded",
    badgeText: "♿ UNRECORDED",
    summary: "UNRECORDED (missing in BigQuery & Google Maps)",
    detail: "Missing in both BigQuery and Google Maps.",
  };
}

export interface ParsedDailyOperatingHours {
  is24Hours: boolean;
  isClosed: boolean;
  unlisted: boolean;
  openBlocks: boolean[]; // 24 booleans, 1 for each hour of the day (0 = 12 AM, 12 = 12 PM, etc.)
  summaryLabel: string;
}

export type DayKey = "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";
export const WEEK_DAYS: DayKey[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DAY_FULL_NAMES: Record<DayKey, string> = {
  Sun: "Sunday",
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
};

export interface DaySchedule {
  day: DayKey;
  fullName: string;
  isOpen: boolean;
  is24Hours: boolean;
  isClosed: boolean;
  startHour: number | null; // e.g. 7.5 for 7:30 AM
  endHour: number | null;   // e.g. 16.0 for 4:00 PM
  label: string;            // e.g. "7:30 AM – 4:00 PM", "Closed", "Open 24 hours"
}

export interface WeeklyOperatingSchedule {
  days: DaySchedule[];
  unlisted: boolean;
  isAll24Hours: boolean;
  isAllClosed: boolean;
  summaryLabel: string;
  yMinHour: number; // default 6 (6 AM)
  yMaxHour: number; // default 21 (9 PM)
}

function parseSingleTimeRange(str: string): {
  isOpen: boolean;
  is24Hours: boolean;
  isClosed: boolean;
  startHour: number | null;
  endHour: number | null;
  label: string;
} {
  const clean = str.trim();
  const lower = clean.toLowerCase();
  if (!clean || lower.includes("closed")) {
    return { isOpen: false, is24Hours: false, isClosed: true, startHour: null, endHour: null, label: "Closed" };
  }
  if (lower.includes("24 hour") || lower.includes("open 24")) {
    return { isOpen: true, is24Hours: true, isClosed: false, startHour: 0, endHour: 24, label: "Open 24 hours" };
  }

  const match = clean.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) {
    return { isOpen: false, is24Hours: false, isClosed: false, startHour: null, endHour: null, label: clean || "Unknown" };
  }

  let sh = parseInt(match[1], 10);
  const sm = match[2] ? parseInt(match[2], 10) / 60 : 0;
  const sAmPm = (match[3] || "").toLowerCase();

  let eh = parseInt(match[4], 10);
  const em = match[5] ? parseInt(match[5], 10) / 60 : 0;
  const eAmPm = (match[6] || match[3] || "").toLowerCase();

  if (sAmPm === "pm" && sh < 12) sh += 12;
  if (sAmPm === "am" && sh === 12) sh = 0;
  if (eAmPm === "pm" && eh < 12) eh += 12;
  if (eAmPm === "am" && eh === 12) eh = 0;

  let startHour = sh + sm;
  let endHour = eh + em;

  if (startHour > endHour) {
    // Over midnight e.g. 8 PM to 4 AM
    endHour += 24;
  }

  return {
    isOpen: true,
    is24Hours: false,
    isClosed: false,
    startHour,
    endHour,
    label: clean,
  };
}

const DAY_LOOKUP: Record<string, DayKey> = {
  sunday: "Sun", sun: "Sun",
  monday: "Mon", mon: "Mon",
  tuesday: "Tue", tue: "Tue",
  wednesday: "Wed", wed: "Wed",
  thursday: "Thu", thu: "Thu",
  friday: "Fri", fri: "Fri",
  saturday: "Sat", sat: "Sat",
};

export function parseWeeklyOperatingSchedule(text: string): WeeklyOperatingSchedule {
  const clean = (text || "").trim();
  const lower = clean.toLowerCase();

  const emptyDays = (): Record<DayKey, DaySchedule> => {
    const res: Partial<Record<DayKey, DaySchedule>> = {};
    for (const d of WEEK_DAYS) {
      res[d] = {
        day: d,
        fullName: DAY_FULL_NAMES[d],
        isOpen: false,
        is24Hours: false,
        isClosed: true,
        startHour: null,
        endHour: null,
        label: "Closed",
      };
    }
    return res as Record<DayKey, DaySchedule>;
  };

  if (!clean || lower.includes("not listed") || lower.includes("unknown") || lower === "—") {
    const dayMap = emptyDays();
    for (const d of WEEK_DAYS) {
      dayMap[d].isClosed = false;
      dayMap[d].label = "Hours not listed";
    }
    return {
      days: WEEK_DAYS.map(d => dayMap[d]),
      unlisted: true,
      isAll24Hours: false,
      isAllClosed: false,
      summaryLabel: "Hours not listed on Google Maps",
      yMinHour: 8,
      yMaxHour: 20,
    };
  }

  if (lower.includes("permanently closed") || lower === "closed") {
    const dayMap = emptyDays();
    return {
      days: WEEK_DAYS.map(d => dayMap[d]),
      unlisted: false,
      isAll24Hours: false,
      isAllClosed: true,
      summaryLabel: "Closed",
      yMinHour: 8,
      yMaxHour: 20,
    };
  }

  if (lower.includes("24 hour") || lower.includes("open 24")) {
    const dayMap = emptyDays();
    for (const d of WEEK_DAYS) {
      dayMap[d] = {
        day: d,
        fullName: DAY_FULL_NAMES[d],
        isOpen: true,
        is24Hours: true,
        isClosed: false,
        startHour: 0,
        endHour: 24,
        label: "Open 24 hours",
      };
    }
    return {
      days: WEEK_DAYS.map(d => dayMap[d]),
      unlisted: false,
      isAll24Hours: true,
      isAllClosed: false,
      summaryLabel: "Open 24 Hours Daily",
      yMinHour: 8,
      yMaxHour: 20,
    };
  }

  const dayMap = emptyDays();
  let anyMatched = false;

  // 1. Check for individual day entries e.g. "Monday: 8:00 AM – 5:00 PM, Tuesday: 8:00 AM..."
  const dayRegex = /(?:(Sunday|Sun|Monday|Mon|Tuesday|Tue|Wednesday|Wed|Thursday|Thu|Friday|Fri|Saturday|Sat))\s*[:\-]\s*([^,\n;]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = dayRegex.exec(clean)) !== null) {
    const dayKey = DAY_LOOKUP[match[1].toLowerCase()];
    if (dayKey) {
      anyMatched = true;
      const parsedTime = parseSingleTimeRange(match[2]);
      dayMap[dayKey] = {
        day: dayKey,
        fullName: DAY_FULL_NAMES[dayKey],
        ...parsedTime,
      };
    }
  }

  // 2. Check for day ranges e.g. "Mon-Fri 7:30 AM - 4:00 PM"
  if (!anyMatched) {
    const rangeRegex = /(?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*)\s*(?:-|–|to)\s*(?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat)[a-z]*)\s*[:\-]?\s*([^;\n]+)/gi;
    while ((match = rangeRegex.exec(clean)) !== null) {
      const startKey = DAY_LOOKUP[match[1].toLowerCase()];
      const endKey = DAY_LOOKUP[match[2].toLowerCase()];
      if (startKey && endKey) {
        anyMatched = true;
        const parsedTime = parseSingleTimeRange(match[3]);
        const startIdx = WEEK_DAYS.indexOf(startKey);
        const endIdx = WEEK_DAYS.indexOf(endKey);

        if (startIdx !== -1 && endIdx !== -1) {
          if (startIdx <= endIdx) {
            for (let i = startIdx; i <= endIdx; i++) {
              const k = WEEK_DAYS[i];
              dayMap[k] = { day: k, fullName: DAY_FULL_NAMES[k], ...parsedTime };
            }
          } else {
            for (let i = startIdx; i < 7; i++) {
              const k = WEEK_DAYS[i];
              dayMap[k] = { day: k, fullName: DAY_FULL_NAMES[k], ...parsedTime };
            }
            for (let i = 0; i <= endIdx; i++) {
              const k = WEEK_DAYS[i];
              dayMap[k] = { day: k, fullName: DAY_FULL_NAMES[k], ...parsedTime };
            }
          }
        }
      }
    }
  }

  // 3. Fallback: single time range applied to weekdays (Mon-Fri) or all days if specified daily
  if (!anyMatched) {
    const parsedTime = parseSingleTimeRange(clean);
    if (parsedTime.isOpen) {
      const isDaily = lower.includes("daily") || lower.includes("7 day") || lower.includes("every day");
      const targetDays: DayKey[] = isDaily ? [...WEEK_DAYS] : ["Mon", "Tue", "Wed", "Thu", "Fri"];
      for (const k of targetDays) {
        dayMap[k] = { day: k, fullName: DAY_FULL_NAMES[k], ...parsedTime };
      }
    }
  }

  // Determine Y-axis min/max (fixed 8 AM – 8 PM standard range)
  const yMin = 8;
  const yMax = 20;

  const daysList = WEEK_DAYS.map(d => dayMap[d]);
  const isAll24 = daysList.every(d => d.is24Hours);
  const isAllClosed = daysList.every(d => d.isClosed);

  return {
    days: daysList,
    unlisted: false,
    isAll24Hours: isAll24,
    isAllClosed,
    summaryLabel: isAll24 ? "Open 24 Hours" : isAllClosed ? "Closed" : "Weekly Schedule",
    yMinHour: yMin,
    yMaxHour: yMax,
  };
}

// Helper to parse strings like "Mon-Fri 7:30 AM - 4:00 PM", "Open 24 hours", "8:00 AM - 5:00 PM", "Closed"
export function parseDailyOperatingHours(text: string): ParsedDailyOperatingHours {
  const clean = (text || "").trim();
  const lower = clean.toLowerCase();
  const blocks = new Array(24).fill(false);

  if (!clean || lower.includes("not listed") || lower.includes("unknown") || lower === "—") {
    return { is24Hours: false, isClosed: false, unlisted: true, openBlocks: blocks, summaryLabel: "Hours not listed" };
  }

  if (lower.includes("24 hour") || lower.includes("open 24")) {
    return { is24Hours: true, isClosed: false, unlisted: false, openBlocks: new Array(24).fill(true), summaryLabel: "Open 24 Hours" };
  }

  if (lower.includes("permanently closed") || lower === "closed") {
    return { is24Hours: false, isClosed: true, unlisted: false, openBlocks: blocks, summaryLabel: "Closed" };
  }

  // Regex to extract time range e.g. "7:30 AM - 4:00 PM" or "08:00 - 17:00"
  const rangeMatch = clean.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);

  if (!rangeMatch) {
    // If we can't parse a strict range, treat as unlisted or general schedule
    return { is24Hours: false, isClosed: false, unlisted: false, openBlocks: blocks, summaryLabel: clean };
  }

  let startHour = parseInt(rangeMatch[1], 10);
  const startAmPm = (rangeMatch[3] || "").toLowerCase();
  let endHour = parseInt(rangeMatch[4], 10);
  const endAmPm = (rangeMatch[6] || rangeMatch[3] || "").toLowerCase();

  // Convert to 24-hour clock
  if (startAmPm === "pm" && startHour < 12) startHour += 12;
  if (startAmPm === "am" && startHour === 12) startHour = 0;

  if (endAmPm === "pm" && endHour < 12) endHour += 12;
  if (endAmPm === "am" && endHour === 12) endHour = 0;

  if (startHour <= endHour) {
    for (let h = startHour; h < endHour; h++) {
      blocks[h] = true;
    }
  } else {
    // Over midnight e.g. 8 PM to 4 AM
    for (let h = startHour; h < 24; h++) blocks[h] = true;
    for (let h = 0; h < endHour; h++) blocks[h] = true;
  }

  return {
    is24Hours: false,
    isClosed: false,
    unlisted: false,
    openBlocks: blocks,
    summaryLabel: clean,
  };
}
export interface MapPoint { id: string; label: string; position: [number, number] | null }
export interface DashboardShelter extends MapPoint {
  access: AccessStatus; generator: AccessStatus; surge: AccessStatus;
  capacity: number | null; postCapacity: number | null; medical: AccessStatus;
  selfSufficientPower: AccessStatus; floodplain100yr: AccessStatus;
  pets: string; populationCode: string; usage: string; address: string;
  streetAddress: string; city: string; zip: string;
  siteCoastalFloodShare: number | null; nearbyNoVehicle5km: number;
}
export interface DashboardTract extends MapPoint {
  name: string; nearCity: string | null;
  totalPop: number | null; households: number | null;
  noVehicle: number | null; noVehicleShare: number | null;
  olderCount: number | null; olderShare: number | null;
  disabilityCount: number | null; disability: number | null;
  mobilityCount: number | null; mobilityShare: number | null;
  mobileHomes: number | null; mobileHomesShare: number | null;
  groupQuarters: number | null;
  coastalExposedPop: number | null; coastalExposedShare: number | null;
  hurricaneExposedPop: number | null;
  nearestEvac: number | null; nearestAccessible: number | null;
  walkableEvacCount: number; walkableSeniorCount: number;
  hurricaneLoss: number | null; coastalLoss: number | null;
}
export interface DashboardData {
  shelters: DashboardShelter[]; tracts: DashboardTract[];
  access: Record<AccessStatus, number>; capacity: number | null; capacityMissing: number;
  power: number | null; powerCensored: boolean; fetchedAt: string;
  source: "live" | "preview"; warnings: string[];
}
export function prepareDashboard(shelterRows: Row[], tractRows: Row[], hazardRows: Row[], powerRows: Row[], source: "live" | "preview", warnings: string[] = []): DashboardData {
  const shelters: DashboardShelter[] = shelterRows.map(r => {
    const streetAddress = String(r.address_1 || "").trim();
    const city = String(r.city || "").trim();
    const zip = String(r.zip || "").trim();
    return {
      id: String(r.shelter_id), label: String(r.shelter_name || "Unnamed shelter"),
      position: coordinates(r.latitude, r.longitude), access: recordingStatus(r.wheelchair_accessible),
      generator: recordingStatus(r.generator_onsite), surge: recordingStatus(r.in_surge_slosh_area),
      selfSufficientPower: recordingStatus(r.self_sufficient_electricity),
      floodplain100yr: recordingStatus(r.in_100_yr_floodplain),
      medical: recordingStatus(r.is_medical), capacity: numeric(r.evacuation_capacity),
      postCapacity: numeric(r.post_impact_capacity),
      pets: String(r.pet_accommodations_code || "").trim() || "UNRECORDED",
      populationCode: String(r.population_code || "").trim() || "UNRECORDED",
      usage: String(r.usage || "UNRECORDED"),
      streetAddress, city, zip,
      address: [streetAddress, city].filter(Boolean).join(", ") || "Address unrecorded",
      siteCoastalFloodShare: null, nearbyNoVehicle5km: 0,
    };
  });
  const preLandfall = shelters.filter(s => s.position && ["EVAC", "BOTH"].includes(s.usage.toUpperCase()));
  const eligible = preLandfall.filter(s => s.access === "YES");
  const sheltersWithCity = shelters.filter(s => s.position && s.city);
  const hazards = new Map(hazardRows.map(r => [String(r.geo_id), r]));
  const tracts: DashboardTract[] = tractRows.map(r => {
    const id = String(r.geo_id), position = coordinates(r.lat, r.lon), h = hazards.get(id);
    let nearCity: string | null = null;
    if (position && sheltersWithCity.length) {
      let bestDist = Infinity;
      for (const s of sheltersWithCity) {
        const d = distanceKm(position, s.position!);
        if (d < bestDist) {
          bestDist = d;
          nearCity = titleCaseCity(s.city);
        }
      }
    }
    const name = formatTractName(id, nearCity);
    const label = /^\d{11}$/.test(id.trim()) ? `${name} · ${id}` : name;
    const totalPop = numeric(r.total_pop), households = numeric(r.households);
    const noVehicle = numeric(r.households_no_vehicle);
    const noVehicleShare = numeric(r.pct_no_vehicle) ?? (noVehicle !== null && households ? (100 * noVehicle) / households : null);
    const olderCount = numeric(r.pop_65_plus), olderShare = numeric(r.pct_age_65_plus);
    const disability = numeric(r.pct_disability);
    const disabilityCount = totalPop !== null && disability !== null ? Math.round((totalPop * disability) / 100) : null;
    const mobilityShare = numeric(r.pct_mobility);
    const mobilityCount = totalPop !== null && mobilityShare !== null ? Math.round((totalPop * mobilityShare) / 100) : null;
    const mobileHomes = numeric(r.mobile_homes), mobileHomesShare = numeric(r.pct_mobile_homes);
    const groupQuarters = numeric(r.group_quarters_pop);
    const hPop = numeric(h?.POPULATION) ?? totalPop;
    const coastalExposedPop = numeric(h?.CFLD_EXPP);
    const coastalExposedShare = coastalExposedPop !== null && hPop ? (100 * coastalExposedPop) / hPop : null;
    const hurricaneExposedPop = numeric(h?.HRCN_EXPP);
    const evacDistances = position ? preLandfall.map(s => distanceKm(position, s.position!)) : [];
    const distances = position ? eligible.map(s => distanceKm(position, s.position!)) : [];
    return {
      id, name, nearCity, label, position, totalPop, households,
      noVehicle, noVehicleShare, olderCount, olderShare,
      disabilityCount, disability, mobilityCount, mobilityShare,
      mobileHomes, mobileHomesShare, groupQuarters,
      coastalExposedPop, coastalExposedShare, hurricaneExposedPop,
      nearestEvac: evacDistances.length ? Math.min(...evacDistances) : null,
      nearestAccessible: distances.length ? Math.min(...distances) : null,
      walkableEvacCount: evacDistances.filter(d => d <= 1.6).length,
      walkableSeniorCount: evacDistances.filter(d => d <= 0.8).length,
      hurricaneLoss: numeric(h?.HRCN_EALP), coastalLoss: numeric(h?.CFLD_EALP),
    };
  }).sort((a, b) => (b.noVehicle ?? -1) - (a.noVehicle ?? -1) || a.id.localeCompare(b.id));
  const positionedTracts = tracts.filter(t => t.position);
  shelters.forEach(s => {
    if (!s.position || !positionedTracts.length) return;
    let nearestTract: DashboardTract | null = null, minKm = Infinity, noVehicle5km = 0;
    for (const t of positionedTracts) {
      const km = distanceKm(s.position, t.position!);
      if (km < minKm) { minKm = km; nearestTract = t; }
      if (km <= 5 && t.noVehicle !== null) noVehicle5km += t.noVehicle;
    }
    s.siteCoastalFloodShare = nearestTract?.coastalExposedShare ?? null;
    s.nearbyNoVehicle5km = noVehicle5km;
  });
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
