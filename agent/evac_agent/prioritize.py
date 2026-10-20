"""Q1 tools: which tracts to prioritize, and why. Each tract gets 0-100 points per factor (statewide
percentile); the weighted average ranks it, and its highest-scoring people factor is its main need."""
from __future__ import annotations

from google.adk.tools.tool_context import ToolContext

from .config import DEFAULT_WEIGHTS, LBL, table
from .data import _rows, resolve_county
from .schemas import (
    ActionOption,
    ActionSeverity,
    ActionType,
    ApprovalDetails,
    AttentionItem,
    EvacuationZoneTotals,
    InteractionMode,
    LocationInfo,
    PriorityFactorPoints,
    PriorityTractItem,
    PriorityWeightsOutput,
    RankPriorityTractsOutput,
    RecommendedAction,
    record_actions_in_state,
)

FACTORS = {
    "no_car": ("pts_no_car", "households without a vehicle", LBL["measured"]),
    "older": ("pts_older", "residents 65+", LBL["measured"]),
    "disability": ("pts_disability", "adults with a mobility disability", LBL["modeled"]),
    "mobile_homes": ("pts_mobile_homes", "mobile homes", LBL["measured"]),
    "flood": ("pts_flood", "share of residents exposed to coastal flooding", LBL["nri"]),
}
NEED_LABEL = {
    "no_car": "no car: needs organized transport",
    "older": "older residents: needs check-ins and help leaving",
    "disability": "mobility disability: needs accessible transport and shelter",
    "mobile_homes": "mobile homes: must leave in any hurricane",
}
NEED_ACTION_TYPE = {
    "no_car": ActionType.ORGANIZE_BUS_PICKUP,
    "older": ActionType.OLDER_ADULT_CHECKIN,
    "disability": ActionType.DISABILITY_ACCESSIBLE_TRANSPORT,
    "mobile_homes": ActionType.MOBILE_HOME_EVACUATION_OUTREACH,
}


def _weights(tool_context: ToolContext | None) -> dict[str, float]:
    w = dict(DEFAULT_WEIGHTS)
    if tool_context is not None:
        w.update(tool_context.state.get("priority_weights") or {})
    return w


def set_priority_weights(
    tool_context: ToolContext,
    no_car: float = 2.0,
    older: float = 1.0,
    disability: float = 1.0,
    mobile_homes: float = 1.0,
    flood: float = 1.0,
) -> dict:
    """Changes how much each factor counts in the tract ranking, for the rest of this conversation.
    Use when the manager says e.g. "weight disability double" or "ignore mobile homes". 0 removes a factor.

    Args:
      no_car: weight for households without a vehicle (default 2).
      older: weight for residents 65+ (default 1).
      disability: weight for adults with a mobility disability, modeled (default 1).
      mobile_homes: weight for mobile homes (default 1).
      flood: weight for share of residents exposed to coastal flooding (default 1).

    Returns:
      the weights now in effect (validated via `PriorityWeightsOutput`).
    """
    w = {"no_car": no_car, "older": older, "disability": disability, "mobile_homes": mobile_homes, "flood": flood}
    w = {k: max(0.0, float(v)) for k, v in w.items()}
    if not sum(w.values()):
        return {"error": "at least one weight must be above 0"}
    tool_context.state["priority_weights"] = w

    action = RecommendedAction(
        action_id="act-priority-weights-policy",
        action_type=ActionType.ADJUST_PRIORITY_WEIGHTS,
        agent_source="prioritization_agent",
        interaction_mode=InteractionMode.SELECT_BETWEEN_OPTIONS,
        requires_approval=True,
        requires_selection=True,
        severity=ActionSeverity.MEDIUM,
        title="Confirm or Adjust Evacuation Priority Factor Weights",
        summary=(
            f"Updated ranking weights to no_car={w['no_car']:g}, older={w['older']:g}, "
            f"disability={w['disability']:g}, mobile_homes={w['mobile_homes']:g}, flood={w['flood']:g}."
        ),
        primary_location=LocationInfo(label="Florida / County Policy Scope", county="Statewide / Active County"),
        attention_items=[
            AttentionItem(label=k, value=f"x{v:g}", source_badge="📊 Policy Weight", is_warning=(v == 0))
            for k, v in w.items()
        ],
        approval=ApprovalDetails(
            confirm_label="Apply Weights to Brief",
            reject_label="Reset to Default Weights",
            proposed_change=f"Apply custom ranking weights {w} to all subsequent tract rankings in this session.",
            target_entity_type="county_policy",
            target_entity_id="priority_weights",
            payload={"weights": w},
            irreversible_or_high_impact=False,
        ),
        options=[
            ActionOption(
                option_id="custom_active",
                label="Keep Current Custom Weights",
                description=f"no_car x{w['no_car']:g}, older x{w['older']:g}, disability x{w['disability']:g}, mobile_homes x{w['mobile_homes']:g}, flood x{w['flood']:g}",
                recommended=True,
                metrics=w,
            ),
            ActionOption(
                option_id="default_weights",
                label="Default (No-Car x2, Others x1)",
                description="Standard pre-season baseline weighting measured no-vehicle households double.",
                recommended=False,
                metrics=dict(DEFAULT_WEIGHTS),
            ),
            ActionOption(
                option_id="disability_focus",
                label="Mobility Disability Focus (Disability x2, No-Car x2)",
                description="Prioritizes tracts with high modeled mobility disability alongside no-car households.",
                recommended=False,
                metrics={"no_car": 2.0, "older": 1.0, "disability": 2.0, "mobile_homes": 1.0, "flood": 1.0},
            ),
        ],
        selected_option_id="custom_active",
    )
    record_actions_in_state(tool_context, [action])
    out = PriorityWeightsOutput(
        weights_in_effect=w,
        note="Re-run rank_priority_tracts to see the new ranking.",
        recommended_actions=[action],
    )
    return out.model_dump()


