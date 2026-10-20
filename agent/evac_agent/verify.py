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
from google.adk.tools.tool_context import ToolContext
from google.genai import types

from .config import LBL, MAX_VERIFY, MODEL, PROJECT, RETRY, VERIFY_BUDGET_S, VERIFY_CALL_TIMEOUT_MS, VERIFY_WORKERS, table
from .data import _bq, _rows
from .schemas import (
    ActionOption,
    ActionSeverity,
    ActionType,
    ApprovalDetails,
    AttentionItem,
    InteractionMode,
    LocationInfo,
    MapsGroundingChunk,
    RecommendedAction,
    ShelterVerificationResultItem,
    VerifySheltersLiveOutput,
    record_actions_in_state,
)


@lru_cache(maxsize=1)
def _client() -> genai.Client:
    return genai.Client(
        vertexai=True,
        project=PROJECT,
        location="global",
        http_options=types.HttpOptions(
            timeout=VERIFY_CALL_TIMEOUT_MS,
            retry_options=types.HttpRetryOptions(**{**RETRY, "attempts": 3, "max_delay": 10.0}),
        ),
    )


def _maps_tool(routing: bool) -> types.Tool:
    gt = types.GoogleMapsGroundingTypes(
        places=types.GoogleMapsPlaces(),
        routing=types.GoogleMapsRouting() if routing else None,
    )
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

FIELDS = {
    "FOUND": "found",
    "MAPS NAME": "maps_name",
    "MAPS ADDRESS": "maps_address",
    "PLACE TYPE": "place_type",
    "STATUS": "business_status",
    "SAME PLACE AS REGISTRY": "same_place_as_registry",
    "WHEELCHAIR ENTRANCE": "wheelchair_accessible_entrance",
    "ACCESSIBILITY ATTRIBUTES": "accessibility_attributes",
    "DRIVE": "drive",
    "NOTES": "notes",
}


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
    ans["wheelchair_accessible_entrance"] = (
        "no" if "not wheelchair" in wc else "yes" if "lists a wheelchair" in wc else "not listed"
    )
    m = re.search(r"(\d+(?:\.\d+)?)\s*min[^,]*,\s*(\d+(?:\.\d+)?)\s*km", ans.get("drive", ""))
    ans["drive_minutes"], ans["drive_km"] = (float(m.group(1)), float(m.group(2))) if m else (None, None)
    return ans, grounded


def _street_no(addr: str | None) -> str | None:
    m = re.match(r"\s*(\d+)", addr or "")
    return m.group(1) if m else None


def _similar(a: str, b: str) -> float:
    norm = lambda s: re.sub(r"[^a-z0-9 ]", "", (s or "").lower())
    return difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()


