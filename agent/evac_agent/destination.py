"""Q2 tools: where would people in a tract go, and can they get there? Reachability depends on the
household: a car, no car, or no car plus a mobility disability."""
from __future__ import annotations

from google.adk.tools.tool_context import ToolContext

from .config import DEFAULT_RULES, LBL, table
from .data import _rows
from .schemas import (
    ActionOption,
    ActionSeverity,
    ActionType,
    ApprovalDetails,
    AttentionItem,
    CarDestinationOption,
    ExcludedShelterItem,
    HouseholdsWithCarTier,
    HouseholdsWithoutCarTier,
    InteractionMode,
    LocationInfo,
    MapsGroundingChunk,
    NoCarMobilityTier,
    PlanDestinationsOutput,
    ReachabilityRulesOutput,
    RecommendedAction,
    TractDestinationPlanItem,
    WalkableShelterOption,
    record_actions_in_state,
)
from .verify import verify_pairs

KM_TO_MI = 0.621


def _rules(tool_context: ToolContext | None) -> dict[str, float]:
    r = dict(DEFAULT_RULES)
    if tool_context is not None:
        r.update(tool_context.state.get("reachability_rules") or {})
    return r


def set_reachability_rules(
    tool_context: ToolContext,
    car_drive_minutes: float = 30.0,
    walk_miles: float = 1.0,
) -> dict:
    """Changes what "reachable" means, for the rest of this conversation. Use when the manager says e.g.
    "a no-car household can only walk half a mile" or "45 minutes by car is acceptable".

    Args:
      car_drive_minutes: a household with a car can reach a shelter within this Google Maps drive time.
      walk_miles: a household without a car can walk to a shelter within this straight-line distance.

    Returns:
      the rules now in effect (validated via `ReachabilityRulesOutput`). No-car households with a
      mobility disability always need door-to-door pickup.
    """
    rules = {"car_drive_minutes": max(1.0, float(car_drive_minutes)), "walk_miles": max(0.1, float(walk_miles))}
    tool_context.state["reachability_rules"] = rules

    action = RecommendedAction(
        action_id="act-reachability-rules-policy",
        action_type=ActionType.SELECT_TRACT_DESTINATION,
        agent_source="destination_agent",
        interaction_mode=InteractionMode.APPROVAL_REQUIRED,
        requires_approval=True,
        requires_selection=False,
        severity=ActionSeverity.MEDIUM,
        title="Confirm Updated Reachability Thresholds",
        summary=(
            f"Car reachability set to <= {rules['car_drive_minutes']:g} min ({LBL['drive']}); "
            f"walking reachability set to <= {rules['walk_miles']:g} mi ({LBL['straight']})."
        ),
        primary_location=LocationInfo(label="County Reachability Policy"),
        attention_items=[
            AttentionItem(label="Car drive limit", value=f"{rules['car_drive_minutes']:g} min", source_badge=LBL["drive"]),
            AttentionItem(label="No-car walk limit", value=f"{rules['walk_miles']:g} mi", source_badge=LBL["straight"]),
            AttentionItem(
                label="No-car + mobility disability",
                value="Door-to-door pickup always required",
                source_badge=LBL["modeled"],
            ),
        ],
        approval=ApprovalDetails(
            confirm_label="Apply Reachability Rules",
            reject_label="Reset to Default (30 min / 1 mi)",
            proposed_change=f"Use {rules['car_drive_minutes']:g} min car drive and {rules['walk_miles']:g} mi walk radius for destination planning.",
            target_entity_type="county_policy",
            target_entity_id="reachability_rules",
            payload=rules,
            irreversible_or_high_impact=False,
        ),
    )
    record_actions_in_state(tool_context, [action])
    out = ReachabilityRulesOutput(
        rules_in_effect=rules,
        fixed_rule="No car + mobility disability: nothing is walkable; door-to-door pickup.",
        recommended_actions=[action],
    )
    return out.model_dump()


