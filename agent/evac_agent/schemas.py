"""Predefined Pydantic v2 schemas for all Evacuation Readiness agents, tools, locations, and UI actions.

Every recommended action emitted by a tool or agent conforms to `RecommendedAction`, which includes:
- Geographic coordinates and identifiers (`primary_location` + `secondary_locations`)
- Structured attention items with data provenance badges (`attention_items`)
- Explicit UI interaction metadata (`interaction_mode`: `APPROVAL_REQUIRED`, `SELECT_BETWEEN_OPTIONS`, or `INFO_ATTENTION`)
- Approval payload (`approval`) for actions requiring manager sign-off
- Selectable options (`options`) for actions where the manager must choose between alternatives
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Optional
from pydantic import AliasChoices, BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------------------------
# Enums for Action Types, UI Interaction Modes, and Severity
# ---------------------------------------------------------------------------------------------

class ActionType(str, Enum):
    """Predefined categories of recommended actions across all 4 agents."""
    # Q1: Prioritization & Outreach (prioritization_agent)
    ORGANIZE_BUS_PICKUP = "ORGANIZE_BUS_PICKUP"
    OLDER_ADULT_CHECKIN = "OLDER_ADULT_CHECKIN"
    DISABILITY_ACCESSIBLE_TRANSPORT = "DISABILITY_ACCESSIBLE_TRANSPORT"
    MOBILE_HOME_EVACUATION_OUTREACH = "MOBILE_HOME_EVACUATION_OUTREACH"
    ADJUST_PRIORITY_WEIGHTS = "ADJUST_PRIORITY_WEIGHTS"

    # Q2: Destination & Reachability (destination_agent)
    SELECT_TRACT_DESTINATION = "SELECT_TRACT_DESTINATION"
    DESIGNATE_BUS_PICKUP_POINT = "DESIGNATE_BUS_PICKUP_POINT"
    SCHEDULE_PARATRANSIT_PICKUP = "SCHEDULE_PARATRANSIT_PICKUP"
    EXCLUDE_SURGE_ZONE_SHELTER = "EXCLUDE_SURGE_ZONE_SHELTER"
    CONFIRM_SHELTER_CAPACITY = "CONFIRM_SHELTER_CAPACITY"
    VERIFY_FLOOD_GROUND_ELEVATION = "VERIFY_FLOOD_GROUND_ELEVATION"

    # Q3: Data Quality & Live Google Maps Verification (verification_agent)
    DROP_CLOSED_SHELTER = "DROP_CLOSED_SHELTER"
    IN_PERSON_BUILDING_CHECK = "IN_PERSON_BUILDING_CHECK"
    UPDATE_SHELTER_REGISTRY_NAME = "UPDATE_SHELTER_REGISTRY_NAME"
    RESOLVE_CONTRADICTORY_RECORDS = "RESOLVE_CONTRADICTORY_RECORDS"
    INTERVIEW_SHELTER_OPERATOR = "INTERVIEW_SHELTER_OPERATOR"

    # Coordinator: Pre-season County Gaps & Operator Writeback (evac_readiness_coordinator)
    APPROVE_SHELTER_ASSESSMENT_WRITEBACK = "APPROVE_SHELTER_ASSESSMENT_WRITEBACK"
    AUDIT_UNASSESSED_NEARBY_SHELTERS = "AUDIT_UNASSESSED_NEARBY_SHELTERS"
    VERIFY_MEDICAL_SHELTER_GENERATORS = "VERIFY_MEDICAL_SHELTER_GENERATORS"
    PLAN_NURSING_HOME_EVACUATION = "PLAN_NURSING_HOME_EVACUATION"


class InteractionMode(str, Enum):
    """How the UI should present this action to the emergency manager."""
    APPROVAL_REQUIRED = "APPROVAL_REQUIRED"
    SELECT_BETWEEN_OPTIONS = "SELECT_BETWEEN_OPTIONS"
    INFO_ATTENTION = "INFO_ATTENTION"


class ActionSeverity(str, Enum):
    """Urgency and operational impact level."""
    CRITICAL = "CRITICAL"
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"


AgentName = Literal[
    "prioritization_agent",
    "destination_agent",
    "verification_agent",
    "evac_readiness_coordinator",
    "evacuation_readiness_coordinator",
]


# ---------------------------------------------------------------------------------------------
# Shared Location, Attribution, and Action Primitives
# ---------------------------------------------------------------------------------------------

class MapsGroundingChunk(BaseModel):
    """Single Google Maps grounding source for compliant UI attribution."""
    place_id: Optional[str] = Field(None, description="Google Maps Place ID (allowed to persist)")
    title: str = Field(..., description="Display name of the place from Google Maps")
    uri: str = Field(..., description="Google Maps URL for user attribution")


class LocationInfo(BaseModel):
    """Standardized geographic location attached to every action, option, tract, and shelter."""
    lat: Optional[float] = Field(None, description="Latitude (WGS84 decimal degrees)")
    lon: Optional[float] = Field(None, description="Longitude (WGS84 decimal degrees)")
    label: str = Field(..., description="Human-readable label (place name, shelter name, or tract description)")
    address: Optional[str] = Field(None, description="Street address if this location is a building/facility")
    city: Optional[str] = Field(None, description="City or nearest city name")
    county: Optional[str] = Field(None, description="Florida county name")
    county_fips: Optional[str] = Field(None, description="5-digit county FIPS code")
    geo_id: Optional[str] = Field(None, description="11-digit Census tract GEOID if applicable")
    shelter_id: Optional[int] = Field(None, description="FEMA shelter_id if applicable")
    facility_id: Optional[str] = Field(None, description="CMS certification number (CCN) if a nursing home")
    place_id: Optional[str] = Field(None, description="Google Maps Place ID if verified live")
    maps_uri: Optional[str] = Field(None, description="Google Maps URL if verified live")


class AttentionItem(BaseModel):
    """A specific metric, discrepancy, or risk factor that needs the user's attention."""
    model_config = ConfigDict(populate_by_name=True)

    label: str = Field(..., description="Short field or badge label (e.g., 'No-vehicle households', 'Surge zone')")
    value: str = Field(..., description="Formatted value or status")
    source_badge: str = Field(
        ...,
        validation_alias=AliasChoices("source_badge", "badge"),
        description="Provenance label (🕰️ FEMA, 🟢 Google Maps, 📊 ACS, 🧮 CDC, 🌊 NRI, ❓ unrecorded)",
    )
    is_warning: bool = Field(False, description="True when highlighting a hazard, conflict, closure, or missing data")


