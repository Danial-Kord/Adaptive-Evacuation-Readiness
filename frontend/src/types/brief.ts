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
  tools_called?: string[];
  elapsed_seconds?: number;
  agent_url?: string;
  grounding_chunks: MapsGroundingChunk[];
  recommended_actions?: RecommendedAction[];
  agent_outputs?: AgentSchemaOutput[];
}

export type ActionType =
  | "ORGANIZE_BUS_PICKUP"
  | "OLDER_ADULT_CHECKIN"
  | "DISABILITY_ACCESSIBLE_TRANSPORT"
  | "MOBILE_HOME_EVACUATION_OUTREACH"
  | "ADJUST_PRIORITY_WEIGHTS"
  | "SELECT_TRACT_DESTINATION"
  | "DESIGNATE_BUS_PICKUP_POINT"
  | "SCHEDULE_PARATRANSIT_PICKUP"
  | "EXCLUDE_SURGE_ZONE_SHELTER"
  | "CONFIRM_SHELTER_CAPACITY"
  | "VERIFY_FLOOD_GROUND_ELEVATION"
  | "DROP_CLOSED_SHELTER"
  | "IN_PERSON_BUILDING_CHECK"
  | "UPDATE_SHELTER_REGISTRY_NAME"
  | "RESOLVE_CONTRADICTORY_RECORDS"
  | "INTERVIEW_SHELTER_OPERATOR"
  | "APPROVE_SHELTER_ASSESSMENT_WRITEBACK"
  | "AUDIT_UNASSESSED_NEARBY_SHELTERS"
  | "VERIFY_MEDICAL_SHELTER_GENERATORS"
  | "PLAN_NURSING_HOME_EVACUATION";

export type InteractionMode =
  | "APPROVAL_REQUIRED"
  | "SELECT_BETWEEN_OPTIONS"
  | "INFO_ATTENTION";

export type ActionSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface LocationInfo {
  lat?: number | null;
  lon?: number | null;
  label?: string | null;
  address?: string | null;
  city?: string | null;
  county?: string | null;
  county_fips?: string | null;
  tract_geoid?: string | null;
  shelter_id?: number | null;
  facility_id?: string | null;
}

export interface AttentionItem {
  label: string;
  value: string;
  badge?: string | null;
  is_warning?: boolean;
  maps_title?: string | null;
  maps_uri?: string | null;
}

export interface ActionOption {
  option_id: string;
  label: string;
  description?: string | null;
  recommended?: boolean;
  location?: LocationInfo | null;
  metrics?: Record<string, any>;
  warnings?: string[];
}

export interface ApprovalDetails {
  confirm_label?: string;
  reject_label?: string;
  proposed_change: string;
  target_entity_type: string;
  target_entity_id: string;
  payload?: Record<string, any>;
  irreversible_or_high_impact?: boolean;
}

export interface RecommendedAction {
  action_id: string;
  action_type: ActionType | string;
  interaction_mode: InteractionMode;
  severity: ActionSeverity;
  title: string;
  summary: string;
  rationale: string;
  source_agent: string;
  source_tool: string;
  location?: LocationInfo | null;
  from_location?: LocationInfo | null;
  to_location?: LocationInfo | null;
  affected_residents?: number | null;
  affected_households?: number | null;
  capacity_at_stake?: number | null;
  attention_items?: AttentionItem[];
  requires_approval?: boolean;
  approval?: ApprovalDetails | null;
  requires_selection?: boolean;
  options?: ActionOption[];
  selected_option_id?: string | null;
}

export interface AgentSchemaOutput {
  agent_name: string;
  tool_name: string;
  schema_name: string;
  data: Record<string, any>;
}

export type ActionDecisionStatus = "APPROVED" | "REJECTED" | "OPTION_SELECTED";

export interface ActionDecisionRecord {
  action_id: string;
  decision: ActionDecisionStatus;
  selected_option_id?: string | null;
  selected_option_label?: string | null;
  decided_at: string;
  note?: string | null;
  applied_summary: string;
  follow_up_prompt?: string | null;
}

export interface MapShelterPoint {
  shelter_id: string;
  shelter_name: string;
  address_1?: string | null;
  city?: string | null;
  county_name?: string | null;
  zip?: string | null;
  latitude: number;
  longitude: number;
  distance_km?: number;
  evacuation_capacity?: number | null;
  post_impact_capacity?: number | null;
  wheelchair_status: RecordingStatus;
  generator_status: RecordingStatus;
  in_surge_slosh_area?: boolean | null;
  in_100_yr_floodplain?: boolean | null;
  is_medical?: boolean;
  usage?: string | null;
}

export interface MapTractPoint {
  geo_id: string;
  county_fips: string;
  lat: number;
  lon: number;
  distance_km?: number;
  total_pop?: number | null;
  households?: number | null;
  households_no_vehicle?: number | null;
  pct_no_vehicle?: number | null;
  pop_65_plus?: number | null;
  pct_age_65_plus?: number | null;
  pct_disability?: number | null;
  pct_mobility?: number | null;
  mobile_homes?: number | null;
  pct_mobile_homes?: number | null;
  pct_limited_english?: number | null;
  pct_no_internet?: number | null;
  hrcn_afreq?: number | null;
  hrcn_expp?: number | null;
  hrcn_ealt?: number | null;
  cfld_afreq?: number | null;
  cfld_expp?: number | null;
  cfld_ealt?: number | null;
  CFLD_EXPP?: number | null;
  HRCN_EALT?: number | null;
}

export interface CountyMapPointsResponse {
  county: string;
  county_fips?: string | null;
  shelters: MapShelterPoint[];
  tracts: MapTractPoint[];
}

export interface CareFacilityNearby {
  cms_certification_number_ccn?: string | null;
  provider_name: string;
  provider_address?: string | null;
  citytown?: string | null;
  zip_code?: string | null;
  number_of_certified_beds?: number | null;
  ownership_type?: string | null;
  latitude: number;
  longitude: number;
  distance_km: number;
}

export interface CountyPowerDependent {
  county_name: string;
  county_fips: string;
  medicare_benes?: number | null;
  power_dependent_dme?: number | null;
  power_dependent_is_censored?: boolean | null;
  o2_services_any_dme?: number | null;
  facility_esrd_dialysis_any_dme?: number | null;
  home_health_services_any_dme?: number | null;
  athome_hospice_any_dme?: number | null;
}

export interface AreaInspectResponse {
  coordinates: {
    lat: number;
    lng: number;
    radius_km: number;
  };
  elapsed_seconds: number;
  nearest_tract: MapTractPoint | null;
  county_power_dependent: CountyPowerDependent | null;
  nearby_shelters: MapShelterPoint[];
  nearby_care_facilities: CareFacilityNearby[];
  google_maps_live: {
    summary: string;
    route_to_nearest_shelter?: {
      drive_minutes: number;
      drive_miles: number;
      drive_km: number;
    } | null;
    grounding_chunks: MapsGroundingChunk[];
    error?: string | null;
  };
}