def plan_destinations(tool_context: ToolContext, geo_ids: list[str], check_drive_times: bool = True) -> dict:
    """For each census tract, works out where its people would go and whether they can get there, by household:
      - has a car: nearest usable shelter, reachable if the Google Maps drive time is within the rule;
      - no car: usable shelters within walking distance (straight-line), else needs a pickup point;
      - no car + mobility disability: needs door-to-door pickup (counted, modeled).
    Usable = pre-landfall (EVAC/BOTH) shelter, not recorded by FEMA as inside the storm surge zone, with
    recorded capacity. Shelters on high coastal-flood ground (tract-level proxy) stay in but are flagged.

    Args:
      geo_ids: 11-digit census tract ids (max 6), e.g. from rank_priority_tracts.
      check_drive_times: get live Google Maps drive times (5-8 s per shelter, run in parallel).

    Returns:
      per-tract household tiers with counts, destinations, distances labelled straight-line or drive time,
      excluded shelters with the reason, coordinates, and structured `recommended_actions`
      (validated via `PlanDestinationsOutput`).
    """
    rules = _rules(tool_context)
    geo_ids = [g.strip() for g in geo_ids][:6]
    out, pairs = [], []
    for g in geo_ids:
        t = _rows(
            f"""SELECT geo_id, county_fips, county_name, near_city, ROUND(lat, 4) AS lat, ROUND(lon, 4) AS lon,
                       households, hh_no_vehicle, est_no_car_mobility_hh_modeled
                FROM {table('tract_readiness')} WHERE geo_id=@g""",
            g=g,
        )
        if not t:
            out.append({"geo_id": g, "error": "tract not found"})
            continue
        t = t[0]
        shelters = _rows(
            f"""
            SELECT shelter_id, shelter_name, address, city, county_name, county_fips,
              ROUND(latitude, 5) AS latitude, ROUND(longitude, 5) AS longitude,
              usage, evacuation_capacity, wheelchair, generator,
              surge_flag, site_in_flood_hazard, is_medical,
              ROUND(ST_DISTANCE(ST_GEOGPOINT(longitude, latitude), ST_GEOGPOINT(@lon, @lat)) / 1000, 2) km
            FROM {table('shelters_enriched')}
            WHERE (pre_landfall OR usage_unknown)
              AND ST_DWITHIN(ST_GEOGPOINT(longitude, latitude), ST_GEOGPOINT(@lon, @lat), 40000)
            ORDER BY km LIMIT 12""",
            lat=float(t["lat"]),
            lon=float(t["lon"]),
        )
        usable, excluded = [], []
        for s in shelters:
            s["miles"] = round(s.pop("km") * KM_TO_MI, 1)
            cap = s.pop("evacuation_capacity")
            s["raw_capacity"] = cap
            s["capacity"] = "❓ unrecorded" if cap is None else cap
            wc_val = s.get("wheelchair", "UNRECORDED")
            gen_val = s.get("generator", "UNRECORDED")
            s["fema_record"] = (
                f"{LBL['fema']}: wheelchair {wc_val}, generator {gen_val}, surge flag {s['surge_flag']}"
            ).replace("UNRECORDED", "❓ unrecorded")
            s_loc = LocationInfo(
                lat=s.get("latitude"),
                lon=s.get("longitude"),
                label=s["shelter_name"],
                address=s.get("address"),
                city=s.get("city"),
                county=s.get("county_name"),
                county_fips=s.get("county_fips"),
                shelter_id=int(s["shelter_id"]),
            )
            s["location"] = s_loc
            if s["surge_flag"] == "YES":
                excluded.append(
                    ExcludedShelterItem(
                        shelter_id=int(s["shelter_id"]),
                        name=s["shelter_name"],
                        location=s_loc,
                        reason=f"{LBL['fema']} says it is inside the storm surge zone",
                    )
                )
            elif cap in (None, 0):
                excluded.append(
                    ExcludedShelterItem(
                        shelter_id=int(s["shelter_id"]),
                        name=s["shelter_name"],
                        location=s_loc,
                        reason="no evacuation capacity on record (❓): confirm with operator",
                    )
                )
            else:
                if s.pop("site_in_flood_hazard"):
                    s["flag"] = f"on high coastal-flood ground ({LBL['nri']}): confirm the building's elevation"
                usable.append(s)
        walkable = [s for s in usable if s["miles"] <= rules["walk_miles"]]
        drive_candidates = usable[:2]
        for s in drive_candidates:
            pairs.append((s["shelter_id"], g))
        out.append(
            {
                "tract": t,
                "usable": usable[:4],
                "walkable": walkable,
                "drive_candidates": drive_candidates,
                "excluded": excluded[:5],
            }
        )

    live = verify_pairs(pairs) if check_drive_times and pairs else {}

    tracts: list[TractDestinationPlanItem] = []
    all_actions: list[RecommendedAction] = []

    for row in out:
        if "error" in row:
            tracts.append(TractDestinationPlanItem(geo_id=row["geo_id"], error=row["error"]))
            continue
        t, g = row["tract"], row["tract"]["geo_id"]
        place_str = f"near {t['near_city']}, {t['county_name']} County (tract {g})"
        tract_loc = LocationInfo(
            lat=t.get("lat"),
            lon=t.get("lon"),
            label=place_str,
            city=t.get("near_city"),
            county=t.get("county_name"),
            county_fips=t.get("county_fips"),
            geo_id=g,
        )

        car: list[CarDestinationOption] = []
        tract_options: list[ActionOption] = []
        secondary_locs: list[LocationInfo] = []
        tract_maps_sources: list[MapsGroundingChunk] = []
        tract_actions: list[RecommendedAction] = []

        for idx, s in enumerate(row["drive_candidates"]):
            v = live.get((s["shelter_id"], g))
            s_loc: LocationInfo = s["location"].model_copy(deep=True)
            drive_str = None
            reachable_car = None
            live_check_str = None
            maps_attr_str = None
            usable_flag = True
            why_not_str = None
            drive_mins = None

            if v:
                d = v.get("drive") or {}
                if d.get("drive_minutes") is not None:
                    drive_mins = float(d["drive_minutes"])
                    drive_str = f"{d['drive_minutes']} min {LBL['drive']}"
                    reachable_car = drive_mins <= rules["car_drive_minutes"]
                live_check_str = f"{LBL['live']}: {v['verdict']}" + (
                    f" ({'; '.join(v['flags'])})" if v.get("flags") else ""
                )
                src = (v.get("google_maps_sources") or [])[:1]
                if src:
                    title_clean = (src[0].get("title") or "").replace(" - Google Maps", "").strip() or "place"
                    uri_val = src[0].get("uri") or ""
                    s_loc.place_id = src[0].get("place_id")
                    s_loc.maps_uri = uri_val
                    maps_attr_str = f"Google Maps — [{title_clean}]({uri_val})"
                    if uri_val:
                        tract_maps_sources.append(
                            MapsGroundingChunk(place_id=src[0].get("place_id"), title=title_clean, uri=uri_val)
                        )
                if v["verdict"] not in ("CONFIRMED_EXISTS", "RENAMED_OR_REBRANDED") or any(
                    "temporarily closed" in f for f in v.get("flags", [])
                ):
                    usable_flag = False
                    why_not_str = v.get("action")

            secondary_locs.append(s_loc)
            car.append(
                CarDestinationOption(
                    shelter_id=int(s["shelter_id"]),
                    shelter=s["shelter_name"],
                    address=f"{s['address']}, {s['city']}",
                    location=s_loc,
                    straight_line=f"{s['miles']} mi {LBL['straight']}",
                    capacity=s["capacity"],
                    fema_record=s["fema_record"],
                    flag=s.get("flag"),
                    drive=drive_str,
                    reachable_by_car=reachable_car,
                    live_check=live_check_str,
                    maps_attribution=maps_attr_str,
                    usable=usable_flag,
                    why_not=why_not_str,
                )
            )

            opt_warnings = []
            if s.get("flag"):
                opt_warnings.append(s["flag"])
            if not usable_flag and why_not_str:
                opt_warnings.append(why_not_str)
            if reachable_car is False:
                opt_warnings.append(f"Exceeds {rules['car_drive_minutes']:g} min car drive rule")

            tract_options.append(
                ActionOption(
                    option_id=str(s["shelter_id"]),
                    label=f"{s['shelter_name']} ({s['city']})",
                    description=(
                        f"{s['miles']} mi {LBL['straight']}"
                        + (f", {drive_str}" if drive_str else "")
                        + f" · Capacity: {s['capacity']} · {s['fema_record']}"
                    ),
                    recommended=(idx == 0 and usable_flag and (reachable_car is not False)),
                    location=s_loc,
                    metrics={
                        "shelter_id": int(s["shelter_id"]),
                        "straight_line_miles": s["miles"],
                        "drive_minutes": drive_mins,
                        "reachable_by_car": reachable_car,
                        "capacity": s["raw_capacity"],
                        "wheelchair": s.get("wheelchair"),
                        "generator": s.get("generator"),
                        "usable": usable_flag,
                    },
                    warnings=opt_warnings,
                )
            )

            # If shelter sits on high coastal-flood ground, emit an approval action to verify its elevation
            if s.get("flag"):
                tract_actions.append(
                    RecommendedAction(
                        action_id=f"act-flood-elevation-{s['shelter_id']}",
                        action_type=ActionType.VERIFY_FLOOD_GROUND_ELEVATION,
                        agent_source="destination_agent",
                        interaction_mode=InteractionMode.APPROVAL_REQUIRED,
                        requires_approval=True,
                        requires_selection=False,
                        severity=ActionSeverity.HIGH,
                        title=f"Verify Elevation of {s['shelter_name']} (High Coastal-Flood Ground)",
                        summary=(
                            f"{s['shelter_name']} ({s['capacity']} spaces) sits on a tract with >=25% coastal-flood exposure "
                            f"({LBL['nri']}). Confirm physical building elevation before relying on it for {place_str}."
                        ),
                        affected_count=int(s["raw_capacity"] or 0),
                        affected_unit="spaces",
                        primary_location=s_loc,
                        secondary_locations=[tract_loc],
                        attention_items=[
                            AttentionItem(label="Site hazard", value=s["flag"], source_badge=LBL["nri"], is_warning=True),
                            AttentionItem(label="Capacity", value=str(s["capacity"]), source_badge=LBL["fema"]),
                        ],
                        approval=ApprovalDetails(
                            confirm_label="Approve Building After Elevation Check",
                            reject_label="Exclude Shelter From Plan",
                            proposed_change=f"Confirm finished-floor elevation of {s['shelter_name']} (#{s['shelter_id']}) or remove its {s['capacity']} spaces.",
                            target_entity_type="shelter",
                            target_entity_id=str(s["shelter_id"]),
                            payload={"shelter_id": int(s["shelter_id"]), "geo_id": g},
                            irreversible_or_high_impact=True,
                        ),
                    )
                )

        # Also add remaining usable shelters (up to 4) into options so the user has full choice
        for s in row["usable"][2:4]:
            s_loc = s["location"]
            secondary_locs.append(s_loc)
            tract_options.append(
                ActionOption(
                    option_id=str(s["shelter_id"]),
                    label=f"{s['shelter_name']} ({s['city']})",
                    description=f"{s['miles']} mi {LBL['straight']} · Capacity: {s['capacity']} · {s['fema_record']}",
                    recommended=False,
                    location=s_loc,
                    metrics={
                        "shelter_id": int(s["shelter_id"]),
                        "straight_line_miles": s["miles"],
                        "capacity": s["raw_capacity"],
                        "wheelchair": s.get("wheelchair"),
                        "generator": s.get("generator"),
                        "usable": True,
                    },
                    warnings=[s["flag"]] if s.get("flag") else [],
                )
            )

        hh = int(t["households"] or 0)
        no_car = int(t["hh_no_vehicle"] or 0)
        door = int(t["est_no_car_mobility_hh_modeled"] or 0)
        default_opt_id = next((o.option_id for o in tract_options if o.recommended), tract_options[0].option_id if tract_options else None)

        # Action 1: Select destination shelter for the tract
        if tract_options:
            tract_actions.insert(
                0,
                RecommendedAction(
                    action_id=f"act-select-dest-{g}",
                    action_type=ActionType.SELECT_TRACT_DESTINATION,
                    agent_source="destination_agent",
                    interaction_mode=InteractionMode.SELECT_BETWEEN_OPTIONS,
                    requires_approval=True,
                    requires_selection=True,
                    severity=ActionSeverity.HIGH,
                    title=f"Select Primary Evacuation Shelter for {place_str}",
                    summary=(
                        f"Choose and approve the primary pre-landfall shelter for {hh - no_car:,} car households "
                        f"({LBL['measured']}) in {place_str}."
                    ),
                    affected_count=max(0, hh - no_car),
                    affected_unit="car_households",
                    primary_location=tract_loc,
                    secondary_locations=secondary_locs,
                    attention_items=[
                        AttentionItem(label="Car households", value=f"{hh - no_car:,}", source_badge=LBL["measured"]),
                        AttentionItem(
                            label="Car drive rule",
                            value=f"<= {rules['car_drive_minutes']:g} min",
                            source_badge=LBL["drive"],
                        ),
                    ],
                    approval=ApprovalDetails(
                        confirm_label="Assign Selected Shelter",
                        reject_label="Hold Assignment",
                        proposed_change=f"Assign selected shelter to tract {g} ({place_str}) in pre-season routing plan.",
                        target_entity_type="tract",
                        target_entity_id=g,
                        payload={"geo_id": g, "recommended_shelter_id": default_opt_id},
                        irreversible_or_high_impact=False,
                    ),
                    options=tract_options,
                    selected_option_id=default_opt_id,
                    maps_sources=tract_maps_sources,
                ),
            )

        # Action 2: Bus pickup point if no walkable shelters exist for no-car households
        if no_car > 0 and not row["walkable"]:
            tract_actions.append(
                RecommendedAction(
                    action_id=f"act-bus-pickup-{g}",
                    action_type=ActionType.DESIGNATE_BUS_PICKUP_POINT,
                    agent_source="destination_agent",
                    interaction_mode=(
                        InteractionMode.SELECT_BETWEEN_OPTIONS if tract_options else InteractionMode.APPROVAL_REQUIRED
                    ),
                    requires_approval=True,
                    requires_selection=bool(tract_options),
                    severity=ActionSeverity.CRITICAL if no_car >= 150 else ActionSeverity.HIGH,
                    title=f"Designate Bus Pickup Point for {no_car:,} No-Car Households ({place_str})",
                    summary=(
                        f"Zero usable shelters within {rules['walk_miles']:g} mi ({LBL['straight']}) for "
                        f"{no_car:,} no-car households ({LBL['measured']}). Approve a pickup point and select target shelter."
                    ),
                    affected_count=no_car,
                    affected_unit="no_car_households",
                    primary_location=tract_loc,
                    secondary_locations=secondary_locs,
                    attention_items=[
                        AttentionItem(
                            label="No-car households",
                            value=f"{no_car:,}",
                            source_badge=LBL["measured"],
                            is_warning=True,
                        ),
                        AttentionItem(
                            label="Walkable shelters",
                            value=f"0 within {rules['walk_miles']:g} mi",
                            source_badge=LBL["straight"],
                            is_warning=True,
                        ),
                    ],
                    approval=ApprovalDetails(
                        confirm_label="Approve Bus Pickup & Route",
                        reject_label="Defer Bus Staging",
                        proposed_change=f"Designate bus pickup point in tract {g} for {no_car:,} no-car households.",
                        target_entity_type="tract",
                        target_entity_id=g,
                        payload={"geo_id": g, "no_car_households": no_car, "target_shelter_id": default_opt_id},
                        irreversible_or_high_impact=False,
                    ),
                    options=tract_options,
                    selected_option_id=default_opt_id,
                    maps_sources=tract_maps_sources,
                )
            )

        # Action 3: Door-to-door paratransit for no-car + mobility disability households
        if door > 0:
            tract_actions.append(
                RecommendedAction(
                    action_id=f"act-paratransit-{g}",
                    action_type=ActionType.SCHEDULE_PARATRANSIT_PICKUP,
                    agent_source="destination_agent",
                    interaction_mode=InteractionMode.APPROVAL_REQUIRED,
                    requires_approval=True,
                    requires_selection=False,
                    severity=ActionSeverity.HIGH,
                    title=f"Stage Door-to-Door Paratransit for ~{door:,} Mobility-Disabled Households ({place_str})",
                    summary=(
                        f"~{door:,} no-car households with a mobility disability ({LBL['modeled']}) cannot use "
                        f"walkable shelters or fixed bus stops; pre-schedule door-to-door pickup."
                    ),
                    affected_count=door,
                    affected_unit="no_car_mobility_households_modeled",
                    primary_location=tract_loc,
                    attention_items=[
                        AttentionItem(
                            label="No-car + mobility disability",
                            value=f"~{door:,} households",
                            source_badge=LBL["modeled"],
                            is_warning=True,
                        ),
                    ],
                    approval=ApprovalDetails(
                        confirm_label="Approve Paratransit Staging",
                        reject_label="Defer",
                        proposed_change=f"Reserve paratransit vehicles for ~{door:,} modeled households in tract {g}.",
                        target_entity_type="tract",
                        target_entity_id=g,
                        payload={"geo_id": g, "est_no_car_mobility_hh_modeled": door},
                        irreversible_or_high_impact=False,
                    ),
                )
            )

        # Action 4: Excluded shelters requiring confirmation or surge-zone exclusion sign-off
        for ex in row["excluded"][:2]:
            is_surge = "surge" in ex.reason.lower()
            tract_actions.append(
                RecommendedAction(
                    action_id=f"act-excluded-{g}-{ex.shelter_id}",
                    action_type=(
                        ActionType.EXCLUDE_SURGE_ZONE_SHELTER if is_surge else ActionType.CONFIRM_SHELTER_CAPACITY
                    ),
                    agent_source="destination_agent",
                    interaction_mode=InteractionMode.APPROVAL_REQUIRED,
                    requires_approval=True,
                    requires_selection=False,
                    severity=ActionSeverity.HIGH if is_surge else ActionSeverity.MEDIUM,
                    title=(
                        f"Confirm Exclusion of {ex.name} (Storm Surge Zone)"
                        if is_surge
                        else f"Confirm Unrecorded Capacity for {ex.name}"
                    ),
                    summary=f"Excluded near {place_str}: {ex.reason}.",
                    primary_location=ex.location or tract_loc,
                    secondary_locations=[tract_loc],
                    attention_items=[
                        AttentionItem(
                            label="Exclusion reason",
                            value=ex.reason,
                            source_badge=LBL["fema"] if is_surge else LBL["unrecorded"],
                            is_warning=True,
                        )
                    ],
                    approval=ApprovalDetails(
                        confirm_label="Confirm Exclusion" if is_surge else "Request Capacity From Operator",
                        reject_label="Override & Keep",
                        proposed_change=f"Keep {ex.name} (#{ex.shelter_id}) excluded from tract {g} until resolved.",
                        target_entity_type="shelter",
                        target_entity_id=str(ex.shelter_id),
                        payload={"shelter_id": ex.shelter_id, "geo_id": g, "reason": ex.reason},
                        irreversible_or_high_impact=is_surge,
                    ),
                )
            )

        all_actions.extend(tract_actions)

        tracts.append(
            TractDestinationPlanItem(
                geo_id=g,
                place=place_str,
                location=tract_loc,
                households_with_car=HouseholdsWithCarTier(
                    count=f"{hh - no_car:,} {LBL['measured']}",
                    destinations=car,
                ),
                households_without_car=HouseholdsWithoutCarTier(
                    count=f"{no_car:,} {LBL['measured']}",
                    walkable_shelters=[
                        WalkableShelterOption(
                            shelter_id=int(s["shelter_id"]),
                            shelter=s["shelter_name"],
                            location=s["location"],
                            straight_line=f"{s['miles']} mi {LBL['straight']}",
                            capacity=s["capacity"],
                            flag=s.get("flag"),
                        )
                        for s in row["walkable"]
                    ],
                    verdict=(
                        "can walk to a usable shelter"
                        if row["walkable"]
                        else f"no usable shelter within {rules['walk_miles']} mi: needs a pickup point / bus"
                    ),
                ),
                no_car_with_mobility_disability=NoCarMobilityTier(
                    count=f"~{door:,} households {LBL['modeled']}",
                    verdict="door-to-door pickup (paratransit) needed; walking distance does not apply",
                ),
                excluded_shelters=row["excluded"],
                recommended_actions=tract_actions,
            )
        )

    record_actions_in_state(tool_context, all_actions)
    out_model = PlanDestinationsOutput(
        rules_used=rules,
        tracts=tracts,
        surge_rule=(
            "Excluded: shelters FEMA records inside the storm surge zone. Flagged, not excluded: shelters "
            "on tracts with >=25% coastal-flood exposure (tract-level proxy)."
        ),
        attribution="Copy each maps_attribution line verbatim directly under the shelter it supports.",
        recommended_actions=all_actions,
    )
    return out_model.model_dump(exclude_none=True)
