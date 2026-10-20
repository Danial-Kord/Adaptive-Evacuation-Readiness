"""Pydantic schemas shared between the ADK Agent, FastAPI server, and React frontend."""

from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field

from evac_agent.schemas import (
    ActionOption,
    ActionSeverity,
    ActionType,
    ApprovalDetails,
    AttentionItem,
    InteractionMode,
    LocationInfo,
    RecommendedAction,
)


class MapsGroundingChunk(BaseModel):
    """Represents a single Google Maps grounding source for compliant UI attribution."""
    place_id: Optional[str] = Field(None, description="Google Maps Place ID (allowed to persist)")
    title: str = Field(..., description="Display name of the place from Google Maps")
    uri: str = Field(..., description="Google Maps URL for user attribution")


class AgentSchemaOutput(BaseModel):
    """Structured output payload emitted by one of the specialist agents/tools."""
    agent_name: str = Field(
        ...,
        description="Specialist agent persona (prioritization_agent, destination_agent, verification_agent, evac_readiness_coordinator)",
    )
    tool_name: str = Field(..., description="Name of the tool that produced the structured output")
    schema_name: str = Field(..., description="Pydantic output schema model name (e.g. RankPriorityTractsOutput)")
    data: Dict[str, Any] = Field(default_factory=dict, description="Structured output dictionary matching the tool schema")


class ActionDecisionRequest(BaseModel):
    """User decision (Approve, Reject, or Select Option) on a RecommendedAction in the chat widget."""
    action_id: str
    decision: Literal["APPROVED", "REJECTED", "OPTION_SELECTED"]
    selected_option_id: Optional[str] = None
    selected_option_label: Optional[str] = None
    note: Optional[str] = None
    county: Optional[str] = "Lee"
    session_id: Optional[str] = "default-session"
    action: Optional[Dict[str, Any]] = None


class ActionDecisionResponse(BaseModel):
    """Confirmation of a recorded user decision on a RecommendedAction."""
    status: str = "recorded"
    action_id: str
    decision: Literal["APPROVED", "REJECTED", "OPTION_SELECTED"]
    selected_option_id: Optional[str] = None
    selected_option_label: Optional[str] = None
    decided_at: str
    note: Optional[str] = None
    applied_summary: str
    follow_up_prompt: Optional[str] = None


class TractVulnerabilityItem(BaseModel):
    geo_id: str
    county_fips: str
    total_pop: int
    households_no_vehicle: int
    pct_no_vehicle: Optional[float] = None
    pct_age_65_plus: Optional[float] = None
    pct_disability: Optional[float] = None
    pct_mobility: Optional[float] = None
    mobile_homes: Optional[int] = None
    nearest_shelter_km: Optional[float] = None
    nearest_wheelchair_shelter_km: Optional[float] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    priority_reason: str


class ShelterCandidateItem(BaseModel):
    shelter_id: str
    shelter_name: str
    address_1: Optional[str] = None
    city: Optional[str] = None
    county_name: Optional[str] = None
    latitude: float
    longitude: float
    evacuation_capacity: Optional[int] = None
    post_impact_capacity: Optional[int] = None
    wheelchair_status: str = Field(..., description="'YES', 'NO', or 'UNRECORDED'")
    generator_status: str = Field(..., description="'YES', 'NO', or 'UNRECORDED'")
    in_surge_slosh_area: Optional[bool] = None
    is_medical: bool = False
    usage: Optional[str] = None
    maps_verified_status: Optional[str] = Field(
        None, description="Live status from Google Maps grounding (e.g. 'Confirmed Open', 'Renamed', 'Unverified')"
    )
    maps_attribution: Optional[MapsGroundingChunk] = None


class ChatRequest(BaseModel):
    message: str
    county: Optional[str] = "Lee"
    state: Optional[str] = "FL"
    session_id: Optional[str] = "default-session"


class ChatResponse(BaseModel):
    reply: str
    county: str
    state: str
    tools_called: List[str] = Field(default_factory=list)
    elapsed_seconds: Optional[float] = None
    agent_url: Optional[str] = None
    grounding_chunks: List[MapsGroundingChunk] = Field(default_factory=list)
    recommended_actions: List[RecommendedAction] = Field(
        default_factory=list,
        description="Structured Pydantic recommended actions (with LocationInfo, attention_items, approval details, and selectable options) emitted by the agents and tools.",
    )
    agent_outputs: List[AgentSchemaOutput] = Field(
        default_factory=list,
        description="Structured Pydantic tool output schemas grouped by specialist agent persona.",
    )
