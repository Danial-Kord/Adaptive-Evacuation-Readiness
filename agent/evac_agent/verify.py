"""Live verification of FEMA shelter records against Grounding with Google Maps, one building at
a time. An area question about accessibility returns nothing; one named building at one address
gets a definite answer about 5 times in 8. This tool asks the narrow question, then decides what
the answer means for the plan."""
from __future__ import annotations

import datetime as dt
import difflib
import re
import time
from concurrent.futures import ThreadPoolExecutor, wait
from functools import lru_cache

from google import genai
from google.genai import types

from .config import MAX_VERIFY, MODEL, PROJECT, RETRY, VERIFY_BUDGET_S, VERIFY_CALL_TIMEOUT_MS, VERIFY_WORKERS, table
from .data import _bq, _rows


@lru_cache(maxsize=1)
def _client() -> genai.Client:
    return genai.Client(vertexai=True, project=PROJECT, location="global",
                        http_options=types.HttpOptions(
                            timeout=VERIFY_CALL_TIMEOUT_MS,
                            retry_options=types.HttpRetryOptions(**{**RETRY, "attempts": 3, "max_delay": 10.0})))


def _maps_tool(routing: bool) -> types.Tool:
    gt = types.GoogleMapsGroundingTypes(places=types.GoogleMapsPlaces(),
                                        routing=types.GoogleMapsRouting() if routing else None)
    return types.Tool(google_maps=types.GoogleMaps(grounding_types=gt))


PROMPT = """You are checking one entry in FEMA's historical hurricane-shelter registry against Google Maps.

Registry entry: "{name}", {address}, {city}, Florida {zip}.
Use Google Maps to answer about THIS building at THIS address only.{route_q}
Answer in exactly these lines, plain text, no JSON, no markdown:
FOUND: yes or no
MAPS NAME: current name on Google Maps
MAPS ADDRESS: address on Google Maps
PLACE TYPE: what kind of place it is
STATUS: OPERATIONAL, CLOSED_PERMANENTLY, CLOSED_TEMPORARILY or UNKNOWN
SAME PLACE AS REGISTRY: yes, no or unsure
WHEELCHAIR ENTRANCE: Google Maps lists a wheelchair accessible entrance / Google Maps says the entrance is not wheelchair accessible / not listed
ACCESSIBILITY ATTRIBUTES: the accessibility attributes exactly as Google Maps lists them, or none
DRIVE: <minutes> min, <km> km   (or: not requested)
NOTES: one short sentence on anything that changed"""

ROUTE_Q = " Also find the driving route from the point {lat:.5f},{lon:.5f} to this building."

FIELDS = {"FOUND": "found", "MAPS NAME": "maps_name", "MAPS ADDRESS": "maps_address", "PLACE TYPE": "place_type",
          "STATUS": "business_status", "SAME PLACE AS REGISTRY": "same_place_as_registry",
          "WHEELCHAIR ENTRANCE": "wheelchair_accessible_entrance", "ACCESSIBILITY ATTRIBUTES": "accessibility_attributes",
          "DRIVE": "drive", "NOTES": "notes"}


def _parse(text: str, supports) -> tuple[dict, set]:
    """Parse the labelled lines, and note which lines Gemini's grounding metadata ties to a Maps source."""
    seg_texts = [(sp.segment.text or "").strip() for sp in (supports or []) if sp.segment and sp.grounding_chunk_indices]
    ans, grounded = {}, set()
    for line in (text or "").splitlines():
        label, _, value = line.strip().strip("*").partition(":")
        key = FIELDS.get(label.strip().upper())
        if not key:
            continue
        value = value.strip()
        ans[key] = value
        if any(t and (t in line or line.strip() in t) for t in seg_texts):
            grounded.add(key)
    ans["found"] = ans.get("found", "").lower().startswith("yes")
    ans["business_status"] = (ans.get("business_status") or "UNKNOWN").upper()
    ans["same_place_as_registry"] = (ans.get("same_place_as_registry") or "unsure").lower()
    wc = (ans.get("wheelchair_accessible_entrance") or "").lower()
    ans["wheelchair_accessible_entrance"] = ("no" if "not wheelchair" in wc else "yes" if "lists a wheelchair" in wc
                                             else "not listed")
    m = re.search(r"(\d+(?:\.\d+)?)\s*min[^,]*,\s*(\d+(?:\.\d+)?)\s*km", ans.get("drive", ""))
    ans["drive_minutes"], ans["drive_km"] = (float(m.group(1)), float(m.group(2))) if m else (None, None)
    return ans, grounded