class ActionOption(BaseModel):
    """A single selectable choice for actions with `interaction_mode == SELECT_BETWEEN_OPTIONS`."""
    option_id: str = Field(..., description="Stable identifier for this option (e.g. shelter_id, geo_id, or preset key)")
    label: str = Field(..., description="Option title shown in the selector UI")
    description: str = Field(..., description="Summary of why to pick this option (distance, drive time, capacity, caveats)")
    recommended: bool = Field(False, description="True if the agent recommends this option by default")
    location: Optional[LocationInfo] = Field(None, description="Location of this option (e.g. candidate shelter coordinates)")
    metrics: dict[str, Any] = Field(
        default_factory=dict,
        description="Structured metrics for comparing options (capacity, miles, drive_minutes, wheelchair, generator)",
    )
    warnings: list[str] = Field(default_factory=list, description="Caveats or flags to surface before user selection")


class ApprovalDetails(BaseModel):
    """Metadata and execution payload for actions with `interaction_mode == APPROVAL_REQUIRED`."""
    confirm_label: str = Field("Approve", description="Primary button label to approve the action")
    reject_label: str = Field("Defer / Keep Current", description="Secondary button label to reject or defer")
    proposed_change: str = Field(..., description="Plain-language statement of what approving this action will do")
    target_entity_type: Literal["shelter", "tract", "nursing_home", "county_policy", "county"] = Field(
        ..., description="Type of entity modified or flagged on approval"
    )
    target_entity_id: str = Field(..., description="Identifier of the target shelter, tract, facility, or county")
    payload: dict[str, Any] = Field(
        default_factory=dict,
        description="Structured arguments for executing the approved action (e.g., record_shelter_assessment parameters)",
    )
    irreversible_or_high_impact: bool = Field(
        False, description="True if approving removes shelter capacity from the plan or writes to BigQuery"
    )