def _build_shelter_action(
    s: dict,
    verdict: str,
    action_text: str,
    flags: list[str],
    access: str,
    maps_says: dict | None,
    sources: list[dict],
    route: dict | None,
) -> tuple[LocationInfo, RecommendedAction]:
    sid = int(s["shelter_id"])
    cap = s.get("evacuation_capacity")
    src0 = sources[0] if sources else {}
    loc = LocationInfo(
        lat=s.get("latitude"),
        lon=s.get("longitude"),
        label=s.get("shelter_name") or f"Shelter #{sid}",
        address=s.get("address"),
        city=s.get("city"),
        county=s.get("county_name"),
        county_fips=s.get("county_fips"),
        shelter_id=sid,
        place_id=src0.get("place_id"),
        maps_uri=src0.get("uri"),
    )
    maps_chunks = [
        MapsGroundingChunk(
            place_id=x.get("place_id"),
            title=(x.get("title") or "").replace(" - Google Maps", "").strip() or "Google Maps Place",
            uri=x["uri"],
        )
        for x in sources[:2]
        if x.get("uri")
    ]
    attention = [
        AttentionItem(
            label="Live Google Maps Verdict",
            value=verdict,
            source_badge=LBL["live"],
            is_warning=(verdict != "CONFIRMED_EXISTS"),
        ),
        AttentionItem(
            label="Accessibility Reconciliation",
            value=access,
            source_badge=f"{LBL['fema']} / {LBL['live']}",
            is_warning=("CONFLICT" in access or "Unknown" in access or "unrecorded" in access.lower()),
        ),
        AttentionItem(
            label="Recorded Capacity",
            value=str(cap) if cap is not None else "❓ unrecorded",
            source_badge=LBL["fema"],
            is_warning=(cap in (None, 0)),
        ),
    ]
    if route and route.get("drive_minutes") is not None:
        attention.append(
            AttentionItem(
                label="Live Drive Time",
                value=f"{route['drive_minutes']} min ({route.get('drive_miles', '?')} mi)",
                source_badge=LBL["drive"],
            )
        )

    maps_name = (maps_says or {}).get("maps_name") or ""
    maps_addr = (maps_says or {}).get("maps_address") or ""

    if verdict == "CLOSED":
        rec_action = RecommendedAction(
            action_id=f"act-verify-closed-{sid}",
            action_type=ActionType.DROP_CLOSED_SHELTER,
            agent_source="verification_agent",
            interaction_mode=InteractionMode.APPROVAL_REQUIRED,
            requires_approval=True,
            requires_selection=False,
            severity=ActionSeverity.CRITICAL,
            title=f"Drop Permanently Closed Shelter: {s.get('shelter_name')} (#{sid})",
            summary=f"{LBL['live']} reports '{s.get('shelter_name')}' at {s.get('address')}, {s.get('city')} is permanently closed. {action_text}",
            affected_count=int(cap or 0),
            affected_unit="spaces",
            primary_location=loc,
            attention_items=attention,
            approval=ApprovalDetails(
                confirm_label="Approve Removal From Plan",
                reject_label="Keep Pending Field Check",
                proposed_change=f"Remove closed shelter #{sid} ({s.get('shelter_name')}, {cap or 0} spaces) from active evacuation plan.",
                target_entity_type="shelter",
                target_entity_id=str(sid),
                payload={"shelter_id": sid, "verdict": verdict, "capacity_removed": cap},
                irreversible_or_high_impact=True,
            ),
            maps_sources=maps_chunks,
        )
    elif verdict == "RENAMED_OR_REBRANDED":
        rec_action = RecommendedAction(
            action_id=f"act-verify-renamed-{sid}",
            action_type=ActionType.UPDATE_SHELTER_REGISTRY_NAME,
            agent_source="verification_agent",
            interaction_mode=InteractionMode.APPROVAL_REQUIRED,
            requires_approval=True,
            requires_selection=False,
            severity=ActionSeverity.MEDIUM,
            title=f"Approve Registry Name Update: '{s.get('shelter_name')}' -> '{maps_name}'",
            summary=f"Same address ({s.get('address')}, {s.get('city')}), now listed on Google Maps as '{maps_name}'. {action_text}",
            affected_count=int(cap or 0),
            affected_unit="spaces",
            primary_location=loc,
            attention_items=attention,
            approval=ApprovalDetails(
                confirm_label="Approve Name Update",
                reject_label="Keep FEMA Name",
                proposed_change=f"Update display name for shelter #{sid} from '{s.get('shelter_name')}' to '{maps_name}'.",
                target_entity_type="shelter",
                target_entity_id=str(sid),
                payload={"shelter_id": sid, "old_name": s.get("shelter_name"), "new_name": maps_name},
                irreversible_or_high_impact=False,
            ),
            maps_sources=maps_chunks,
        )
    elif verdict in ("NOT_FOUND_ON_MAPS", "DIFFERENT_PLACE_AT_ADDRESS", "FOUND_AT_DIFFERENT_ADDRESS"):
        options = [
            ActionOption(
                option_id=f"hold-check-{sid}",
                label="Hold Capacity & Dispatch In-Person Check (Recommended)",
                description=f"Do not count {cap or 0} spaces in active plan until staff confirm the building at {s.get('address')}, {s.get('city')}.",
                recommended=True,
                location=loc,
                metrics={"shelter_id": sid, "action": "hold_and_verify", "capacity": cap},
            ),
            ActionOption(
                option_id=f"drop-shelter-{sid}",
                label="Drop Shelter From Active Plan",
                description=f"Remove '{s.get('shelter_name')}' (#{sid}) from this season's shelter roster.",
                recommended=False,
                location=loc,
                metrics={"shelter_id": sid, "action": "drop", "capacity": cap},
                warnings=["Removes shelter capacity from county plan"],
            ),
        ]
        if verdict == "FOUND_AT_DIFFERENT_ADDRESS" and maps_addr:
            options.append(
                ActionOption(
                    option_id=f"use-maps-addr-{sid}",
                    label=f"Confirm & Update Address to '{maps_addr}'",
                    description=f"Google Maps found '{maps_name}' at '{maps_addr}'. Confirm with operator and update registry address.",
                    recommended=False,
                    location=loc.model_copy(update={"address": maps_addr}),
                    metrics={"shelter_id": sid, "action": "update_address", "new_address": maps_addr},
                )
            )
        rec_action = RecommendedAction(
            action_id=f"act-verify-discrepancy-{sid}",
            action_type=ActionType.IN_PERSON_BUILDING_CHECK,
            agent_source="verification_agent",
            interaction_mode=InteractionMode.SELECT_BETWEEN_OPTIONS,
            requires_approval=True,
            requires_selection=True,
            severity=ActionSeverity.HIGH,
            title=f"Resolve Building Discrepancy ({verdict}): {s.get('shelter_name')}",
            summary=f"{s.get('shelter_name')} at {s.get('address')}, {s.get('city')}: {action_text}",
            affected_count=int(cap or 0),
            affected_unit="spaces",
            primary_location=loc,
            attention_items=attention,
            approval=ApprovalDetails(
                confirm_label="Apply Selected Action",
                reject_label="Defer",
                proposed_change=f"Apply selected verification disposition for shelter #{sid} ({s.get('shelter_name')}).",
                target_entity_type="shelter",
                target_entity_id=str(sid),
                payload={"shelter_id": sid, "verdict": verdict, "flags": flags},
                irreversible_or_high_impact=True,
            ),
            options=options,
            selected_option_id=f"hold-check-{sid}",
            maps_sources=maps_chunks,
        )
    else:
        # CONFIRMED_EXISTS or UNVERIFIED
        has_conflict = "CONFLICT" in access
        rec_action = RecommendedAction(
            action_id=f"act-verify-operator-{sid}",
            action_type=ActionType.INTERVIEW_SHELTER_OPERATOR,
            agent_source="verification_agent",
            interaction_mode=InteractionMode.APPROVAL_REQUIRED,
            requires_approval=True,
            requires_selection=False,
            severity=ActionSeverity.HIGH if has_conflict else ActionSeverity.MEDIUM,
            title=f"Confirm Accessibility & Generator With Operator: {s.get('shelter_name')}",
            summary=f"{action_text} {access}",
            affected_count=int(cap or 0),
            affected_unit="spaces",
            primary_location=loc,
            attention_items=attention,
            approval=ApprovalDetails(
                confirm_label="Request Operator Assessment",
                reject_label="Skip for Now",
                proposed_change=f"Initiate operator accessibility/generator verification (`record_shelter_assessment`) for shelter #{sid}.",
                target_entity_type="shelter",
                target_entity_id=str(sid),
                payload={
                    "shelter_id": sid,
                    "fema_wheelchair": s.get("wheelchair", "UNRECORDED"),
                    "fema_generator": s.get("generator", "UNRECORDED"),
                    "verdict": verdict,
                },
                irreversible_or_high_impact=False,
            ),
            maps_sources=maps_chunks,
        )
    return loc, rec_action