def _street_no(addr: str | None) -> str | None:
    m = re.match(r"\s*(\d+)", addr or "")
    return m.group(1) if m else None


def _similar(a: str, b: str) -> float:
    norm = lambda s: re.sub(r"[^a-z0-9 ]", "", (s or "").lower())
    return difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()


def _verify_one(s: dict, origin: tuple[float, float] | None) -> dict:
    route_q = ROUTE_Q.format(lat=origin[0], lon=origin[1]) if origin else ""
    prompt = PROMPT.format(name=s["shelter_name"], address=s["address"], city=s["city"],
                           zip=s.get("zip") or "", route_q=route_q)
    checked_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    # A grounded call sometimes comes back without Maps sources. An answer with no source is the
    # model talking, not Google Maps, so retry, then fall back to places-only before giving up.
    attempts = [True, True, False] if origin else [False, False]
    deadline = time.monotonic() + VERIFY_BUDGET_S * 0.8
    ans, sources, route, err, grounded = {}, [], None, None, set()
    for use_routing in attempts:
        if time.monotonic() > deadline:
            err = err or "time budget exhausted (shared Gemini quota)"
            break
        try:
            r = _client().models.generate_content(
                model=MODEL, contents=prompt if use_routing or not origin else PROMPT.format(
                    name=s["shelter_name"], address=s["address"], city=s["city"], zip=s.get("zip") or "", route_q=""),
                config=types.GenerateContentConfig(tools=[_maps_tool(routing=use_routing)], temperature=0))
        except Exception as e:  # one failed lookup must not sink the brief
            err = str(e)[:200]
            continue
        gm = r.candidates[0].grounding_metadata if r.candidates else None
        ans, grounded = _parse(r.text, gm.grounding_supports if gm else None)
        sources, route = [], None
        for ch in (gm.grounding_chunks if gm and gm.grounding_chunks else []):
            if not ch.maps:
                continue
            if ch.maps.route:
                if route is None:
                    secs = float(str(ch.maps.route.duration or "0s").rstrip("s") or 0)
                    route = {"drive_minutes": round(secs / 60),
                             "drive_miles": round((ch.maps.route.distance_meters or 0) / 1609.34, 1),
                             "source": "Google Maps route"}
                continue
            sources.append({"title": ch.maps.title, "uri": ch.maps.uri, "place_id": ch.maps.place_id})
        if sources:
            break
    if not sources:
        return {"shelter_id": s["shelter_id"], "registry_name": s["shelter_name"],
                "registry_address": f"{s['address']}, {s['city']}",
                "verdict": "UNVERIFIED", "action": "Google Maps returned no source for this building; treat the "
                "FEMA record as unconfirmed and re-check.", "flags": [], "error": err,
                "accessibility": f"FEMA records {s.get('wheelchair', 'UNRECORDED')}; not checked live.",
                "drive": None, "google_maps_sources": [], "checked_at": checked_at}

    found = bool(ans.get("found"))
    status = ans.get("business_status", "UNKNOWN")
    same = ans.get("same_place_as_registry", "unsure")
    name_sim = _similar(s["shelter_name"], ans.get("maps_name", ""))

    # The judgment: what a discrepancy means for the plan.
    flags = []
    if not found:
        verdict, action = "NOT_FOUND_ON_MAPS", "Do not count this capacity until someone confirms the building in person."
    elif status == "CLOSED_PERMANENTLY":
        verdict, action = "CLOSED", "Drop from the plan and find replacement capacity."
    elif same == "no":
        verdict, action = "DIFFERENT_PLACE_AT_ADDRESS", "Registry likely stale: confirm with the operator before relying on it."
    elif _street_no(s["address"]) and _street_no(ans.get("maps_address")) and \
            _street_no(s["address"]) != _street_no(ans.get("maps_address")):
        verdict, action = "FOUND_AT_DIFFERENT_ADDRESS", ("Google Maps found a similarly named place at a different "
                          "address: the registry building may have closed or moved. Confirm before counting it.")
        flags.append(f"registry address '{s['address']}' vs Google Maps '{ans.get('maps_address')}'")
    elif name_sim < 0.55:
        verdict, action = "RENAMED_OR_REBRANDED", "Same address, different name: update the registry so a name lookup still finds it."
        flags.append(f"registry name '{s['shelter_name']}' vs Google Maps '{ans.get('maps_name')}'")
    else:
        verdict, action = "CONFIRMED_EXISTS", "Building exists as recorded. Accessibility and generator still need confirming where unrecorded."
    if status == "CLOSED_TEMPORARILY":
        flags.append("Google Maps lists it as temporarily closed")

    maps_wc = ans.get("wheelchair_accessible_entrance", "not listed")
    # Only accept an accessibility claim that Gemini's grounding metadata ties to a Maps source.
    if maps_wc in ("yes", "no") and "wheelchair_accessible_entrance" not in grounded:
        maps_wc = "not listed"
        flags.append("model claimed an accessibility answer without a Google Maps citation; ignored")
    fema_wc = s.get("wheelchair", "UNRECORDED")
    if maps_wc == "yes" and fema_wc == "UNRECORDED":
        access = ("FEMA: unrecorded. Google Maps lists a wheelchair-accessible entrance. An entrance is not the "
                  "same as a shelter usable unaccompanied: candidate to confirm with the operator.")
    elif maps_wc == "yes" and fema_wc == "NO":
        access = "CONFLICT: FEMA records NO, Google Maps lists an accessible entrance. Ask the operator."
        flags.append("accessibility conflict")
    elif maps_wc == "no" and fema_wc == "YES":
        access = "CONFLICT: FEMA records YES, Google Maps says no accessible entrance. Ask the operator."
        flags.append("accessibility conflict")
    elif maps_wc == "yes" and fema_wc == "YES":
        access = "Two sources agree: FEMA YES and Google Maps lists an accessible entrance."
    elif fema_wc == "UNRECORDED":
        access = "Unknown: FEMA never recorded it and Google Maps does not say. Somebody has to ask."
    else:
        access = f"FEMA records {fema_wc}; Google Maps does not say."

    if route is None and origin and ans.get("drive_minutes") is not None:
        route = {"drive_minutes": ans.get("drive_minutes"),
                 "drive_miles": round(ans["drive_km"] * 0.621, 1) if ans.get("drive_km") else None,
                 "source": "Google Maps grounded answer (no route object returned)"
                 if "drive" in grounded else "model-reported, not cited: treat as approximate"}

    return {
        "shelter_id": s["shelter_id"], "registry_name": s["shelter_name"],
        "registry_address": f"{s['address']}, {s['city']}",
        "verdict": verdict, "action": action, "flags": flags,
        "google_maps_says": {k: ans.get(k) for k in ("maps_name", "maps_address", "place_type", "business_status", "notes")},
        "accessibility": access,
        "maps_accessibility_attributes": ans.get("accessibility_attributes") if maps_wc != "not listed" else None,
        "grounded_fields": sorted(grounded),
        "drive": route,
        "google_maps_sources": sources[:3],
        "maps_attribution": [f"Google Maps — [{(x['title'] or '').replace(' - Google Maps', '').strip() or 'place'}]({x['uri']})"
                             for x in sources[:2]],
        "freshness": {"registry": "FEMA NSS, historical record", "google_maps": f"checked live {checked_at}"},
        "checked_at": checked_at,
    }


