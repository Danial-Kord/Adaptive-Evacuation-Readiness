#!/usr/bin/env bash
#
# A4I 2026 - Challenge 4: Adaptive Evacuation Readiness & Vulnerable Community Planning
# Headless fallback for notebooks/c4_01_load_explore.ipynb
#
# Rebuilds the same BigQuery tables the notebook produces, from a pre-staged
# snapshot in Cloud Storage. Use this when a Colab Enterprise runtime is slow or
# unavailable, or when one of the upstream publishers is not cooperating.
#
# Run it from the repo root in Cloud Shell (no chmod needed - invoke with bash):
#     bash scripts/load.sh                 # defaults to FL
#     bash scripts/load.sh TX
#     bash scripts/load.sh --list          # show available states
#
# You still want the notebook if you can run it. Section 2 shows you the
# differentiator failing at the question you most need answered, and Section 6
# walks through five defects in this federal data that will otherwise bite you
# silently. This script gets you the same tables without any of that.

set -euo pipefail

BUCKET="gs://class-demo/a4i-2026/challenge-4-evacuation"
DATASET="evacuation_readiness"
LOCATION="US"
TABLES=(shelters vulnerability_tracts hazard_tracts care_facilities power_dependent_counties)

# Tables the challenge cannot be attempted without. care_facilities and
# power_dependent_counties are loaded but not required - a state can be worked
# without them, and a missing one should not stop the room.
REQUIRED=(shelters vulnerability_tracts hazard_tracts)

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }
fail()  { printf '\n\033[1mERROR:\033[0m %s\n\n%s\n\n' "$*" \
          "This script is safe to run again - every table load replaces whatever was there." >&2
          exit 1; }

on_interrupt() {
  printf '\n\n\033[1mInterrupted.\033[0m Nothing is broken.\n'
  printf 'Every load replaces the whole table, so just run this script again:\n'
  printf '    bash scripts/load.sh %s\n\n' "${STATE:-<state>}"
  exit 130
}
trap on_interrupt INT TERM

list_states() {
  bold "States available in the snapshot"
  if ! gcloud storage ls "${BUCKET}/" 2>/dev/null | sed 's|.*/\([^/]*\)/$|  \1|' | grep -v '^\s*$'; then
    fail "Could not list ${BUCKET}/. Check that you have network access."
  fi
  echo
  echo "Usage: bash scripts/load.sh <STATE>"
  echo "Any US state works in the notebook. These are the ones we pre-staged."
}

# --------------------------------------------------------------------------
# Arguments
# --------------------------------------------------------------------------
STATE="${1:-FL}"

if [[ "${STATE}" == "--list" || "${STATE}" == "-l" ]]; then
  list_states
  exit 0
fi

if [[ "${STATE}" == "--help" || "${STATE}" == "-h" ]]; then
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

STATE="$(echo "${STATE}" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')"

[[ "${STATE}" =~ ^[A-Z]{2}$ ]] \
  || fail "'${STATE}' is not a two-letter state abbreviation. Try: bash scripts/load.sh FL"

SRC="${BUCKET}/${STATE}"

# --------------------------------------------------------------------------
# Preflight
# --------------------------------------------------------------------------
bold "A4I Challenge 4 - loading evacuation readiness data for: ${STATE}"
echo

command -v bq     >/dev/null 2>&1 || fail "'bq' not found. Run this in Cloud Shell."
command -v gcloud >/dev/null 2>&1 || fail "'gcloud' not found. Run this in Cloud Shell."

PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
[[ -n "${PROJECT_ID}" && "${PROJECT_ID}" != "(unset)" ]] \
  || fail "No project set. Run: gcloud config set project YOUR_PROJECT_ID"

info "Project  : ${PROJECT_ID}"
info "Source   : ${SRC}"
info "Dataset  : ${DATASET} (${LOCATION})"
echo