def _verify_one(s: dict, origin: tuple[float, float] | None) -> dict:
    route_q = ROUTE_Q.format(lat=origin[0], lon=origin[1]) if origin else ""
    prompt = PROMPT.format(
        name=s["shelter_name"],
        address=s["address"],
        city=s["city"],
        zip=s.get("zip") or "",
        route_q=route_q,
    )
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
                model=MODEL,
                contents=(
                    prompt
                    if use_routing or not origin
                    else PROMPT.format(
                        name=s["shelter_name"],
                        address=s["address"],
                        city=s["city"],
                        zip=s.get("zip") or "",
                        route_q="",
                    )
                ),
                config=types.GenerateContentConfig(tools=[_maps_tool(routing=use_routing)], temperature=0),
            )
        except Exception as e:  # one failed lookup must not sink the brief
            err = str(e)[:200]
            continue
        gm = r.candidates[0].grounding_metadata if r.candidates else None
        ans, grounded = _parse(r.text, gm.grounding_supports if gm else None)
        sources, route = [], None
        for ch in gm.grounding_chunks if gm and gm.grounding_chunks else []:
            if not ch.maps:
                continue
            if ch.maps.route:
                if route is None:
                    secs = float(str(ch.maps.route.duration or "0s").rstrip("s") or 0)
                    route = {
                        "drive_minutes": round(secs / 60),
                        "drive_miles": round((ch.maps.route.distance_meters or 0) / 1609.34, 1),
                        "source": "Google Maps route",
                    }
                continue
            sources.append({"title": ch.maps.title, "uri": ch.maps.uri, "place_id": ch.maps.place_id})
        if sources:
            break
    if not sources:
        act_str = (
            "Google Maps returned no source for this building; treat the FEMA record as unconfirmed and re-check."
        )
        acc_str = f"FEMA records {s.get('wheelchair', 'UNRECORDED')}; not checked live."
        loc, rec_action = _build_shelter_action(s, "UNVERIFIED", act_str, [], acc_str, None, [], None)
        item = ShelterVerificationResultItem(
            shelter_id=int(s["shelter_id"]),
            registry_name=s["shelter_name"],
            registry_address=f"{s['address']}, {s['city']}",
            location=loc,
            verdict="UNVERIFIED",
            action=act_str,
            flags=[],
            error=err,
            accessibility=acc_str,
            drive=None,
            google_maps_sources=[],
            checked_at=checked_at,
            recommended_action=rec_action,
        )
        return item.model_dump()

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
    elif (
        _street_no(s["address"])
        and _street_no(ans.get("maps_address"))
        and _street_no(s["address"]) != _street_no(ans.get("maps_address"))
    ):
        verdict, action = (
            "FOUND_AT_DIFFERENT_ADDRESS",
            "Google Maps found a similarly named place at a different address: the registry building may have closed or moved. Confirm before counting it.",
        )
        flags.append(f"registry address '{s['address']}' vs Google Maps '{ans.get('maps_address')}'")
    elif name_sim < 0.55:
        verdict, action = (
            "RENAMED_OR_REBRANDED",
            "Same address, different name: update the registry so a name lookup still finds it.",
        )
        flags.append(f"registry name '{s['shelter_name']}' vs Google Maps '{ans.get('maps_name')}'")
    else:
        verdict, action = (
            "CONFIRMED_EXISTS",
            "Building exists as recorded. Accessibility and generator still need confirming where unrecorded.",
        )
    if status == "CLOSED_TEMPORARILY":
        flags.append("Google Maps lists it as temporarily closed")

    maps_wc = ans.get("wheelchair_accessible_entrance", "not listed")
    # Only accept an accessibility claim that Gemini's grounding metadata ties to a Maps source.
    if maps_wc in ("yes", "no") and "wheelchair_accessible_entrance" not in grounded:
        maps_wc = "not listed"
        flags.append("model claimed an accessibility answer without a Google Maps citation; ignored")
    fema_wc = s.get("wheelchair", "UNRECORDED")
    if maps_wc == "yes" and fema_wc == "UNRECORDED":
        access = (
            "FEMA: unrecorded. Google Maps lists a wheelchair-accessible entrance. An entrance is not the "
            "same as a shelter usable unaccompanied: candidate to confirm with the operator."
        )
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
        route = {
            "drive_minutes": ans.get("drive_minutes"),
            "drive_miles": round(ans["drive_km"] * 0.621, 1) if ans.get("drive_km") else None,
            "source": (
                "Google Maps grounded answer (no route object returned)"
                if "drive" in grounded
                else "model-reported, not cited: treat as approximate"
            ),
        }

    maps_says = {k: ans.get(k) for k in ("maps_name", "maps_address", "place_type", "business_status", "notes")}
    loc, rec_action = _build_shelter_action(s, verdict, action, flags, access, maps_says, sources[:3], route)

    item = ShelterVerificationResultItem(
        shelter_id=int(s["shelter_id"]),
        registry_name=s["shelter_name"],
        registry_address=f"{s['address']}, {s['city']}",
        location=loc,
        verdict=verdict,
        action=action,
        flags=flags,
        google_maps_says=maps_says,
        accessibility=access,
        # yes / no / not listed, only when Gemini's grounding metadata cites Google Maps for it.
        maps_wheelchair_entrance=maps_wc,
        maps_accessibility_attributes=ans.get("accessibility_attributes") if maps_wc != "not listed" else None,
        grounded_fields=sorted(grounded),
        drive=route,
        google_maps_sources=sources[:3],
        maps_attribution=[
            f"Google Maps — [{(x['title'] or '').replace(' - Google Maps', '').strip() or 'place'}]({x['uri']})"
            for x in sources[:2]
        ],
        freshness={"registry": "FEMA NSS, historical record", "google_maps": f"checked live {checked_at}"},
        checked_at=checked_at,
        recommended_action=rec_action,
    )
    return item.model_dump()