def _store_place_ids(results: list[dict]) -> None:
    # place_id is the one piece of Google Maps content we may keep.
    rows = [{"shelter_id": r["shelter_id"], "place_id": src.get("place_id"), "maps_title": src.get("title"),
             "verified_at": r["checked_at"], "status": r["verdict"]}
            for r in results for src in r.get("google_maps_sources", [])[:1] if src.get("place_id")]
    if rows:
        try:
            _bq().insert_rows_json(f"{PROJECT}.evacuation_readiness.shelter_place_ids", rows)
        except Exception:
            pass


def _run_bounded(items: list, fn) -> list[dict]:
    """Run fn over items in parallel, but never wait longer than VERIFY_BUDGET_S. A lookup stuck behind
    the shared Gemini quota comes back UNVERIFIED instead of freezing the whole answer."""
    _client()  # build the shared client before the threads race to create (and drop) their own
    ex = ThreadPoolExecutor(max_workers=VERIFY_WORKERS)
    futures = [ex.submit(fn, it) for it in items]
    wait(futures, timeout=VERIFY_BUDGET_S)
    out = []
    for it, f in zip(items, futures):
        if f.done() and not f.exception():
            out.append(f.result())
        else:
            sid = it[0] if isinstance(it, tuple) else it["shelter_id"]
            out.append({"shelter_id": sid, "verdict": "UNVERIFIED", "flags": [],
                        "action": "Live check did not finish in time (shared Gemini quota); re-check before relying on it.",
                        "accessibility": "not checked live", "drive": None, "google_maps_sources": [],
                        "checked_at": None, "origin_tract": it[1] if isinstance(it, tuple) else None})
    ex.shutdown(wait=False, cancel_futures=True)
    return out


