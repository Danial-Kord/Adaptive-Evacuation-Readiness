"""Root ADK Agent definition combining Gemini 3.x, Google Maps Grounding, and BigQuery tools."""

import os
from dotenv import load_dotenv
from google.adk.agents import Agent
from google.adk.tools import google_maps_grounding

from .prompts import SYSTEM_INSTRUCTION
from .tools import (
    analyze_shelter_readiness,
    get_power_and_medical_gaps,
    get_vulnerable_tracts,
)

load_dotenv()

# Gemini 3.x supports built-in `google_maps_grounding` alongside custom function tools in a single agent.
MODEL_NAME = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")

root_agent = Agent(
    name="evacuation_readiness_agent",
    model=MODEL_NAME,
    description=(
        "Pre-season Adaptive Evacuation Readiness & Vulnerable Community Planning Agent "
        "that combines BigQuery federal vulnerability/shelter data with live Google Maps grounding."
    ),
    instruction=SYSTEM_INSTRUCTION,
    tools=[
        google_maps_grounding,
        get_vulnerable_tracts,
        analyze_shelter_readiness,
        get_power_and_medical_gaps,
    ],
)