def rank_priority_tracts(tool_context: ToolContext, county: str = "", top_n: int = 10) -> dict:
    """Ranks census tracts for evacuation-readiness planning, statewide (Florida) or within one county.

    Each tract gets 0-100 points per factor: its statewide percentile for no-car households, residents
    65+, adults with a mobility disability (modeled), mobile homes, and coastal-flood exposure. The
    weighted average (weights adjustable with set_priority_weights) is its priority score. Only tracts
    an evacuation order would target are ranked: >=25% of residents exposed to coastal flooding, or
    >=10% mobile homes. Each tract's main need is its highest-scoring people factor.

    Args:
      county: Florida county name to limit the ranking, or "" for all of Florida.
      top_n: number of tracts (max 25).

    Returns:
      ranked tracts with points per factor, main need, counts behind the points, coordinates, and
      structured `recommended_actions` (validated via `RankPriorityTractsOutput`).
    """
    w = _weights(tool_context)
    total_w = sum(w.values())
    expr = " + ".join(f"{w[k]} * {FACTORS[k][0]}" for k in FACTORS)
    where, params = "evacuation_driver IS NOT NULL", {}
    scope = "Florida (all counties)"
    if county.strip():
        fips, name = resolve_county(county)
        where += " AND county_fips = @fips"
        params["fips"] = fips
        scope = f"{name} County"
    top_n = max(1, min(int(top_n), 25))
    rows = _rows(
        f"""
        SELECT geo_id, county_fips, county_name, near_city,
          ROUND(lat, 5) AS lat, ROUND(lon, 5) AS lon,
          total_pop, hh_no_vehicle, pop_65_plus,
          ROUND(est_mobility_disabled_modeled) mobility_disabled_modeled, mobile_homes,
          ROUND(100 * coastal_flood_share) pct_coastal_flood_exposed, est_no_car_mobility_hh_modeled,
          evacuation_driver, pts_no_car, pts_older, pts_disability, pts_mobile_homes, pts_flood,
          ROUND(({expr}) / {total_w}, 1) AS priority_points
        FROM {table('tract_readiness')} WHERE {where}
        ORDER BY priority_points DESC LIMIT @n""",
        n=top_n,
        **params,
    )
    zone_row = _rows(
        f"""SELECT COUNT(*) tracts, SUM(total_pop) people, SUM(hh_no_vehicle) no_car_households
                     FROM {table('tract_readiness')} WHERE {where}""",
        **params,
    )[0]

    tract_items: list[PriorityTractItem] = []
    actions: list[RecommendedAction] = []

    for idx, r in enumerate(rows):
        near_city = r.pop("near_city", None) or r["county_name"]
        people = {k: r[FACTORS[k][0]] for k in ("no_car", "older", "disability", "mobile_homes")}
        main = max(people, key=lambda k: (people[k] * (1 if w[k] else 0), w[k]))
        main_need_str = NEED_LABEL[main]
        pts = PriorityFactorPoints(**{k: float(r.pop(FACTORS[k][0]) or 0.0) for k in FACTORS})
        place_str = f"near {near_city}, {r['county_name']} County (tract {r['geo_id']})"
        loc = LocationInfo(
            lat=r.get("lat"),
            lon=r.get("lon"),
            label=place_str,
            city=near_city,
            county=r["county_name"],
            county_fips=r.get("county_fips"),
            geo_id=r["geo_id"],
        )

        item = PriorityTractItem(
            geo_id=r["geo_id"],
            county_name=r["county_name"],
            county_fips=r.get("county_fips"),
            place=place_str,
            lat=r.get("lat"),
            lon=r.get("lon"),
            location=loc,
            total_pop=int(r["total_pop"] or 0),
            hh_no_vehicle=int(r["hh_no_vehicle"] or 0),
            pop_65_plus=int(r["pop_65_plus"] or 0),
            mobility_disabled_modeled=r.get("mobility_disabled_modeled"),
            mobile_homes=int(r["mobile_homes"] or 0),
            pct_coastal_flood_exposed=r.get("pct_coastal_flood_exposed"),
            est_no_car_mobility_hh_modeled=r.get("est_no_car_mobility_hh_modeled"),
            evacuation_driver=r.get("evacuation_driver"),
            priority_points=float(r["priority_points"] or 0.0),
            main_need=main_need_str,
            points=pts,
        )
        tract_items.append(item)

        # Build structured UI action for the top tracts (up to 6 to keep UI actionable)
        if idx < 6:
            count_map = {
                "no_car": (item.hh_no_vehicle, "no_car_households"),
                "older": (item.pop_65_plus, "residents_65_plus"),
                "disability": (int(item.mobility_disabled_modeled or 0), "adults_mobility_disability_modeled"),
                "mobile_homes": (item.mobile_homes, "mobile_homes"),
            }
            aff_count, aff_unit = count_map[main]
            options = [
                ActionOption(
                    option_id=f"{item.geo_id}-no_car",
                    label=f"Stage Bus Pickup ({item.hh_no_vehicle:,} no-car households)",
                    description=f"{pts.no_car:.0f} pts ({LBL['measured']}); pre-assign bus pickup point for households without a vehicle.",
                    recommended=(main == "no_car"),
                    location=loc,
                    metrics={"hh_no_vehicle": item.hh_no_vehicle, "points": pts.no_car},
                ),
                ActionOption(
                    option_id=f"{item.geo_id}-disability",
                    label=f"Dispatch Accessible Transport (~{int(item.mobility_disabled_modeled or 0):,} adults)",
                    description=f"{pts.disability:.0f} pts ({LBL['modeled']}); reserve paratransit & wheelchair-accessible shelter space.",
                    recommended=(main == "disability"),
                    location=loc,
                    metrics={"mobility_disabled_modeled": int(item.mobility_disabled_modeled or 0), "points": pts.disability},
                ),
                ActionOption(
                    option_id=f"{item.geo_id}-older",
                    label=f"Schedule 65+ Check-Ins ({item.pop_65_plus:,} older residents)",
                    description=f"{pts.older:.0f} pts ({LBL['measured']}); coordinate pre-storm wellness check-ins and evacuation assistance.",
                    recommended=(main == "older"),
                    location=loc,
                    metrics={"pop_65_plus": item.pop_65_plus, "points": pts.older},
                ),
                ActionOption(
                    option_id=f"{item.geo_id}-mobile_homes",
                    label=f"Mandatory Mobile Home Outreach ({item.mobile_homes:,} mobile homes)",
                    description=f"{pts.mobile_homes:.0f} pts ({LBL['measured']}); mobile homes must evacuate in any hurricane.",
                    recommended=(main == "mobile_homes"),
                    location=loc,
                    metrics={"mobile_homes": item.mobile_homes, "points": pts.mobile_homes},
                ),
            ]
            actions.append(
                RecommendedAction(
                    action_id=f"act-prioritize-tract-{item.geo_id}",
                    action_type=NEED_ACTION_TYPE[main],
                    agent_source="prioritization_agent",
                    interaction_mode=InteractionMode.SELECT_BETWEEN_OPTIONS,
                    requires_approval=True,
                    requires_selection=True,
                    severity=ActionSeverity.CRITICAL if item.priority_points >= 85 else ActionSeverity.HIGH,
                    title=f"Prioritize {place_str} — {main_need_str.capitalize()}",
                    summary=(
                        f"Rank #{idx + 1} ({item.priority_points} priority pts, driver: {item.evacuation_driver}). "
                        f"Primary need: {main_need_str} ({aff_count:,} {aff_unit.replace('_', ' ')})."
                    ),
                    affected_count=aff_count,
                    affected_unit=aff_unit,
                    primary_location=loc,
                    attention_items=[
                        AttentionItem(
                            label="No-car households",
                            value=f"{item.hh_no_vehicle:,} ({pts.no_car:.0f} pts)",
                            source_badge=LBL["measured"],
                            is_warning=(pts.no_car >= 75),
                        ),
                        AttentionItem(
                            label="Residents 65+",
                            value=f"{item.pop_65_plus:,} ({pts.older:.0f} pts)",
                            source_badge=LBL["measured"],
                            is_warning=(pts.older >= 75),
                        ),
                        AttentionItem(
                            label="Mobility disability",
                            value=f"~{int(item.mobility_disabled_modeled or 0):,} ({pts.disability:.0f} pts)",
                            source_badge=LBL["modeled"],
                            is_warning=(pts.disability >= 75),
                        ),
                        AttentionItem(
                            label="Mobile homes",
                            value=f"{item.mobile_homes:,} ({pts.mobile_homes:.0f} pts)",
                            source_badge=LBL["measured"],
                            is_warning=(pts.mobile_homes >= 75),
                        ),
                        AttentionItem(
                            label="Coastal-flood exposure",
                            value=f"{int(item.pct_coastal_flood_exposed or 0)}% ({pts.flood:.0f} pts)",
                            source_badge=LBL["nri"],
                            is_warning=((item.pct_coastal_flood_exposed or 0) >= 25),
                        ),
                    ],
                    approval=ApprovalDetails(
                        confirm_label="Approve Tract Staging",
                        reject_label="Skip Tract",
                        proposed_change=f"Stage pre-season evacuation outreach & transport for tract {item.geo_id} ({place_str}).",
                        target_entity_type="tract",
                        target_entity_id=item.geo_id,
                        payload={
                            "geo_id": item.geo_id,
                            "main_need": main,
                            "priority_points": item.priority_points,
                            "lat": item.lat,
                            "lon": item.lon,
                        },
                        irreversible_or_high_impact=False,
                    ),
                    options=options,
                    selected_option_id=f"{item.geo_id}-{main}",
                )
            )

    names = {
        "no_car": "households without a car",
        "older": "residents 65+",
        "disability": "adults with a mobility disability",
        "mobile_homes": "mobile homes",
        "flood": "coastal-flood exposure",
    }
    parts = [f"{names[k]} x{w[k]:g}" for k in FACTORS if w[k]] + [f"{names[k]} ignored" for k in FACTORS if not w[k]]
    weights_sentence = "Weights in use: " + ", ".join(parts) + "." + (
        " (Default: households without a car count double; everything else counts once.)" if w == DEFAULT_WEIGHTS else ""
    )

    record_actions_in_state(tool_context, actions)
    out = RankPriorityTractsOutput(
        scope=scope,
        weights_used=w,
        weights_sentence=weights_sentence,
        evacuation_zone_totals=EvacuationZoneTotals(
            tracts=int(zone_row.get("tracts") or 0),
            people=int(zone_row.get("people") or 0),
            no_car_households=int(zone_row.get("no_car_households") or 0),
        ),
        tracts=tract_items,
        how_points_work=(
            "0-100 = statewide percentile (100 = highest in Florida). Priority points = weighted "
            "average. Only evacuation-zone tracts (coastal flood >=25% or mobile homes >=10%) ranked."
        ),
        labels={
            "no-car, 65+, mobile homes": LBL["measured"],
            "mobility disability": LBL["modeled"],
            "flood exposure": LBL["nri"],
        },
        recommended_actions=actions,
    )
    return out.model_dump()
