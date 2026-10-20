"""Pydantic schemas shared between the ADK Agent, FastAPI server, and React frontend."""

from typing import List, Optional
from pydantic import BaseModel, Field


class MapsGroundingChunk(BaseModel):
    """Represents a single Google Maps grounding source for compliant UI attribution."""
    place_id: Optional[str] = Field(None, description="Google Maps Place ID (allowed to persist)")
    title: str = Field(..., description="Display name of the place from Google Maps")
    uri: str = Field(..., description="Google Maps URL for user attribution")


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
    county: Optional[str] = "Miami-Dade"
    state: Optional[str] = "FL"
    session_id: Optional[str] = "default-session"


class ChatResponse(BaseModel):
    reply: str
    county: str
    state: str
    grounding_chunks: List[MapsGroundingChunk] = Field(default_factory=list)
