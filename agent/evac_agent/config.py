"""Constants the whole agent shares. Every threshold here is a modeling decision, defended in the deck."""
import os

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "qwiklabs-gcp-04-9708a89bd955")
DATASET = "evacuation_readiness"
MODEL = os.environ.get("EVAC_MODEL", "gemini-3.6-flash")

# Reachability. Straight-line distances from the tract population centroid.
# One mile is a generous walk for an older adult carrying a go-bag; a household with no
# vehicle beyond it needs a pickup. 25 km is the challenge's own "reachable by car" radius.
WALK_KM = 1.6
DRIVE_KM = 25.0

# Tracts at or above this share of population exposed to coastal flooding (FEMA NRI CFLD_EXPP)
# are treated as evacuation-zone tracts. Encoded in agent/sql/derived.sql.
COASTAL_FLOOD_SHARE = 0.25

# Parallel Maps grounding calls (5-8 s each).
VERIFY_WORKERS = 4
MAX_VERIFY = 15
# Hard limits so a quota stall can never freeze an answer: per Gemini call, and per batch of checks.
VERIFY_CALL_TIMEOUT_MS = 40_000
VERIFY_BUDGET_S = 75


def table(name: str) -> str:
    return f"`{PROJECT}.{DATASET}.{name}`"


# The room shares Gemini capacity; 429s are expected. Back off and retry instead of failing.
RETRY = dict(attempts=6, initial_delay=2.0, max_delay=30.0, exp_base=2.0, jitter=1.0,
             http_status_codes=[429, 500, 503])

# Fact labels used in every answer.
LBL = {
    "fema": "🕰️ FEMA record (historical)",
    "live": "🟢 Google Maps (live)",
    "measured": "📊 ACS (measured)",
    "modeled": "🧮 CDC PLACES (modeled)",
    "unrecorded": "❓ unrecorded",
    "county": "🗺️ HHS emPOWER (county-level only)",
    "straight": "📏 straight-line",
    "drive": "🚗 Google Maps drive time",
    "nri": "🌊 FEMA NRI (modeled hazard, tract-level)",
}
LEGEND = ("🕰️ historical FEMA record · 🟢 live Google Maps check · 📊 measured (Census) · 🧮 modeled (CDC) · "
          "🌊 FEMA hazard model · ❓ unrecorded · 🗺️ county-level only · 📏 straight-line · 🚗 Google Maps drive time")

# Default priority weights. No-car households weigh double: the measured (not modeled) signal that a
# household cannot leave on its own. The manager can change these in conversation.
DEFAULT_WEIGHTS = {"no_car": 2.0, "older": 1.0, "disability": 1.0, "mobile_homes": 1.0, "flood": 1.0}

# Default reachability rules (manager-adjustable):
#   has a car -> reachable within CAR_DRIVE_MIN minutes of Google Maps drive time
#   no car    -> reachable within WALK_MILES straight-line (1 mile ~ 20 min walk carrying a go-bag)
#   no car + mobility disability -> nothing is walkable; needs door-to-door pickup
DEFAULT_RULES = {"car_drive_minutes": 30.0, "walk_miles": 1.0}