class RecommendedAction(BaseModel):
    """Predefined Pydantic schema for every recommended action emitted by tools and agents."""
    model_config = ConfigDict(populate_by_name=True)

    action_id: str = Field(..., description="Deterministic unique ID for UI tracking (e.g. 'act-drop-closed-42819')")
    action_type: ActionType = Field(..., description="Predefined action type enum")
    agent_source: AgentName = Field(
        "evac_readiness_coordinator",
        validation_alias=AliasChoices("agent_source", "source_agent"),
        description="Which specialist or coordinator produced this action",
    )
    source_tool: Optional[str] = Field(None, description="Tool function that generated this action")
    interaction_mode: InteractionMode = Field(
        ..., description="UI interaction mode: APPROVAL_REQUIRED, SELECT_BETWEEN_OPTIONS, or INFO_ATTENTION"
    )
    requires_approval: bool = Field(False, description="True when user approval is required before applying")
    requires_selection: bool = Field(False, description="True when user must choose between multiple `options`")
    severity: ActionSeverity = Field(ActionSeverity.HIGH, description="Priority severity badge for UI sorting")
    title: str = Field(..., description="Concise, assignable action title")
    summary: str = Field(..., description="Actionable explanation with counts and source labels")
    rationale: Optional[str] = Field(None, description="Additional context explaining why this action is recommended")
    affected_count: Optional[int] = Field(None, description="Numeric count of people, households, beds, or spaces affected")
    affected_unit: Optional[str] = Field(
        None, description="Unit for affected_count (e.g. 'no_car_households', 'spaces', 'beds', 'shelters', 'residents')"
    )
    primary_location: LocationInfo = Field(
        ...,
        validation_alias=AliasChoices("primary_location", "location"),
        description="Primary location (with lat/lon) where this action applies",
    )
    secondary_locations: list[LocationInfo] = Field(
        default_factory=list, description="Additional related locations (e.g. candidate shelters or conflicting sites)"
    )
    attention_items: list[AttentionItem] = Field(
        default_factory=list, description="Key metrics, hazards, or discrepancies requiring planner attention"
    )
    approval: Optional[ApprovalDetails] = Field(
        None, description="Populated when `requires_approval` is True"
    )
    options: list[ActionOption] = Field(
        default_factory=list, description="Selectable choices when `requires_selection` is True (or alternatives)"
    )
    selected_option_id: Optional[str] = Field(
        None, description="Pre-selected/recommended `option_id` from `options`"
    )
    maps_sources: list[MapsGroundingChunk] = Field(
        default_factory=list, description="Verbatim Google Maps grounding sources supporting this action"
    )


# ---------------------------------------------------------------------------------------------
# Q1 Tool Output Schemas (prioritize.py & equity_audit in data.py)
# ---------------------------------------------------------------------------------------------

class PriorityFactorPoints(BaseModel):
    """0-100 statewide percentile points per ranking factor."""
    no_car: float
    older: float
    disability: float
    mobile_homes: float
    flood: float


class PriorityWeightsOutput(BaseModel):
    """Output schema for `set_priority_weights`."""
    weights_in_effect: dict[str, float]
    note: str
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)


class EvacuationZoneTotals(BaseModel):
    tracts: int
    people: int
    no_car_households: int


class PriorityTractItem(BaseModel):
    """Single ranked census tract returned by `rank_priority_tracts`."""
    geo_id: str
    county_name: str
    county_fips: Optional[str] = None
    place: str
    lat: Optional[float] = None
    lon: Optional[float] = None
    location: LocationInfo
    total_pop: int
    hh_no_vehicle: int
    pop_65_plus: int
    mobility_disabled_modeled: Optional[float] = None
    mobile_homes: int
    pct_coastal_flood_exposed: Optional[float] = None
    est_no_car_mobility_hh_modeled: Optional[float] = None
    evacuation_driver: Optional[str] = None
    priority_points: float
    main_need: str
    points: PriorityFactorPoints


class RankPriorityTractsOutput(BaseModel):
    """Output schema for `rank_priority_tracts`."""
    scope: str
    weights_used: dict[str, float]
    weights_sentence: str
    evacuation_zone_totals: EvacuationZoneTotals
    tracts: list[PriorityTractItem]
    how_points_work: str
    labels: dict[str, str]
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)


class EquityAuditGroup(BaseModel):
    grp: str
    tracts: int
    pct_white_non_hispanic: Optional[float] = None
    pct_black_non_hispanic: Optional[float] = None
    pct_hispanic: Optional[float] = None
    pct_asian: Optional[float] = None
    avg_pct_poverty: Optional[float] = None
    pct_households_no_vehicle: Optional[float] = None
    pct_65_plus: Optional[float] = None
    median_income_excl_sentinel: Optional[float] = None
    pct_nearby_shelters_with_wheelchair_recorded: Optional[float] = None


