export type RecordingStatus = "YES" | "NO" | "UNRECORDED";

export interface MapsGroundingChunk {
  place_id?: string | null;
  title: string;
  uri: string;
}

export interface VulnerableTract {
  geo_id: string;
  county_fips: string;
  total_pop: number;
  households_no_vehicle: number;
  pct_no_vehicle: number;
  pct_age_65_plus: number;
  pct_disability: number;
  pct_mobility?: number | null;
  mobile_homes: number;
  nearest_any_shelter_km: number;
  nearest_recorded_wheelchair_shelter_km: number | null;
  shelters_within_reach_unrecorded_access: number;
  priority_reason: string;
}

export interface ShelterCandidate {
  shelter_id: string;
  shelter_name: string;
  address_1: string;
  city: string;
  county_name: string;
  latitude: number;
  longitude: number;
  evacuation_capacity: number | null;
  post_impact_capacity: number | null;
  wheelchair_status: RecordingStatus;
  generator_status: RecordingStatus;
  in_surge_slosh_area: boolean | null;
  is_medical: boolean;
  usage: "EVAC" | "POST" | string | null;
  maps_live_verification: {
    verified: boolean;
    summary: string;
    drive_time_note?: string;
    grounding_chunks: MapsGroundingChunk[];
  };
}

export interface PreSeasonGap {
  id: string;
  category: "ACCESSIBILITY_AUDIT" | "SURGE_EXPOSURE" | "TRANSIT_GAP" | "MEDICAL_POWER";
  severity: "HIGH" | "MEDIUM";
  title: string;
  recommendation: string;
  evidence_source: "FEMA_2022_REGISTRY" | "GOOGLE_MAPS_LIVE" | "ACS_SVI_EMPOWER";
}

export interface ReadinessBriefData {
  state: string;
  county_name: string;
  county_fips: string;
  season_context: string;
  summary_metrics: {
    total_shelters: number;
    total_evacuation_capacity: number;
    wheelchair_yes: number;
    wheelchair_no: number;
    wheelchair_unrecorded: number;
    pct_wheelchair_unrecorded: number;
    medical_needs_shelters: number;
    power_dependent_dme: number;
    power_dependent_is_censored: boolean;
  };
  who_cannot_leave: VulnerableTract[];
  candidate_shelters: ShelterCandidate[];
  pre_season_gaps: PreSeasonGap[];
  unrecorded_and_limitations: string[];
}

export interface ChatResponse {
  reply: string;
  county: string;
  state: string;
  grounding_chunks: MapsGroundingChunk[];
}
