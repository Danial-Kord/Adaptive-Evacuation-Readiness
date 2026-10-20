import React, { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

/* The main page: the county's readiness story, told as the three questions a manager asks.
   Data comes from /api/story/*, which calls the same tools the assistant uses. */

type Any = Record<string, any>;
const API = import.meta.env.VITE_API_BASE_URL || "";
const fmt = (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString());
const shortPlace = (place: string) => place.replace(/^near /, "").replace(/, .* County.*$/, "");

async function getJSON(path: string, init?: RequestInit): Promise<Any> {
  const r = await fetch(`${API}${path}`, init);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

const NEED_ICON: Record<string, string> = {
  "no car": "🚌",
  "older residents": "👵",
  "mobility disability": "♿",
  "mobile homes": "🏠",
};
const needIcon = (need: string) => NEED_ICON[Object.keys(NEED_ICON).find((k) => need.startsWith(k)) ?? ""] ?? "•";

function MapsLink({ line }: { line?: string }) {
  // line looks like "Google Maps — [Name](https://...)"
  const m = line?.match(/\[([^\]]*)\]\(([^)]+)\)/);
  if (!m) return null;
  return (
    <a className="maps-source" href={m[2]} target="_blank" rel="noopener noreferrer">
      Source: <span translate="no">Google Maps</span> · {m[1]}
    </a>
  );
}