class EquityAuditOutput(BaseModel):
    """Output schema for `equity_audit`."""
    county: str
    groups: list[EquityAuditGroup]
    how_to_read: str
    notes: str
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)


# ---------------------------------------------------------------------------------------------
# Q2 Tool Output Schemas (destination.py)
# ---------------------------------------------------------------------------------------------

class ReachabilityRulesOutput(BaseModel):
    """Output schema for `set_reachability_rules`."""
    rules_in_effect: dict[str, float]
    fixed_rule: str
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)


class CarDestinationOption(BaseModel):
    shelter_id: Optional[int] = None
    shelter: str
    address: str
    location: Optional[LocationInfo] = None
    straight_line: str
    capacity: int | str
    fema_record: str
    flag: Optional[str] = None
    drive: Optional[str] = None
    reachable_by_car: Optional[bool] = None
    live_check: Optional[str] = None
    maps_attribution: Optional[str] = None
    usable: Optional[bool] = True
    why_not: Optional[str] = None


class WalkableShelterOption(BaseModel):
    shelter_id: Optional[int] = None
    shelter: str
    location: Optional[LocationInfo] = None
    straight_line: str
    capacity: int | str
    flag: Optional[str] = None


class ExcludedShelterItem(BaseModel):
    shelter_id: Optional[int] = None
    name: str
    location: Optional[LocationInfo] = None
    reason: str


class HouseholdsWithCarTier(BaseModel):
    count: str
    destinations: list[CarDestinationOption]


class HouseholdsWithoutCarTier(BaseModel):
    count: str
    walkable_shelters: list[WalkableShelterOption]
    verdict: str


class NoCarMobilityTier(BaseModel):
    count: str
    verdict: str


class TractDestinationPlanItem(BaseModel):
    geo_id: Optional[str] = None
    place: Optional[str] = None
    location: Optional[LocationInfo] = None
    households_with_car: Optional[HouseholdsWithCarTier] = None
    households_without_car: Optional[HouseholdsWithoutCarTier] = None
    no_car_with_mobility_disability: Optional[NoCarMobilityTier] = None
    excluded_shelters: list[ExcludedShelterItem] = Field(default_factory=list)
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)
    error: Optional[str] = None


class PlanDestinationsOutput(BaseModel):
    """Output schema for `plan_destinations`."""
    rules_used: dict[str, float]
    tracts: list[TractDestinationPlanItem]
    surge_rule: str
    attribution: str
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)


# ---------------------------------------------------------------------------------------------
# Q3 Tool Output Schemas (quality.py & verify.py)
# ---------------------------------------------------------------------------------------------

class ContradictoryRecordEntry(BaseModel):
    shelter_id: Optional[int] = None
    shelter_name: str
    wheelchair: str
    generator: str
    capacity: Optional[int] = None


class SelfContradictingAddressGroup(BaseModel):
    address: str
    city: Optional[str] = None
    county_name: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    location: Optional[LocationInfo] = None
    records: list[ContradictoryRecordEntry]


class SuspiciousShelterRecord(BaseModel):
    shelter_id: int
    shelter_name: str
    address: Optional[str] = None
    city: Optional[str] = None
    county_name: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    location: Optional[LocationInfo] = None
    issue: str


class DataQualityReportOutput(BaseModel):
    """Output schema for `data_quality_report`."""
    scope: str
    unrecorded_counts: dict[str, Any]
    self_contradicting_records: list[SelfContradictingAddressGroup]
    suspicious_records: list[SuspiciousShelterRecord]
    reporting_bias: dict[str, Any]
    freshness: dict[str, str]
    how_we_handle_missing_data: list[str]
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)


class DriveRouteInfo(BaseModel):
    drive_minutes: Optional[float] = None
    drive_miles: Optional[float] = None
    source: Optional[str] = None
    note: Optional[str] = None


