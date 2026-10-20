"""Q2 tools: where would people in a tract go, and can they get there? Reachability depends on the
household: a car, no car, or no car plus a mobility disability."""
from __future__ import annotations

from google.adk.tools.tool_context import ToolContext

from .config import DEFAULT_RULES, LBL, table
from .data import _rows
from .verify import verify_pairs

KM_TO_MI = 0.621


def _rules(tool_context: ToolContext | None) -> dict[str, float]:
    r = dict(DEFAULT_RULES)
    if tool_context is not None:
        r.update(tool_context.state.get("reachability_rules") or {})
    return r


def set_reachability_rules(tool_context: ToolContext, car_drive_minutes: float = 30.0, walk_miles: float = 1.0) -> dict:
    """Changes what "reachable" means, for the rest of this conversation. Use when the manager says e.g.
    "a no-car household can only walk half a mile" or "45 minutes by car is acceptable".

    Args:
      car_drive_minutes: a household with a car can reach a shelter within this Google Maps drive time.
      walk_miles: a household without a car can walk to a shelter within this straight-line distance.

    Returns:
      the rules now in effect. No-car households with a mobility disability always need door-to-door pickup.
    """
    rules = {"car_drive_minutes": max(1.0, float(car_drive_minutes)), "walk_miles": max(0.1, float(walk_miles))}
    tool_context.state["reachability_rules"] = rules
    return {"rules_in_effect": rules,
            "fixed_rule": "No car + mobility disability: nothing is walkable; door-to-door pickup."}


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
      excluded shelters with the reason, and the rules used.
    """
    rules = _rules(tool_context)
    walk_km = rules["walk_miles"] / KM_TO_MI
    geo_ids = [g.strip() for g in geo_ids][:6]
    out, pairs = [], []
    for g in geo_ids:
        t = _rows(f"""SELECT geo_id, county_name, near_city, lat, lon, households, hh_no_vehicle,
                        est_no_car_mobility_hh_modeled FROM {table('tract_readiness')} WHERE geo_id=@g""", g=g)
        if not t:
            out.append({"geo_id": g, "error": "tract not found"})
            continue
        t = t[0]
        shelters = _rows(f"""
            SELECT shelter_id, shelter_name, address, city, usage, evacuation_capacity, wheelchair, generator,
              surge_flag, site_in_flood_hazard, is_medical,
              ROUND(ST_DISTANCE(ST_GEOGPOINT(longitude, latitude), ST_GEOGPOINT(@lon, @lat)) / 1000, 2) km
            FROM {table('shelters_enriched')}
            WHERE (pre_landfall OR usage_unknown)
              AND ST_DWITHIN(ST_GEOGPOINT(longitude, latitude), ST_GEOGPOINT(@lon, @lat), 40000)
            ORDER BY km LIMIT 12""", lat=float(t["lat"]), lon=float(t["lon"]))
        usable, excluded = [], []
        for s in shelters:
            s["miles"] = round(s.pop("km") * KM_TO_MI, 1)
            cap = s.pop("evacuation_capacity")
            s["capacity"] = "❓ unrecorded" if cap is None else cap
            s["fema_record"] = (f"{LBL['fema']}: wheelchair {s.pop('wheelchair')}, generator {s.pop('generator')}, "
                                f"surge flag {s['surge_flag']}").replace("UNRECORDED", "❓ unrecorded")
            if s["surge_flag"] == "YES":
                excluded.append({"name": s["shelter_name"], "reason": f"{LBL['fema']} says it is inside the storm surge zone"})
            elif cap in (None, 0):
                excluded.append({"name": s["shelter_name"], "reason": "no evacuation capacity on record (❓): confirm with operator"})
            else:
                if s.pop("site_in_flood_hazard"):
                    s["flag"] = f"on high coastal-flood ground ({LBL['nri']}): confirm the building's elevation"
                s.pop("surge_flag")
                usable.append(s)
        walkable = [s for s in usable if s["miles"] <= rules["walk_miles"]]
        drive_candidates = usable[:2]
        for s in drive_candidates:
            pairs.append((s["shelter_id"], g))
        out.append({"tract": t, "usable": usable[:4], "walkable": walkable, "drive_candidates": drive_candidates,
                    "excluded": excluded[:5]})

    live = verify_pairs(pairs) if check_drive_times and pairs else {}

    tracts = []
    for row in out:
        if "error" in row:
            tracts.append(row)
            continue
        t, g = row["tract"], row["tract"]["geo_id"]
        car = []
        for s in row["drive_candidates"]:
            v = live.get((s["shelter_id"], g))
            entry = {"shelter": s["shelter_name"], "address": f"{s['address']}, {s['city']}",
                     "straight_line": f"{s['miles']} mi {LBL['straight']}", "capacity": s["capacity"],
                     "fema_record": s["fema_record"], "flag": s.get("flag")}
            if v:
                d = v.get("drive") or {}
                if d.get("drive_minutes") is not None:
                    entry["drive"] = f"{d['drive_minutes']} min {LBL['drive']}"
                    entry["reachable_by_car"] = d["drive_minutes"] <= rules["car_drive_minutes"]
                entry["live_check"] = f"{LBL['live']}: {v['verdict']}" + (f" ({'; '.join(v['flags'])})" if v.get("flags") else "")
                src = (v.get("google_maps_sources") or [])[:1]
                if src:
                    entry["maps_attribution"] = f"Google Maps — [{(src[0]['title'] or '').replace(' - Google Maps', '').strip() or 'place'}]({src[0]['uri']})"
                if v["verdict"] not in ("CONFIRMED_EXISTS", "RENAMED_OR_REBRANDED") or any(
                        "temporarily closed" in f for f in v.get("flags", [])):
                    entry["usable"] = False
                    entry["why_not"] = v.get("action")
            car.append(entry)
        hh, no_car, door = t["households"], t["hh_no_vehicle"], t["est_no_car_mobility_hh_modeled"]
        tracts.append({
            "place": f"near {t['near_city']}, {t['county_name']} County (tract {g})",
            "households_with_car": {"count": f"{int(hh - no_car):,} {LBL['measured']}", "destinations": car},
            "households_without_car": {
                "count": f"{int(no_car):,} {LBL['measured']}",
                "walkable_shelters": [{"shelter": s["shelter_name"], "straight_line": f"{s['miles']} mi {LBL['straight']}",
                                       "capacity": s["capacity"], "flag": s.get("flag")} for s in row["walkable"]],
                "verdict": ("can walk to a usable shelter" if row["walkable"] else
                            f"no usable shelter within {rules['walk_miles']} mi: needs a pickup point / bus"),
            },
            "no_car_with_mobility_disability": {
                "count": f"~{int(door or 0):,} households {LBL['modeled']}",
                "verdict": "door-to-door pickup (paratransit) needed; walking distance does not apply",
            },
            "excluded_shelters": row["excluded"],
        })
    return {"rules_used": rules, "tracts": tracts,
            "surge_rule": "Excluded: shelters FEMA records inside the storm surge zone. Flagged, not excluded: shelters "
                          "on tracts with >=25% coastal-flood exposure (tract-level proxy).",
            "attribution": "Copy each maps_attribution line verbatim directly under the shelter it supports."}
