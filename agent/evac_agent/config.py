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


def table(name: str) -> str:
    return f"`{PROJECT}.{DATASET}.{name}`"


# The room shares Gemini capacity; 429s are expected. Back off and retry instead of failing.
RETRY = dict(attempts=6, initial_delay=2.0, max_delay=30.0, exp_base=2.0, jitter=1.0,
             http_status_codes=[429, 500, 503])
