"""Q1 tools: which tracts to prioritize, and why. Each tract gets 0-100 points per factor (statewide
percentile); the weighted average ranks it, and its highest-scoring people factor is its main need."""
from __future__ import annotations

from google.adk.tools.tool_context import ToolContext

from .config import DEFAULT_WEIGHTS, LBL, table
from .data import _rows, resolve_county

FACTORS = {
    "no_car": ("pts_no_car", "households without a vehicle", LBL["measured"]),
    "older": ("pts_older", "residents 65+", LBL["measured"]),
    "disability": ("pts_disability", "adults with a mobility disability", LBL["modeled"]),
    "mobile_homes": ("pts_mobile_homes", "mobile homes", LBL["measured"]),
    "flood": ("pts_flood", "share of residents exposed to coastal flooding", LBL["nri"]),
}
NEED_LABEL = {"no_car": "no car: needs organized transport", "older": "older residents: needs check-ins and help leaving",
              "disability": "mobility disability: needs accessible transport and shelter",
              "mobile_homes": "mobile homes: must leave in any hurricane"}


def _weights(tool_context: ToolContext | None) -> dict[str, float]:
    w = dict(DEFAULT_WEIGHTS)
    if tool_context is not None:
        w.update(tool_context.state.get("priority_weights") or {})
    return w


def set_priority_weights(tool_context: ToolContext, no_car: float = 2.0, older: float = 1.0, disability: float = 1.0,
                         mobile_homes: float = 1.0, flood: float = 1.0) -> dict:
    """Changes how much each factor counts in the tract ranking, for the rest of this conversation.
    Use when the manager says e.g. "weight disability double" or "ignore mobile homes". 0 removes a factor.

    Args:
      no_car: weight for households without a vehicle (default 2).
      older: weight for residents 65+ (default 1).
      disability: weight for adults with a mobility disability, modeled (default 1).
      mobile_homes: weight for mobile homes (default 1).
      flood: weight for share of residents exposed to coastal flooding (default 1).

    Returns:
      the weights now in effect.
    """
    w = {"no_car": no_car, "older": older, "disability": disability, "mobile_homes": mobile_homes, "flood": flood}
    w = {k: max(0.0, float(v)) for k, v in w.items()}
    if not sum(w.values()):
        return {"error": "at least one weight must be above 0"}
    tool_context.state["priority_weights"] = w
    return {"weights_in_effect": w, "note": "Re-run rank_priority_tracts to see the new ranking."}


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
      ranked tracts with points per factor, main need, counts behind the points, and the weights used.
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
    rows = _rows(f"""
        SELECT geo_id, county_name, near_city, total_pop, hh_no_vehicle, pop_65_plus,
          ROUND(est_mobility_disabled_modeled) mobility_disabled_modeled, mobile_homes,
          ROUND(100 * coastal_flood_share) pct_coastal_flood_exposed, est_no_car_mobility_hh_modeled,
          evacuation_driver, pts_no_car, pts_older, pts_disability, pts_mobile_homes, pts_flood,
          ROUND(({expr}) / {total_w}, 1) AS priority_points
        FROM {table('tract_readiness')} WHERE {where}
        ORDER BY priority_points DESC LIMIT @n""", n=top_n, **params)
    zone = _rows(f"""SELECT COUNT(*) tracts, SUM(total_pop) people, SUM(hh_no_vehicle) no_car_households
                     FROM {table('tract_readiness')} WHERE {where}""", **params)[0]
    for r in rows:
        people = {k: r[FACTORS[k][0]] for k in ("no_car", "older", "disability", "mobile_homes")}
        main = max(people, key=lambda k: (people[k] * (1 if w[k] else 0), w[k]))
        r["main_need"] = NEED_LABEL[main]
        r["points"] = {k: r.pop(FACTORS[k][0]) for k in FACTORS}
        r["place"] = f"near {r.pop('near_city')}, {r['county_name']} County (tract {r['geo_id']})"
    names = {"no_car": "households without a car", "older": "residents 65+", "disability": "adults with a mobility "
             "disability", "mobile_homes": "mobile homes", "flood": "coastal-flood exposure"}
    parts = [f"{names[k]} x{w[k]:g}" for k in FACTORS if w[k]] + [f"{names[k]} ignored" for k in FACTORS if not w[k]]
    weights_sentence = "Weights in use: " + ", ".join(parts) + "." + (
        " (Default: households without a car count double; everything else counts once.)" if w == DEFAULT_WEIGHTS else "")
    return {
        "scope": scope, "weights_used": w, "weights_sentence": weights_sentence,
        "evacuation_zone_totals": zone,
        "tracts": rows,
        "how_points_work": "0-100 = statewide percentile (100 = highest in Florida). Priority points = weighted "
                           "average. Only evacuation-zone tracts (coastal flood >=25% or mobile homes >=10%) ranked.",
        "labels": {"no-car, 65+, mobile homes": LBL["measured"], "mobility disability": LBL["modeled"],
                   "flood exposure": LBL["nri"]},
    }