if ! gcloud storage ls "${SRC}/" >/dev/null 2>&1; then
  echo
  bold "No snapshot found for '${STATE}'."
  echo
  list_states
  exit 1
fi

# --------------------------------------------------------------------------
# Create the dataset
# --------------------------------------------------------------------------
bold "1/3  Creating dataset"

# `bq ls -d NAME` does NOT ask "does this dataset exist". It lists the datasets
# inside a PROJECT called NAME, so it reports nothing for a dataset name and the
# script falls through to `mk`, which then dies on a dataset that is already
# there. That never shows up on a first run - it only bites on the second, which
# is exactly when you are re-running because something went wrong the first time.
dataset_exists() {
  bq --project_id="${PROJECT_ID}" show --dataset --format=none \
     "${PROJECT_ID}:${DATASET}" >/dev/null 2>&1
}

if dataset_exists; then
  info "${DATASET} already exists - reusing it"

  existing_loc="$(bq --project_id="${PROJECT_ID}" --format=json show --dataset \
                     "${PROJECT_ID}:${DATASET}" 2>/dev/null \
                  | tr ',' '\n' | grep -i '"location"' | head -1 \
                  | sed 's/.*: *"\([^"]*\)".*/\1/' || true)"
  if [[ -n "${existing_loc}" && "${existing_loc^^}" != "${LOCATION^^}" ]]; then
    fail "Dataset ${DATASET} already exists in '${existing_loc}', but this script loads into
       '${LOCATION}'. BigQuery cannot load across regions. Either delete the dataset
       (bq rm -r -d ${DATASET}) or edit LOCATION at the top of this script to match."
  fi
else
  # Belt and braces. If the check above ever misfires, or two teammates run this
  # in the same shared project at the same second, "already exists" is a fine
  # outcome and not an error. Anything else is.
  if mk_out="$(bq --project_id="${PROJECT_ID}" --location="${LOCATION}" \
                  mk --dataset "${PROJECT_ID}:${DATASET}" 2>&1)"; then
    info "created ${DATASET}"
  elif grep -qi "already exists" <<<"${mk_out}"; then
    info "${DATASET} already exists - reusing it"
  else
    fail "Could not create dataset ${DATASET}:
       ${mk_out}"
  fi
fi
echo

# --------------------------------------------------------------------------
# Load each table
# --------------------------------------------------------------------------
# Every load uses --replace, so re-running from scratch is always safe.
bold "2/3  Loading tables"
for table in "${TABLES[@]}"; do
  uri="${SRC}/${table}/*.parquet"

  if ! gcloud storage ls "${SRC}/${table}/" >/dev/null 2>&1; then
    if printf '%s\n' "${REQUIRED[@]}" | grep -qx "${table}"; then
      fail "Missing ${SRC}/${table}/. The snapshot for '${STATE}' looks incomplete - tell a coach."
    fi
    info "${table} not in this snapshot - skipping (optional)"
    continue
  fi

  info "loading ${table}..."
  bq --project_id="${PROJECT_ID}" --location="${LOCATION}" load \
     --source_format=PARQUET \
     --replace \
     "${DATASET}.${table}" \
     "${uri}" >/dev/null

  info "  done"
done
echo

# --------------------------------------------------------------------------
# Verify - never trust a load you did not check
# --------------------------------------------------------------------------
bold "3/3  Verifying"
FAILED=0
for table in "${TABLES[@]}"; do
  if ! bq --project_id="${PROJECT_ID}" show --format=none \
          "${PROJECT_ID}:${DATASET}.${table}" >/dev/null 2>&1; then
    printf '  %-28s %s\n' "${table}" "not loaded (optional)"
    continue
  fi

  rows="$(bq --project_id="${PROJECT_ID}" --location="${LOCATION}" \
            query --use_legacy_sql=false --format=csv \
            "SELECT COUNT(*) FROM \`${PROJECT_ID}.${DATASET}.${table}\`" \
          | tail -n 1)"

  if [[ "${rows}" == "0" ]] && printf '%s\n' "${REQUIRED[@]}" | grep -qx "${table}"; then
    printf '  %-28s %s\n' "${table}" "0 rows  <-- EMPTY"
    FAILED=1
  else
    printf '  %-28s %s rows\n' "${table}" "${rows}"
  fi
done
echo

# The numbers that decide whether the challenge is doable on this state, as
# opposed to whether the load worked. Every structural check above can pass on a
# state whose shelters and tracts are in different places, or whose accessibility
# column is entirely blank - both of which load perfectly and then answer nothing.
bold "Does this state actually support the challenge?"
read -r shelters tracts unrecorded medical reachable <<<"$(
  bq --project_id="${PROJECT_ID}" --location="${LOCATION}" \
     query --use_legacy_sql=false --format=csv \
     "SELECT
        (SELECT COUNT(*) FROM \`${PROJECT_ID}.${DATASET}.shelters\`),
        (SELECT COUNT(*) FROM \`${PROJECT_ID}.${DATASET}.vulnerability_tracts\`),
        (SELECT COUNTIF(wheelchair_accessible IS NULL)
           FROM \`${PROJECT_ID}.${DATASET}.shelters\`),
        (SELECT COUNTIF(is_medical) FROM \`${PROJECT_ID}.${DATASET}.shelters\`),
        (SELECT COUNT(DISTINCT t.geo_id)
           FROM \`${PROJECT_ID}.${DATASET}.vulnerability_tracts\` t
           JOIN \`${PROJECT_ID}.${DATASET}.shelters\` s
             ON ST_DWITHIN(ST_GEOGPOINT(t.lon, t.lat),
                           ST_GEOGPOINT(s.longitude, s.latitude), 25000)
           WHERE t.lat IS NOT NULL)" \
  | tail -n 1 | tr ',' ' '
)"

printf '  %-42s %s\n' "shelters"                              "${shelters}"
printf '  %-42s %s\n' "census tracts"                         "${tracts}"
printf '  %-42s %s\n' "shelters with NO recorded accessibility" "${unrecorded}"
printf '  %-42s %s\n' "medical-needs shelters"                "${medical}"
printf '  %-42s %s\n' "tracts with a shelter within 25 km"    "${reachable}"
echo

if [[ "${reachable}" == "0" ]]; then
  info "  <-- ZERO tracts can reach a shelter. Your tables loaded perfectly and every"
  info "      distance query will return nothing. Tell a coach before building on this."
  FAILED=1
fi

if [[ "${medical}" == "0" ]]; then
  info "  NOTE: no medical-needs shelters in ${STATE}. That is a real finding, not a"
  info "  broken load - but do not hang your whole demo on medical-needs matching here."
fi

if [[ "${unrecorded}" == "0" ]]; then
  info "  NOTE: every shelter in ${STATE} has accessibility recorded. That would be"
  info "  remarkable - nationally two thirds are blank. Say so on your slide."
fi
echo

if [[ "${FAILED}" -eq 1 ]]; then
  fail "One or more required tables loaded empty, or no tract can reach a shelter. Tell a coach."
fi

bold "Ready."
echo
echo "  Your tables are in ${PROJECT_ID}.${DATASET}"
echo "  Safe to re-run at any time - each load replaces the whole table."
echo
echo "  IMPORTANT, and it is the whole point of this challenge: 'wheelchair_accessible'"
echo "  is NULL for most shelters. That means nobody recorded it - not that the answer"
echo "  is no. Treat unrecorded as its own category or you will report a fact about"
echo "  paperwork as a fact about buildings."
echo
echo "  Next: build your agent. On a Gemini 3.x model, Grounding with Google Maps can share"
echo "  one agent with your own function tools. On 2.5 or older it cannot - wrap a maps-only"
echo "  agent in AgentTool. See the README for the exact error message and both architectures."
echo