def _store_place_ids(results: list[dict]) -> None:
    # place_id is the one piece of Google Maps content we may keep.
    rows = [
        {
            "shelter_id": r["shelter_id"],
            "place_id": src.get("place_id"),
            "maps_title": src.get("title"),
            "verified_at": r["checked_at"],
            "status": r["verdict"],
        }
        for r in results
        for src in r.get("google_maps_sources", [])[:1]
        if src.get("place_id")
    ]
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
            s_obj = it if isinstance(it, dict) else {"shelter_id": it[0]}
            sid = int(s_obj["shelter_id"])
            act_str = "Live check did not finish in time (shared Gemini quota); re-check before relying on it."
            loc, rec_action = _build_shelter_action(
                s_obj, "UNVERIFIED", act_str, [], "not checked live", None, [], None
            )
            fallback = ShelterVerificationResultItem(
                shelter_id=sid,
                registry_name=s_obj.get("shelter_name"),
                registry_address=f"{s_obj.get('address', '')}, {s_obj.get('city', '')}".strip(", ") or None,
                location=loc,
                verdict="UNVERIFIED",
                flags=[],
                action=act_str,
                accessibility="not checked live",
                drive=None,
                google_maps_sources=[],
                checked_at=None,
                origin_tract=it[1] if isinstance(it, tuple) else None,
                recommended_action=rec_action,
            )
            out.append(fallback.model_dump())
    ex.shutdown(wait=False, cancel_futures=True)
    return out