def verify_shelters_live(shelter_ids: list[int], origin_tract: str = "") -> dict:
    """Checks FEMA shelter records against Google Maps right now, one building at a time:
    does it still exist, has it been renamed, is it closed, does Maps list a wheelchair-accessible
    entrance, and (if origin_tract is given) the real driving time from that tract.

    Use this before recommending any shelter. Act on the verdicts: drop CLOSED shelters, flag
    NOT_FOUND / DIFFERENT_PLACE ones for in-person checks, and quote drive times instead of
    straight-line distance when available. 5-8 seconds per shelter, run in parallel.

    Args:
      shelter_ids: FEMA shelter_id values (max 15 per call).
      origin_tract: optional 11-digit census tract id; its population centroid is the routing origin.

    Returns:
      dict with one result per shelter (verdict, action, accessibility reconciliation, drive time,
      Google Maps sources with title/uri/place_id) and a verdict tally. Google Maps sources must be
      shown immediately after the content they support.
    """
    ids = [int(i) for i in shelter_ids][:MAX_VERIFY]
    if not ids:
        return {"error": "no shelter_ids given"}
    rows = _rows(f"""SELECT shelter_id, shelter_name, address, city, zip, wheelchair
                     FROM {table('shelters_enriched')} WHERE shelter_id IN UNNEST(@ids)""".replace(
        "@ids", "[" + ",".join(str(i) for i in ids) + "]"))
    origin = None
    if origin_tract:
        t = _rows(f"SELECT lat, lon FROM {table('tract_readiness')} WHERE geo_id=@g", g=origin_tract)
        origin = (t[0]["lat"], t[0]["lon"]) if t else None
    results = _run_bounded(rows, lambda s: _verify_one(s, origin))
    _store_place_ids(results)
    tally: dict[str, int] = {}
    for r in results:
        tally[r["verdict"]] = tally.get(r["verdict"], 0) + 1
    return {"results": results, "tally": tally,
            "attribution_rule": "Copy each result's maps_attribution lines verbatim directly under the content they support."}


def verify_pairs(pairs: list[tuple[int, str]]) -> dict[tuple[int, str], dict]:
    """Verify (shelter_id, origin_tract) pairs in one parallel batch, keyed by the pair: a shelter shared
    by two tracts gets a drive time from each."""
    # Tract ids end up in SQL text below, so accept digits only.
    pairs = [(int(i), g if (g or "").isdigit() else "") for i, g in pairs][:MAX_VERIFY]
    if not pairs:
        return {}
    ids = ",".join(str(int(i)) for i, _ in pairs)
    shelters = {r["shelter_id"]: r for r in _rows(
        f"SELECT shelter_id, shelter_name, address, city, zip, wheelchair FROM {table('shelters_enriched')} "
        f"WHERE shelter_id IN ({ids})")}
    tracts = ",".join(f"'{g}'" for _, g in pairs if g)
    origins = {r["geo_id"]: (r["lat"], r["lon"]) for r in _rows(
        f"SELECT geo_id, lat, lon FROM {table('tract_readiness')} WHERE geo_id IN ({tracts})")} if tracts else {}
    results = _run_bounded([p for p in pairs if p[0] in shelters],
                           lambda p: {**_verify_one(shelters[p[0]], origins.get(p[1])), "origin_tract": p[1]})
    _store_place_ids(results)
    return {(r["shelter_id"], r.get("origin_tract") or ""): r for r in results}