class ShelterVerificationResultItem(BaseModel):
    """Single shelter verification result from `verify_shelters_live`."""
    shelter_id: int
    registry_name: Optional[str] = None
    registry_address: Optional[str] = None
    location: Optional[LocationInfo] = None
    verdict: Literal[
        "CONFIRMED_EXISTS",
        "RENAMED_OR_REBRANDED",
        "FOUND_AT_DIFFERENT_ADDRESS",
        "DIFFERENT_PLACE_AT_ADDRESS",
        "CLOSED",
        "NOT_FOUND_ON_MAPS",
        "UNVERIFIED",
    ]
    action: str
    flags: list[str] = Field(default_factory=list)
    error: Optional[str] = None
    google_maps_says: Optional[dict[str, Optional[str]]] = None
    accessibility: str
    maps_wheelchair_entrance: Optional[str] = None
    maps_accessibility_attributes: Optional[str] = None
    grounded_fields: list[str] = Field(default_factory=list)
    drive: Optional[DriveRouteInfo | dict[str, Any]] = None
    google_maps_sources: list[dict[str, Any]] = Field(default_factory=list)
    maps_attribution: list[str] = Field(default_factory=list)
    freshness: Optional[dict[str, str]] = None
    checked_at: Optional[str] = None
    origin_tract: Optional[str] = None
    recommended_action: Optional[RecommendedAction] = None


class VerifySheltersLiveOutput(BaseModel):
    """Output schema for `verify_shelters_live`."""
    results: list[ShelterVerificationResultItem]
    tally: dict[str, int]
    attribution_rule: str
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)


# ---------------------------------------------------------------------------------------------
# Coordinator & Shared Tool Output Schemas (data.py & brief.py)
# ---------------------------------------------------------------------------------------------

class ShelterRegistryRow(BaseModel):
    shelter_id: int
    shelter_name: str
    address: Optional[str] = None
    city: Optional[str] = None
    county_name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    location: Optional[LocationInfo] = None
    usage: Optional[str] = None
    capacity: Optional[int] = None
    wheelchair: str
    generator: str
    surge_flag: str
    is_medical: Optional[bool] = None
    site_in_flood_hazard: Optional[bool] = None


class FindSheltersOutput(BaseModel):
    """Output schema for `find_shelters`."""
    county: str
    summary: dict[str, Any]
    shelters: list[ShelterRegistryRow]
    source: str
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)


class CountyGapReportOutput(BaseModel):
    """Output schema for `county_gap_report`."""
    county: str
    county_fips: Optional[str] = None
    evacuation_zone_tracts_with_no_shelter_within_1_mile: dict[str, Any]
    accessible_shelter_access: dict[str, Any]
    shelters_on_flood_hazard_ground: dict[str, Any]
    medical_and_power_dependence: dict[str, Any]
    nursing_homes: dict[str, Any]
    what_the_record_cannot_tell_us: dict[str, Any]
    caveats: list[str]
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)


class ShelterAssessmentRecord(BaseModel):
    shelter_id: int
    assessed_at: str
    wheelchair_unaccompanied: Literal["yes", "no", "unknown"]
    step_free_entrance: Literal["yes", "no", "unknown"]
    accessible_restroom: Literal["yes", "no", "unknown"]
    generator: Literal["yes", "no", "unknown"]
    notes: str
    source: str


class RecordShelterAssessmentOutput(BaseModel):
    """Output schema for `record_shelter_assessment`."""
    saved: bool
    errors: list[Any] = Field(default_factory=list)
    record: ShelterAssessmentRecord
    location: Optional[LocationInfo] = None
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)


class ReadinessBriefOutput(BaseModel):
    """Output schema for `build_readiness_brief`."""
    county: str
    county_totals: dict[str, Any]
    who_cannot_leave: list[dict[str, Any]] = Field(alias="1_who_cannot_leave")
    where_they_would_go: list[dict[str, Any]] = Field(alias="2_where_they_would_go")
    what_to_fix_before_the_season: dict[str, Any] = Field(alias="3_what_to_fix_before_the_season")
    what_we_could_not_tell_you: dict[str, Any] = Field(alias="4_what_we_could_not_tell_you")
    method: str
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)

    model_config = {"populate_by_name": True}


def record_actions_in_state(tool_context: Any, actions: list[RecommendedAction]) -> list[dict[str, Any]]:
    """Serializes Pydantic `RecommendedAction` models and merges them into `tool_context.state['recommended_actions']`
    so specialist `AgentTool` invocations propagate structured actions up to the coordinator and UI server."""
    dumped = [a.model_dump() for a in actions]
    if tool_context is not None and hasattr(tool_context, "state") and tool_context.state is not None:
        existing = list(tool_context.state.get("recommended_actions") or [])
        by_id: dict[str, dict[str, Any]] = {}
        for item in existing:
            if isinstance(item, dict) and item.get("action_id"):
                by_id[str(item["action_id"])] = item
        for item in dumped:
            by_id[str(item["action_id"])] = item
        tool_context.state["recommended_actions"] = list(by_id.values())
    return dumped