def verify_shelters_live(
    shelter_ids: list[int],
    origin_tract: str = "",
    tool_context: ToolContext = None,
) -> dict:
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
      dict with one result per shelter (verdict, action, location, accessibility reconciliation,
      drive time, Google Maps sources with title/uri/place_id), a verdict tally, and structured
      `recommended_actions` (validated via `VerifySheltersLiveOutput`).
    """
    ids = [int(i) for i in shelter_ids][:MAX_VERIFY]
    if not ids:
        return {"error": "no shelter_ids given"}
    rows = _rows(
        f"""SELECT shelter_id, shelter_name, address, city, zip, county_name, county_fips,
                   ROUND(latitude, 5) AS latitude, ROUND(longitude, 5) AS longitude,
                   evacuation_capacity, wheelchair, generator, surge_flag
            FROM {table('shelters_enriched')} WHERE shelter_id IN UNNEST(@ids)""".replace(
            "@ids", "[" + ",".join(str(i) for i in ids) + "]"
        )
    )
    origin = None
    if origin_tract:
        t = _rows(f"SELECT lat, lon FROM {table('tract_readiness')} WHERE geo_id=@g", g=origin_tract)
        origin = (t[0]["lat"], t[0]["lon"]) if t else None
    results = _run_bounded(rows, lambda s: _verify_one(s, origin))
    _store_place_ids(results)
    tally: dict[str, int] = {}
    actions: list[RecommendedAction] = []
    result_items: list[ShelterVerificationResultItem] = []
    for r in results:
        tally[r["verdict"]] = tally.get(r["verdict"], 0) + 1
        item = ShelterVerificationResultItem(**r)
        result_items.append(item)
        if item.recommended_action:
            actions.append(item.recommended_action)

    record_actions_in_state(tool_context, actions)
    out = VerifySheltersLiveOutput(
        results=result_items,
        tally=tally,
        attribution_rule="Copy each result's maps_attribution lines verbatim directly under the content they support.",
        recommended_actions=actions,
    )
    return out.model_dump()


def verify_pairs(pairs: list[tuple[int, str]]) -> dict[tuple[int, str], dict]:
    """Verify (shelter_id, origin_tract) pairs in one parallel batch, keyed by the pair: a shelter shared
    by two tracts gets a drive time from each."""
    # Tract ids end up in SQL text below, so accept digits only.
    pairs = [(int(i), g if (g or "").isdigit() else "") for i, g in pairs][:MAX_VERIFY]
    if not pairs:
        return {}
    ids = ",".join(str(int(i)) for i, _ in pairs)
    shelters = {
        r["shelter_id"]: r
        for r in _rows(
            f"SELECT shelter_id, shelter_name, address, city, zip, county_name, county_fips, "
            f"ROUND(latitude, 5) AS latitude, ROUND(longitude, 5) AS longitude, "
            f"evacuation_capacity, wheelchair, generator, surge_flag "
            f"FROM {table('shelters_enriched')} WHERE shelter_id IN ({ids})"
        )
    }
    tracts = ",".join(f"'{g}'" for _, g in pairs if g)
    origins = (
        {
            r["geo_id"]: (r["lat"], r["lon"])
            for r in _rows(f"SELECT geo_id, lat, lon FROM {table('tract_readiness')} WHERE geo_id IN ({tracts})")
        }
        if tracts
        else {}
    )
    results = _run_bounded(
        [p for p in pairs if p[0] in shelters],
        lambda p: {**_verify_one(shelters[p[0]], origins.get(p[1])), "origin_tract": p[1]},
    )
    _store_place_ids(results)
    return {(r["shelter_id"], r.get("origin_tract") or ""): r for r in results}