function StoryMap({ tracts, shelters, selected, onSelect }: {
  tracts: Any[]; shelters: Any[]; selected?: string; onSelect: (geo: string) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  useEffect(() => {
    if (!el.current) return;
    map.current = L.map(el.current, { scrollWheelZoom: false, zoomControl: true }).setView([26.6, -81.85], 10);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => { map.current?.remove(); map.current = null; };
  }, []);
  useEffect(() => {
    if (!map.current || !layer.current) return;
    layer.current.clearLayers();
    const color: Record<string, string> = { YES: "#2f7d57", NO: "#c0392b", UNRECORDED: "#c9a227" };
    shelters.forEach((s) => {
      if (s.latitude == null) return;
      L.circleMarker([s.latitude, s.longitude], {
        radius: 4, weight: 1, color: "#ffffff", fillColor: color[s.wheelchair_status] ?? "#999", fillOpacity: 0.9,
      }).bindTooltip(`${s.shelter_name} · wheelchair access: ${s.wheelchair_status === "UNRECORDED" ? "never recorded" : s.wheelchair_status.toLowerCase()}`)
        .addTo(layer.current!);
    });
    const pts: L.LatLngExpression[] = [];
    tracts.forEach((t, i) => {
      if (t.lat == null) return;
      pts.push([t.lat, t.lon]);
      const isSel = t.geo_id === selected;
      L.marker([t.lat, t.lon], {
        icon: L.divIcon({ className: "", html: `<div class="rank-pin ${isSel ? "selected" : ""}">${i + 1}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
      }).on("click", () => onSelect(t.geo_id)).bindTooltip(shortPlace(t.place)).addTo(layer.current!);
    });
    if (pts.length) map.current.fitBounds(L.latLngBounds(pts).pad(0.35), { maxZoom: 11 });
  }, [tracts, shelters, selected, onSelect]);
  return (
    <div className="story-map-wrap">
      <div ref={el} className="story-map" />
      <div className="story-map-key">
        <span><i className="rank-pin mini">1</i> Priority neighborhood</span>
        <span><i className="dot" style={{ background: "#2f7d57" }} /> Shelter: wheelchair access recorded</span>
        <span><i className="dot" style={{ background: "#c9a227" }} /> Shelter: never checked</span>
      </div>
    </div>
  );
}

export function StoryPage({ county, onAsk }: { county: { name: string; fips: string }; onAsk: (q: string) => void }) {
  const [pri, setPri] = useState<Any | null>(null);
  const [quality, setQuality] = useState<Any | null>(null);
  const [gaps, setGaps] = useState<Any | null>(null);
  const [shelters, setShelters] = useState<Any[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [dest, setDest] = useState<Record<string, { data?: Any; live: boolean; error?: string }>>({});
  const [verify, setVerify] = useState<{ loading: boolean; data?: Any; error?: string }>({ loading: false });
  const [error, setError] = useState<string | null>(null);
  // Live Google Maps accessibility sweep over never-recorded shelters. Shown on screen only:
  // Google Maps content may not be stored (only place_id is kept).
  const [sweep, setSweep] = useState<{ running: boolean; done: number; total: number; yes: number; no: number; notListed: number; failed: number; at?: string } | null>(null);

  useEffect(() => {
    setPri(null); setQuality(null); setGaps(null); setShelters([]); setSelected(undefined); setDest({}); setVerify({ loading: false }); setError(null); setSweep(null);
    const c = encodeURIComponent(county.name);
    getJSON(`/api/story/priorities?county=${c}&top_n=6`).then((d) => { setPri(d); setSelected(d.tracts?.[0]?.geo_id); }).catch((e) => setError(String(e)));
    getJSON(`/api/story/quality?county=${c}`).then(setQuality).catch(() => {});
    getJSON(`/api/story/gaps?county=${c}`).then(setGaps).catch(() => {});
    getJSON(`/api/area/map-points?county=${c}`).then((d) => setShelters(d.shelters ?? [])).catch(() => {});
  }, [county.name]);

  // Destinations: fast answer from the records first, then live Google Maps drive times.
  useEffect(() => {
    if (!selected || dest[selected]) return;
    const g = selected;
    setDest((p) => ({ ...p, [g]: { live: false } }));
    getJSON(`/api/story/destinations?geo_id=${g}&live=false`).then((d) => setDest((p) => ({ ...p, [g]: { data: d, live: false } })))
      .catch((e) => setDest((p) => ({ ...p, [g]: { live: false, error: String(e) } })));
    getJSON(`/api/story/destinations?geo_id=${g}&live=true`).then((d) => setDest((p) => ({ ...p, [g]: { data: d, live: true } })))
      .catch(() => {});
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const tracts: Any[] = pri?.tracts ?? [];
  const sel = tracts.find((t) => t.geo_id === selected);
  const selDest = selected ? dest[selected] : undefined;
  const d0 = selDest?.data?.tracts?.[0];
  const access = useMemo(() => {
    const c = { YES: 0, NO: 0, UNRECORDED: 0 } as Record<string, number>;
    shelters.forEach((s) => { c[s.wheelchair_status] = (c[s.wheelchair_status] ?? 0) + 1; });
    return c;
  }, [shelters]);
  const zone = pri?.evacuation_zone_totals;
  const power = gaps?.medical_and_power_dependence;

  const runVerify = () => {
    const ids = (quality?.suspicious_records ?? []).map((r: Any) => Number(r.shelter_id)).slice(0, 6);
    if (!ids.length) return;
    setVerify({ loading: true });
    getJSON(`/api/story/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shelter_ids: ids }) })
      .then((d) => setVerify({ loading: false, data: d }))
      .catch((e) => setVerify({ loading: false, error: String(e) }));
  };

  const runAccessSweep = async () => {
    const ids = shelters.filter((x) => x.wheelchair_status === "UNRECORDED").map((x) => Number(x.shelter_id));
    if (!ids.length) return;
    const batches: number[][] = [];
    for (let k = 0; k < ids.length; k += 8) batches.push(ids.slice(k, k + 8));
    setSweep({ running: true, done: 0, total: ids.length, yes: 0, no: 0, notListed: 0, failed: 0 });
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        let res: Any[] = [];
        try {
          const d = await getJSON(`/api/story/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shelter_ids: batch }) });
          res = d.results ?? [];
        } catch { /* counted as failed below */ }
        const count = (pred: (v: Any) => boolean) => res.filter(pred).length;
        setSweep((p) => p && {
          ...p,
          done: p.done + batch.length,
          yes: p.yes + count((v) => v.maps_wheelchair_entrance === "yes"),
          no: p.no + count((v) => v.maps_wheelchair_entrance === "no"),
          notListed: p.notListed + count((v) => v.verdict !== "UNVERIFIED" && v.verdict !== "LOOKUP_FAILED" && (!v.maps_wheelchair_entrance || v.maps_wheelchair_entrance === "not listed")),
          failed: p.failed + (batch.length - res.length) + count((v) => v.verdict === "UNVERIFIED" || v.verdict === "LOOKUP_FAILED"),
        });
      }
    };
    await Promise.all([worker(), worker()]);
    setSweep((p) => p && { ...p, running: false, at: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) });
  };

  const capOf = (x: Any) => Number(x.evacuation_capacity ?? 0);
  const preLandfall = shelters.filter((x) => x.usage === "EVAC" || x.usage === "BOTH");
  const statusTag = (v: string) => v === "UNRECORDED" ? <span className="tag unrec">never recorded</span> : v === "YES" ? <span className="tag yes">yes</span> : <span className="tag no">no</span>;
  type Row = { name: React.ReactNode; meta: React.ReactNode };
  const checklist: { title: string; why: string; ask: string; rows: Row[]; more?: number }[] = gaps ? [
    {
      title: `Set up pickup points for ${fmt(gaps.evacuation_zone_tracts_with_no_shelter_within_1_mile?.households_no_vehicle)} households without a car`,
      why: `They live in ${fmt(gaps.evacuation_zone_tracts_with_no_shelter_within_1_mile?.tracts)} evacuation-zone neighborhoods with no shelter within a 1-mile walk. Start with these:`,
      ask: `Which neighborhoods in ${county.name} County need pickup points for households without a car?`,
      rows: (gaps.evacuation_zone_tracts_with_no_shelter_within_1_mile?.worst ?? []).slice(0, 5).map((w: Any) => ({
        name: <>{w.near_city ? `Near ${w.near_city}` : "Neighborhood"} <small className="muted">(tract {w.geo_id})</small></>,
        meta: `${fmt(w.hh_no_vehicle)} households without a car · nearest shelter ${w.miles_nearest_shelter} mi`,
      })),
      more: Math.max(0, (gaps.evacuation_zone_tracts_with_no_shelter_within_1_mile?.tracts ?? 0) - 5),
    },
    {
      title: `Ask ${fmt(quality?.unrecorded_counts?.wheelchair)} shelter operators whether a wheelchair user can get in on their own`,
      why: "Nobody ever recorded it. Unknown is not the same as \"no\". Call the biggest evacuation shelters first:",
      ask: `Which ${county.name} County shelters should we ask about wheelchair access first?`,
      rows: preLandfall.filter((x) => x.wheelchair_status === "UNRECORDED").sort((a, b) => capOf(b) - capOf(a)).slice(0, 5).map((x) => ({
        name: <>{x.shelter_name} <small className="muted">{x.city}</small></>,
        meta: `${fmt(capOf(x))} spaces`,
      })),
      more: Math.max(0, preLandfall.filter((x) => x.wheelchair_status === "UNRECORDED").length - 5),
    },
    {
      title: `Confirm the building height of ${fmt(gaps.shelters_on_flood_hazard_ground?.on_flood_hazard_ground)} shelters on high flood-risk ground`,
      why: `${fmt(gaps.shelters_on_flood_hazard_ground?.capacity_on_flood_hazard_ground)} of ${fmt(gaps.shelters_on_flood_hazard_ground?.pre_landfall_capacity)} spaces sit in areas FEMA's model rates as highly exposed to coastal flooding. The largest:`,
      ask: `Which ${county.name} County shelters sit on high coastal-flood ground?`,
      rows: (gaps.shelters_on_flood_hazard_ground?.largest ?? []).slice(0, 5).map((x: Any) => ({
        name: <>{x.shelter_name} <small className="muted">{x.city}</small></>,
        meta: `${fmt(x.capacity)} spaces · ${x.pct_tract_flood_exposed}% of area exposed`,
      })),
      more: Math.max(0, (gaps.shelters_on_flood_hazard_ground?.on_flood_hazard_ground ?? 0) - 5),
    },
    {
      title: `Confirm backup power at the ${fmt(power?.medical_needs_shelters)} medical-needs shelters`,
      why: `${fmt(power?.power_dependent_residents)} residents rely on powered medical equipment (county total). Generator on record:`,
      ask: `How many people in ${county.name} County depend on electricity for medical equipment, and are the medical shelters ready?`,
      rows: shelters.filter((x) => x.is_medical).sort((a, b) => capOf(b) - capOf(a)).slice(0, 9).map((x) => ({
        name: <>{x.shelter_name} <small className="muted">{x.city}</small></>,
        meta: <>{fmt(capOf(x))} spaces · generator {statusTag(x.generator_status)}</>,
      })),
    },
    {
      title: `Review evacuation plans for ${fmt(gaps.nursing_homes?.on_flood_hazard_ground)} nursing homes on flood-risk ground`,
      why: `${fmt(gaps.nursing_homes?.beds_on_flood_hazard_ground)} beds in total. The largest:`,
      ask: `Which ${county.name} County nursing homes are on flood-risk ground?`,
      rows: (gaps.nursing_homes?.largest ?? []).slice(0, 5).map((x: Any) => ({
        name: <>{String(x.provider_name).toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase())} <small className="muted">{String(x.citytown).toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase())}</small></>,
        meta: `${fmt(x.beds)} beds · nearest medical shelter ${x.miles_nearest_medical_shelter} mi`,
      })),
      more: Math.max(0, (gaps.nursing_homes?.on_flood_hazard_ground ?? 0) - 5),
    },
  ] : [];

  return (
    <main className="story">
      <section className="story-hero">
        <p className="story-eyebrow">Hurricane season planning</p>
        <h1>{county.name} County readiness</h1>
        <p className="story-lede">Who would struggle to leave, where they could go, and how far you can trust the shelter list. Built from federal records and checked live on <span translate="no">Google Maps</span>.</p>
        <div className="story-stats">
          <div><strong>{fmt(zone?.people)}</strong><span>people live where an evacuation order would apply</span></div>
          <div><strong>{fmt(zone?.no_car_households)}</strong><span>of their households have no car</span></div>
          <div className="stat-alert">
            <span className="alert-badge">Needs attention</span>
            <strong>{quality ? `${quality.unrecorded_counts.wheelchair} of ${quality.unrecorded_counts.shelters}` : "—"}</strong>
            <span>shelters never checked for wheelchair access</span>
            {sweep && !sweep.running && <span className="stat-update"><b>{sweep.yes}</b> of those show an accessible entrance on <span translate="no">Google Maps</span> (checked {sweep.at}, operator still needs to confirm)</span>}
            <button className="stat-btn" onClick={runAccessSweep} disabled={!shelters.length || sweep?.running}>
              {sweep?.running ? `Checking on Google Maps… ${sweep.done} of ${sweep.total}` : sweep ? "Check again" : "Check them on Google Maps"}
            </button>
          </div>
          <div><strong>{fmt(power?.power_dependent_residents)}</strong><span>residents rely on powered medical equipment (county total)</span></div>
        </div>
        {error && <p className="story-error">Couldn't load the county data. Please refresh. ({error})</p>}
      </section>

      <section className="story-section">
        <div className="story-q"><span className="story-num">1</span><div><h2>Who would struggle to leave?</h2><p>Neighborhoods an evacuation order would cover, ranked by how many people there would need help getting out.</p></div></div>
        <div className="story-split">
          <div className="hood-list">
            {!pri && <div className="skeleton-list">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" />)}</div>}
            {tracts.map((t, i) => (
              <button key={t.geo_id} className={`hood-card ${t.geo_id === selected ? "selected" : ""}`} onClick={() => setSelected(t.geo_id)}>
                <span className="hood-rank">{i + 1}</span>
                <span className="hood-body">
                  <span className="hood-name">{shortPlace(t.place)}</span>
                  <span className="hood-need">{needIcon(t.main_need)} {t.main_need.replace(/^[^:]+: /, "")}</span>
                  <span className="hood-facts">{fmt(t.hh_no_vehicle)} households without a car · {fmt(t.pop_65_plus)} aged 65+ · {fmt(t.mobile_homes)} mobile homes</span>
                </span>
                <span className="hood-score"><b>{Math.round(t.priority_points)}</b><small>of 100</small></span>
              </button>
            ))}
            {pri && (
              <details className="story-how">
                <summary>How is this ranked?</summary>
                <p>Each neighborhood is compared with every neighborhood in Florida on five things: households without a car, residents aged 65+, adults with a mobility disability (estimated), mobile homes, and coastal-flood exposure. {pri.weights_sentence}</p>
                <button className="link-btn" onClick={() => onAsk(`Weight disability double and rank ${county.name} County again. What changes?`)}>Ask the assistant to change what matters most →</button>
              </details>
            )}
          </div>
          <StoryMap tracts={tracts} shelters={shelters} selected={selected} onSelect={setSelected} />
        </div>
      </section>

      <section className="story-section">
        <div className="story-q"><span className="story-num">2</span><div><h2>Where would they go?</h2><p>{sel ? <>For <b>{shortPlace(sel.place)}</b>. It depends on whether a household has a car, and whether someone uses a wheelchair.</> : "Pick a neighborhood above."}</p></div></div>
        {selDest?.error && <p className="story-error">Couldn't work out destinations: {selDest.error}</p>}
        {!d0 && !selDest?.error && <div className="tier-grid">{[0, 1, 2].map((i) => <div key={i} className="skeleton tall" />)}</div>}
        {d0 && (
          <div className="tier-grid">
            <article className="tier">
              <h3>🚗 Households with a car</h3>
              <p className="tier-count">{d0.households_with_car.count.replace(/ 📊.*/, "")}</p>
              {d0.households_with_car.destinations.map((s: Any) => (
                <div key={s.shelter} className="tier-dest">
                  <b>{s.shelter}</b>
                  <span>{s.drive ? <>{s.drive.replace(" 🚗 Google Maps drive time", "")} drive</> : selDest?.live ? "drive time unavailable" : <i className="checking">checking drive time on Google Maps…</i>} · {s.straight_line.replace(" 📏 straight-line", "")} straight-line</span>
                  {s.flag && <span className="tier-flag">⚠ On high flood-risk ground: confirm the building is safe</span>}
                  {s.usable === false && <span className="tier-flag bad">✕ {s.why_not}</span>}
                  <MapsLink line={s.maps_attribution} />
                </div>
              ))}
              <p className="tier-verdict good">Reachable if the drive is under {selDest?.data?.rules_used?.car_drive_minutes ?? 30} minutes</p>
            </article>
            <article className="tier">
              <h3>🚶 Households without a car</h3>
              <p className="tier-count">{d0.households_without_car.count.replace(/ 📊.*/, "")}</p>
              {d0.households_without_car.walkable_shelters.length ? d0.households_without_car.walkable_shelters.map((s: Any) => (
                <div key={s.shelter} className="tier-dest"><b>{s.shelter}</b><span>{s.straight_line.replace(" 📏 straight-line", "")} walk (straight-line)</span>{s.flag && <span className="tier-flag">⚠ On high flood-risk ground</span>}</div>
              )) : <p className="tier-verdict bad">No usable shelter within a {selDest?.data?.rules_used?.walk_miles ?? 1}-mile walk</p>}
              <p className="tier-verdict">{d0.households_without_car.walkable_shelters.length ? "Can walk to a shelter" : "→ Needs a pickup point or bus"}</p>
            </article>
            <article className="tier">
              <h3>♿ No car, and someone uses a wheelchair</h3>
              <p className="tier-count">{d0.no_car_with_mobility_disability.count.replace(/ 🧮.*/, "").replace(" households", "")} <small>households (estimated)</small></p>
              <p>Walking distance doesn't apply. These households need a door-to-door pickup, and a shelter that can actually take a wheelchair.</p>
              <p className="tier-verdict bad">→ Needs door-to-door pickup (paratransit)</p>
            </article>
          </div>
        )}
        {d0?.excluded_shelters?.length > 0 && (
          <p className="story-note">Left out of this plan: {d0.excluded_shelters.map((x: Any) => `${x.name} (${x.reason.replace(/ \(❓\)/, "").replace("🕰️ ", "")})`).join("; ")}.</p>
        )}
        {sel && <button className="ask-btn" onClick={() => onAsk(`For the neighborhood near ${shortPlace(sel.place)} (tract ${sel.geo_id}), where would people without a car go, and what should we arrange?`)}>Ask the assistant about this neighborhood →</button>}
      </section>

      <section className="story-section">
        <div className="story-q"><span className="story-num">3</span><div><h2>Can we trust the shelter list?</h2><p>The shelter list is a historical federal record. Here's what it never captured, and what looks out of date.</p></div></div>
        <div className="trust-grid">
          <article className="trust-card">
            <h3>Wheelchair access on record</h3>
            <div className="access-bar">
              {(["YES", "NO", "UNRECORDED"] as const).map((k) => access[k] ? <span key={k} className={`seg ${k.toLowerCase()}`} style={{ flex: access[k] }} /> : null)}
            </div>
            <ul className="access-legend">
              <li><i className="sw yes" />{access.YES} recorded as accessible</li>
              <li><i className="sw no" />{access.NO} recorded as not accessible</li>
              <li><i className="sw unrecorded" /><b>{access.UNRECORDED} never checked</b>: unknown, not “no”</li>
            </ul>
            {sweep && (
              <div className="sweep">
                <div className="sweep-bar"><span style={{ width: `${Math.round((100 * sweep.done) / Math.max(sweep.total, 1))}%` }} /></div>
                <p className="sweep-title">{sweep.running ? `Checking never-recorded shelters on Google Maps… ${sweep.done} of ${sweep.total}` : `Live check of ${sweep.total} never-recorded shelters (${sweep.at})`}</p>
                <ul className="access-legend">
                  <li><i className="sw yes" /><b>{sweep.yes}</b> show a wheelchair-accessible entrance on <span translate="no">Google Maps</span></li>
                  <li><i className="sw no" />{sweep.no} say the entrance is not accessible</li>
                  <li><i className="sw unrecorded" />{sweep.notListed} not listed on <span translate="no">Google Maps</span> either: someone has to ask</li>
                  {sweep.failed > 0 && <li><i className="sw gray" />{sweep.failed} couldn't be checked right now</li>}
                </ul>
                <p className="story-note">An accessible entrance isn't proof that a wheelchair user can use the shelter on their own, so these stay unconfirmed until the operator answers. Google Maps results are shown here, not saved (its terms only allow keeping the place ID).</p>
              </div>
            )}
            {quality && <p className="story-note">Generators: {quality.unrecorded_counts.generator} of {quality.unrecorded_counts.shelters} never recorded. Storm-surge flag: {quality.unrecorded_counts.surge_flag} never recorded.</p>}
          </article>
          <article className="trust-card">
            <h3>Records that don't add up</h3>
            {!quality && <div className="skeleton" />}
            <ul className="issue-list">
              {(quality?.self_contradicting_records ?? []).map((c: Any) => (
                <li key={c.address}><b>{c.records?.[0]?.shelter_name?.replace(/ - .*/, "")}</b>, {c.address}: listed as wheelchair-accessible in one record and not accessible in another.</li>
              ))}
              {(quality?.suspicious_records ?? []).map((r: Any) => (
                <li key={r.shelter_id}><b>{r.shelter_name}</b>: {r.issue.replace("FEMA county text disagrees with coordinates", "its location doesn't match its listed county").replace("pre-landfall shelter with 0 recorded capacity", "listed as an evacuation shelter but with 0 spaces").replace("name says inactive/closed", "its own name says it's inactive")}</li>
              ))}
            </ul>
            <button className="ask-btn" onClick={runVerify} disabled={verify.loading || !quality}>
              {verify.loading ? "Checking each building on Google Maps…" : "Check these buildings on Google Maps now"}
            </button>
            {verify.error && <p className="story-error">{verify.error}</p>}
            {verify.data && (
              <ul className="verify-list">
                {verify.data.results.map((v: Any) => (
                  <li key={v.shelter_id} className={`v-${String(v.verdict).toLowerCase()}`}>
                    <b>{v.registry_name}</b>
                    <span className="verdict">{({ CONFIRMED_EXISTS: "✓ Still there", RENAMED_OR_REBRANDED: "✓ Still there, new name", CLOSED: "✕ Closed", NOT_FOUND_ON_MAPS: "? Not found on Google Maps", DIFFERENT_PLACE_AT_ADDRESS: "! Something else is at this address", FOUND_AT_DIFFERENT_ADDRESS: "! Found at a different address", UNVERIFIED: "? Couldn't check right now" } as Any)[v.verdict] ?? v.verdict}</span>
                    {v.flags?.length > 0 && <small>{v.flags.join("; ")}</small>}
                    {v.action && <small>{v.action}</small>}
                    {(v.maps_attribution ?? []).slice(0, 1).map((l: string) => <MapsLink key={l} line={l} />)}
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>
      </section>

      <section className="story-section checklist">
        <div className="story-q"><span className="story-num">✓</span><div><h2>Before September</h2><p>What to assign this month, and exactly where to start.</p></div></div>
        {!gaps && <div className="skeleton tall" />}
        <ol className="todo">
          {checklist.map((c, n) => (
            <li key={c.title}>
              <div className="todo-head">
                <span className="todo-num">{n + 1}</span>
                <div><b>{c.title}</b><span>{c.why}</span></div>
              </div>
              {c.rows.length > 0 && (
                <ul className="todo-list">
                  {c.rows.map((r, k) => <li key={k}><span>{r.name}</span><span className="meta">{r.meta}</span></li>)}
                </ul>
              )}
              <div className="todo-more">
                {c.more ? <span className="muted">+ {c.more} more · </span> : null}
                <button className="link-btn" onClick={() => onAsk(c.ask)}>Ask the assistant for more →</button>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <footer className="story-footer">
        Planning tool, not for emergencies: in an emergency call 911. Sources: FEMA shelter registry (historical), U.S. Census, CDC, HHS emPOWER, CMS, FEMA National Risk Index; live checks by <span translate="no">Google Maps</span>.
      </footer>
    </main>
  );
}
