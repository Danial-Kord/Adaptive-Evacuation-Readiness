"""The Readiness Brief: one tool that assembles the four segments, with live verification
changing what gets recommended."""
from __future__ import annotations

from .config import MAX_VERIFY, WALK_KM
from .data import county_gap_report, find_people_who_cannot_self_evacuate, shelter_options_for_tract
from .verify import verify_pairs

USABLE = {"CONFIRMED_EXISTS", "RENAMED_OR_REBRANDED"}


def build_readiness_brief(county: str, top_n: int = 5, options_per_tract: int = 3, verify_live: bool = True) -> dict:
    """Builds the county's pre-season Readiness Brief in four segments:
    1) who cannot leave (ranked tracts with reasons), 2) where they would go and whether it holds
    up (nearest pre-landfall shelters, each verified live against Google Maps one building at a
    time, with drive times), 3) what to fix before the season, 4) what we could not tell you.

    Live verification changes the recommendation: closed or unconfirmable shelters are removed
    from a tract's usable options, and a tract left with no usable walkable option is flagged
    for a pickup point. Takes ~20-40 s when verify_live is true.

    Args:
      county: Florida county name, e.g. "Lee".
      top_n: number of priority tracts (max 8).
      options_per_tract: nearest shelters to consider per tract (max 4).
      verify_live: check shelters against Google Maps now (recommended).

    Returns:
      dict with the four segments. Every shelter carries FEMA (historical) fields and, when
      verified, Google Maps (live) fields with sources that must be displayed next to it.
    """
    top_n, options_per_tract = max(1, min(int(top_n), 8)), max(1, min(int(options_per_tract), 4))
    ranked = find_people_who_cannot_self_evacuate(county, top_n)
    tracts = []
    for t in ranked["tracts"]:
        opts = shelter_options_for_tract(t["geo_id"], options_per_tract)["shelters"]
        tracts.append({"tract": t, "options": opts})

    verified: dict[int, dict] = {}
    if verify_live:
        pairs, seen = [], set()
        for row in tracts:
            for o in row["options"]:
                if o["shelter_id"] not in seen:
                    seen.add(o["shelter_id"])
                    pairs.append((o["shelter_id"], row["tract"]["geo_id"]))
        verified = verify_pairs(pairs[:MAX_VERIFY])

    segment1, segment2 = [], []
    for row in tracts:
        t = row["tract"]
        segment1.append({k: t[k] for k in ("geo_id", "near_city", "total_pop", "hh_no_vehicle", "pct_households_no_vehicle",
                                           "pop_65_plus", "mobility_disabled_modeled", "mobile_homes",
                                           "evacuation_driver", "pct_coastal_flood_exposed", "why")})
        options, usable_walk, usable_any = [], 0, 0
        for o in row["options"]:
            v = next((r for (sid, _), r in verified.items() if sid == o["shelter_id"]), None)
            entry = {
                "shelter_id": o["shelter_id"], "name": o["shelter_name"], "address": f"{o['address']}, {o['city']}",
                "straight_line_miles": o["miles"], "reachability": o["reachability"], "capacity": o["capacity"],
                "fema_record": {"wheelchair": o["wheelchair"], "generator": o["generator"], "surge_flag": o["surge_flag"],
                                "medical_needs": o["is_medical"], "source": o["record_source"]},
                "site_on_flood_hazard_ground": o["site_in_flood_hazard"],
                "site_pct_tract_coastal_flood_exposed": o["site_pct_coastal_flood_exposed"],
            }
            if v:
                entry["live_check"] = {k: v.get(k) for k in ("verdict", "action", "flags", "accessibility", "drive",
                                                             "google_maps_sources", "checked_at")}
                entry["live_check"]["maps_name"] = (v.get("google_maps_says") or {}).get("maps_name")
                if v.get("origin_tract") != t["geo_id"]:
                    # The drive was routed from another tract that shares this shelter; don't reuse it.
                    entry["live_check"]["drive"] = {"note": f"drive time measured from tract {v.get('origin_tract')}, "
                                                            f"not this one; use straight-line miles"}
            ok = (v is None or v["verdict"] in USABLE) and not (v and "temporarily closed" in " ".join(v.get("flags", [])))
            if ok and (o["capacity"] == "UNRECORDED" or str(o["capacity"]).startswith("0")):
                # The building may be fine, but a plan cannot count spaces nobody recorded.
                ok = False
                entry["capacity_issue"] = "no usable capacity on record: confirm spaces with the operator"
            entry["usable_in_plan"] = ok if v else "not verified"
            if ok:
                usable_any += 1
                usable_walk += o["km"] <= WALK_KM
            options.append(entry)
        if t["hh_no_vehicle"] and usable_walk == 0:
            rec = (f"No verified shelter within walking distance for {int(t['hh_no_vehicle'])} no-vehicle households: "
                   f"designate a pickup point and pre-arrange transport.")
        elif usable_walk:
            rec = "At least one verified shelter is walkable; confirm accessibility with its operator."
        else:
            rec = "Review options."
        if any(e.get("site_on_flood_hazard_ground") for e in options if e["usable_in_plan"] is True):
            rec += " Some usable options sit on flood-hazard ground: confirm the building's own elevation/surge status."
        segment2.append({"geo_id": t["geo_id"], "recommendation": rec, "usable_options": usable_any, "options": options})

    gaps = county_gap_report(county)
    tally: dict[str, int] = {}
    for v in verified.values():
        tally[v["verdict"]] = tally.get(v["verdict"], 0) + 1
    unknown = gaps.pop("what_the_record_cannot_tell_us")
    return {
        "county": ranked["county"],
        "county_totals": ranked["county_totals"],
        "1_who_cannot_leave": segment1,
        "2_where_they_would_go": segment2,
        "3_what_to_fix_before_the_season": gaps,
        "4_what_we_could_not_tell_you": {
            **unknown,
            "live_verification_tally": tally,
            "standing_limits": [
                "Accessibility: most shelters were never assessed; an entrance listed on Google Maps is not proof "
                "a wheelchair user can use the shelter unaccompanied.",
                "Distances in the tables are straight-line; drive times shown come from Google Maps routing.",
                "Power dependence is county-level only.",
                "Mobility-disability counts are modeled estimates (CDC PLACES), not counts.",
                "No individual-level data is used; this cannot say which specific people need help.",
            ],
        },
        "method": ranked["method"],
    }
