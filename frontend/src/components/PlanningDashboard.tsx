import React, { useCallback, useEffect, useMemo, useState } from "react";
import { fetchDashboard, COUNTIES } from "../services/dashboardApi";
import { DashboardData, displayNumber as fmt, DashboardShelter, DashboardTract } from "../services/dashboardData";
import { ActionDecisionRecord, ActionDecisionStatus, RecommendedAction } from "../types/brief";
import { CountyMap } from "./CountyMap";
import { ChatPanel, ExternalDecisionTrigger } from "./ChatPanel";
import { FocusLocationTarget } from "./AgentSchemaCards";
import { AreaDetailsPanel } from "./AreaDetailsPanel";

const share = (value: number | null) => value === null ? "Unrecorded" : `${fmt(value)}%`;

export type PlanningView = "overview" | "priority" | "shelters" | "gaps" | "sources";
interface Props {
  view: PlanningView;
  county: typeof COUNTIES[number];
  mode: "live" | "preview";
  refresh: number;
  onPreview: () => void;
  hideAssistant?: boolean;
  sharedActions?: RecommendedAction[];
  sharedDecisions?: Record<string, ActionDecisionRecord>;
  onSharedDecisionsChange?: React.Dispatch<React.SetStateAction<Record<string, ActionDecisionRecord>>>;
  selectedOptionsByAction?: Record<string, string>;
  onSelectActionOption?: (actionId: string, optionId: string) => void;
  activeActionId?: string | null;
  onActiveActionChange?: (actionId: string | null) => void;
  focusTarget?: FocusLocationTarget | null;
  onFocusTargetChange?: (target: FocusLocationTarget | null) => void;
  onDecideFromMap?: (
    action: RecommendedAction,
    decision: ActionDecisionStatus,
    selectedOptionId?: string,
    note?: string,
    sendFollowUp?: boolean
  ) => void;
  onAskExternal?: (text: string) => void;
}
export function PlanningDashboard({
  view,
  county,
  mode,
  refresh,
  onPreview,
  hideAssistant = false,
  sharedActions: externalActions,
  sharedDecisions: externalDecisions,
  onSharedDecisionsChange: externalOnDecisionsChange,
  selectedOptionsByAction: externalSelectedOptions,
  onSelectActionOption: externalOnSelectOption,
  activeActionId: externalActiveActionId,
  onActiveActionChange: externalOnActiveActionChange,
  focusTarget: externalFocusTarget,
  onFocusTargetChange: externalOnFocusTargetChange,
  onDecideFromMap: externalOnDecideFromMap,
  onAskExternal,
}: Props) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<{kind: "shelter" | "tract"; id: string} | null>(null);
  const [inspectedPoint, setInspectedPoint] = useState<{lat: number; lng: number; label?: string} | null>(null);
  const [radiusKm, setRadiusKm] = useState<number>(15);
  const [question, setQuestion] = useState<{text: string; id: number; send?: boolean} | null>(null);
  const [accessFilter, setAccessFilter] = useState("ALL");
  const [retry, setRetry] = useState(0);

  // Shared state between CountyMap and ChatPanel so actions, option selections, FROM->TO zoom, and Approve/Reject dismissals stay 100% synchronized
  const [internalActions, setInternalActions] = useState<RecommendedAction[]>([]);
  const [internalDecisions, setInternalDecisions] = useState<Record<string, ActionDecisionRecord>>({});
  const [internalSelectedOptions, setInternalSelectedOptions] = useState<Record<string, string>>({});
  const [internalActiveActionId, setInternalActiveActionId] = useState<string | null>(null);
  const [internalFocusTarget, setInternalFocusTarget] = useState<FocusLocationTarget | null>(null);
  const [externalDecisionTrigger, setExternalDecisionTrigger] = useState<ExternalDecisionTrigger | null>(null);

  const sharedActions = externalActions ?? internalActions;
  const sharedDecisions = externalDecisions ?? internalDecisions;
  const setSharedDecisions = externalOnDecisionsChange ?? setInternalDecisions;
  const selectedOptionsByAction = externalSelectedOptions ?? internalSelectedOptions;
  const activeActionId = externalActiveActionId !== undefined ? externalActiveActionId : internalActiveActionId;
  const setActiveActionId = externalOnActiveActionChange ?? setInternalActiveActionId;
  const focusTarget = externalFocusTarget !== undefined ? externalFocusTarget : internalFocusTarget;
  const setFocusTarget = externalOnFocusTargetChange ?? setInternalFocusTarget;

  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(""); setSelected(null); setInspectedPoint(null); setQuestion(null);
    setInternalActions([]);
    setInternalDecisions({}); setInternalSelectedOptions({}); setInternalActiveActionId(null); setInternalFocusTarget(null);
    fetchDashboard(county.fips, mode, controller.signal)
      .then(d => { if (!controller.signal.aborted) setData(d); })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Unable to load county records."); });
    return () => controller.abort();
  }, [county.fips, county.name, mode, refresh, retry]);

  const pendingActions = useMemo(
    () => sharedActions.filter(a => !sharedDecisions[a.action_id]),
    [sharedActions, sharedDecisions]
  );

  // Keep activeActionId pointed at a valid pending action
  useEffect(() => {
    if (!pendingActions.length) {
      setActiveActionId(null);
      return;
    }
    if (!activeActionId || !pendingActions.some(a => a.action_id === activeActionId)) {
      setActiveActionId(pendingActions[0].action_id);
    }
  }, [pendingActions, activeActionId, setActiveActionId]);

  const select = useCallback((kind: "shelter" | "tract", id: string) => setSelected({kind, id}), []);
  const inspectPoint = useCallback((lat: number, lng: number, label?: string) => {
    setInspectedPoint({ lat, lng, label });
  }, []);

  const handleSelectActionOption = useCallback((actionId: string, optionId: string) => {
    setInternalSelectedOptions(prev => ({ ...prev, [actionId]: optionId }));
    externalOnSelectOption?.(actionId, optionId);
    setActiveActionId(actionId);
  }, [externalOnSelectOption, setActiveActionId]);

  const handleFocusFromWidget = useCallback((target: FocusLocationTarget) => {
    if (target.actionId) {
      setActiveActionId(target.actionId);
    }
    if (target.kind === "tract" && target.id) {
      setSelected({ kind: "tract", id: target.id });
    } else if (target.kind === "shelter" && target.id) {
      setSelected({ kind: "shelter", id: target.id });
    }
    if (typeof target.latitude === "number" && typeof target.longitude === "number") {
      setInspectedPoint({ lat: target.latitude, lng: target.longitude, label: target.label });
    }
    setFocusTarget({ ...target });
  }, [setActiveActionId, setFocusTarget]);

  const handleDecideFromMap = useCallback(
    (
      action: RecommendedAction,
      decision: ActionDecisionStatus,
      selectedOptionId?: string,
      note?: string,
      sendFollowUp = false
    ) => {
      if (externalOnDecideFromMap) {
        externalOnDecideFromMap(action, decision, selectedOptionId, note, sendFollowUp);
        return;
      }
      setExternalDecisionTrigger({
        id: Date.now(),
        action,
        decision,
        selectedOptionId,
        note,
        sendFollowUp,
      });
    },
    [externalOnDecideFromMap]
  );
  const ask = (text: string) => {
    if (onAskExternal) {
      onAskExternal(text);
    } else {
      setQuestion({text, id: Date.now(), send: true});
    }
  };
  const selectedShelter = selected?.kind === "shelter" ? data?.shelters.find(s => s.id === selected.id) : null;
  const selectedTract = selected?.kind === "tract" ? data?.tracts.find(t => t.id === selected.id) : null;
  const selectedEntity = selectedShelter || selectedTract || null;
  const activeInspectPoint = inspectedPoint ?? (selectedEntity?.position ? {
    lat: selectedEntity.position[0],
    lng: selectedEntity.position[1],
    label: selectedEntity.label,
  } : null);
  const percent = data?.shelters.length ? 100 * data.access.UNRECORDED / data.shelters.length : null;
  const tracts = data?.tracts.slice(0, view === "priority" ? 50 : 5) || [];
  const filteredShelters = (data?.shelters || []).filter(s => accessFilter === "ALL" || s.access === accessFilter);
  const detail = (point: DashboardShelter | DashboardTract) => {
    const shelter = "access" in point ? point : null;
    return <section className="planning-card selection-card" aria-label="Selected record">
      <div className="panel-heading"><h2>{point.label}</h2><button className="text-button" onClick={() => setSelected(null)}>Close ×</button></div>
      <div className="detail-grid">{shelter ? <><p><span>Address</span>{shelter.address}</p><p><span>Wheelchair record</span><b className={`record-badge ${shelter.access.toLowerCase()}`}>{shelter.access}</b></p><p><span>Generator / surge</span>{shelter.generator} / {shelter.surge}</p><p><span>Usage / recorded capacity</span>{shelter.usage} / {fmt(shelter.capacity)}</p></> : <><p><span>No-vehicle households</span>{fmt((point as DashboardTract).noVehicle)}</p><p><span>Age 65+ / disability</span>{share((point as DashboardTract).olderShare)} / {share((point as DashboardTract).disability)}</p><p><span>Hurricane expected annual population loss</span>{fmt((point as DashboardTract).hurricaneLoss)}</p><p><span>Coastal-flood expected annual population loss</span>{fmt((point as DashboardTract).coastalLoss)}</p></>}</div>
      <div className="selection-actions"><span>{shelter ? "Maps verification pending · historical record" : "Source: ACS / CDC SVI / FEMA NRI · modeled measures where applicable"}</span><button className="primary-button" onClick={() => ask(shelter ? `For pre-season planning, verify ${shelter.label} at ${shelter.address}, ${county.name} County, FL using Google Maps. Distinguish recorded data from verified evidence.` : `Explain the transport planning priorities for tract ${point.id} in ${county.name} County, FL. Use BigQuery evidence and state limitations.`)}>✧ Ask assistant</button></div>
    </section>;
  };
  return <div className="planning-workspace">
    <main className="planning-content">
      <div className="workspace-title"><div><span className="eyebrow">COUNTY READINESS WORKSPACE</span><h1>{county.name} County, Florida</h1><p>Understand the gaps. Plan the next step.</p></div><span className={`source-pill ${mode}`}>● {mode === "live" ? "BigQuery records" : "Illustrative preview"}</span></div>
      {error ? <section className="planning-card error-card" role="alert"><h2>County data unavailable</h2><p>{error}</p><button className="primary-button" onClick={() => setRetry(n => n + 1)}>Retry connection</button><button className="secondary-button" onClick={onPreview}>Explore labeled preview</button><p className="muted">Live mode never substitutes sample records. Start the local API on port 8080.</p></section> : !data ? <section className="planning-card loading-card" role="status"><span className="loading-ring" /><h2>Loading county records</h2><p>Reading shelter, tract, hazard, and county power data…</p></section> : <>
        <div className={`data-context ${data.source === "preview" ? "preview-context" : ""}`}>{data.source === "preview" ? "ILLUSTRATIVE SUBSET — not county totals." : `Queried ${new Date(data.fetchedAt).toLocaleTimeString()} · Source records are historical, not live shelter availability.`}</div>
        {data.warnings.length > 0 && <details className="coverage-notice"><summary>{data.warnings.length} data coverage {data.warnings.length === 1 ? "note" : "notes"}</summary><ul>{data.warnings.map(w => <li key={w}>{w}</li>)}</ul></details>}
        {(view === "overview" || view === "gaps") && <div className="metric-grid">
          <Metric icon="⌂" title="Registered shelters" value={fmt(data.shelters.length)} note={`${data.shelters.filter(s => s.medical === "YES").length} recorded medical-needs sites`} />
          <Metric icon="▥" title="Recorded capacity" value={fmt(data.capacity)} note={`${data.capacityMissing} missing capacity records · not occupancy`} />
          <Metric icon="♿" title="Accessibility unrecorded" value={percent === null ? "Unavailable" : `${percent.toFixed(1)}%`} note={`${data.access.UNRECORDED} of ${data.shelters.length} shelter records`} amber />
          <Metric icon="♡" title="Power-dependent beneficiaries" value={data.powerCensored ? "1–10" : fmt(data.power)} note={data.powerCensored ? "Privacy-masked · county level" : "HHS emPOWER · county level only"} />
        </div>}
        {(view === "overview" || view === "priority" || view === "shelters") && (
          <CountyMap
            data={data}
            selected={selected}
            onSelect={select}
            inspectedPoint={activeInspectPoint}
            radiusKm={radiusKm}
            onInspectPoint={inspectPoint}
            pendingActions={pendingActions}
            activeActionId={activeActionId}
            onSelectAction={setActiveActionId}
            selectedOptionsByAction={selectedOptionsByAction}
            onSelectActionOption={handleSelectActionOption}
            decisions={sharedDecisions}
            onDecideAction={handleDecideFromMap}
            focusTarget={focusTarget}
            onFocusLocation={handleFocusFromWidget}
          />
        )}
        {(selectedShelter || selectedTract) && detail((selectedShelter || selectedTract)!)}
        {(view === "overview" || view === "priority" || view === "shelters") && activeInspectPoint && (
          <AreaDetailsPanel
            lat={activeInspectPoint.lat}
            lng={activeInspectPoint.lng}
            radiusKm={radiusKm}
            label={activeInspectPoint.label}
            onRadiusChange={setRadiusKm}
            onAskAgent={ask}
            onClose={() => {
              setInspectedPoint(null);
              setSelected(null);
            }}
          />
        )}
        {(view === "overview" || view === "priority") && <div className="overview-bottom">
          <section className="planning-card priority-panel"><div className="panel-heading"><div><h2>Priority tracts</h2><p>Ranked by no-vehicle household count</p></div><span className="small-tag">ACS measure</span></div>
            <div className="planning-table-wrap"><table className="planning-table"><thead><tr><th>Tract</th><th>No-vehicle HHs</th><th>Accessible site*</th><th /></tr></thead><tbody>{tracts.map(t => <tr key={t.id} className={selected?.id === t.id ? "selected-row" : ""}><td><button className="text-button" onClick={() => select("tract", t.id)}>{t.id}</button></td><td>{fmt(t.noVehicle)}</td><td>{t.nearestAccessible === null ? "None recorded / no coordinates" : `${t.nearestAccessible.toFixed(1)} km`}</td><td><button aria-label={`View tract ${t.id}`} className="row-arrow" onClick={() => select("tract", t.id)}>›</button></td></tr>)}</tbody></table></div>
            {!tracts.length && <p className="empty-state">No tract records for this county.</p>}<p className="panel-footnote">*Nearest recorded YES, EVAC/BOTH site within this county. Straight-line distance, not travel time. No-vehicle households are not a count of people needing a ride.</p>
          </section>
          <section className="planning-card"><div className="panel-heading"><h2>Accessibility records</h2></div><div className="access-bar" aria-label={`YES ${data.access.YES}, NO ${data.access.NO}, UNRECORDED ${data.access.UNRECORDED}`}>{(["YES", "NO", "UNRECORDED"] as const).map(k => <span key={k} className={k.toLowerCase()} style={{flex: data.access[k]}} />)}</div><div className="access-counts">{(["YES", "NO", "UNRECORDED"] as const).map(k => <div key={k}><span><i className={`key-dot ${k === "UNRECORDED" ? "unknown" : k.toLowerCase()}`} />{k}</span><strong>{data.access[k]}</strong></div>)}</div><div className="amber-note">ⓘ Unrecorded does not mean inaccessible.</div><p className="panel-footnote">This measures documentation, not an accessibility assessment.</p></section>
        </div>}
        {view === "shelters" && <section className="planning-card"><div className="panel-heading"><h2>Shelter records <span className="muted">({filteredShelters.length})</span></h2><label className="filter-label">Wheelchair record <select value={accessFilter} onChange={e => setAccessFilter(e.target.value)}>{["ALL", "YES", "NO", "UNRECORDED"].map(v => <option key={v}>{v}</option>)}</select></label></div><div className="shelter-records">{filteredShelters.map(s => <button key={s.id} className={`shelter-record ${selected?.id === s.id ? "selected-row" : ""}`} onClick={() => select("shelter", s.id)}><span><strong>{s.label}</strong><small>{s.address} · {s.usage}</small></span><span className={`record-badge ${s.access.toLowerCase()}`}>{s.access}</span><span>{fmt(s.capacity)}<small>recorded capacity</small></span><span>›</span></button>)}</div>{!filteredShelters.length && <p>No shelter records match this filter.</p>}</section>}
        {view === "gaps" && <section className="planning-card"><div className="panel-heading"><h2>What to verify before the season</h2><span className="small-tag">Data-derived checks</span></div><div className="gap-checks"><article><span className="gap-number">01</span><h3>Assess accessibility</h3><p>{data.access.UNRECORDED} shelters have no recorded wheelchair answer. Contact operators to verify entrances, restrooms, and access hours.</p></article><article><span className="gap-number">02</span><h3>Review accessible transport</h3><p>Compare the listed no-vehicle household concentrations with recorded pre-landfall shelter options. Routing, vehicle supply, and pickup locations still need confirmation.</p></article><article><span className="gap-number">03</span><h3>Validate medical arrangements</h3><p>{data.shelters.filter(s => s.medical === "YES").length} registered medical-needs shelters. County-level emPOWER cannot identify which tract or person needs medical transport.</p></article></div><button className="primary-button" onClick={() => ask(`Build a pre-season readiness brief for ${county.name} County, FL. Verify priority shelters and state data limitations.`)}>Ask agent for a grounded readiness brief</button></section>}
        {view === "sources" && <Sources />}
      </>}
      <footer className="planning-footer">Preparedness planning · historical records · unknown means unrecorded</footer>
    </main>
    {!hideAssistant && (
      <aside className="planning-assistant" aria-label="Planning assistant">
        <ChatPanel
          key={county.fips}
          stateCode="FL"
          county={county.name}
          compact
          suggestedQuestion={question}
          onFocusLocation={handleFocusFromWidget}
          dashboardData={data}
          sharedDecisions={sharedDecisions}
          onSharedDecisionsChange={setSharedDecisions}
          selectedOptionsByAction={selectedOptionsByAction}
          onSelectActionOption={handleSelectActionOption}
          activeActionId={activeActionId}
          onActiveActionChange={setActiveActionId}
          onActionsSync={setInternalActions}
          externalDecisionTrigger={externalDecisionTrigger}
        />
        {mode === "preview" && <p className="panel-footnote">Assistant requests still use the live service. Preview rows are not sent as evidence.</p>}
      </aside>
    )}
  </div>;
}
function Metric({icon, title, value, note, amber = false}: {icon: string; title: string; value: string; note: string; amber?: boolean}) {
  return <section className={`planning-card metric ${amber ? "metric-amber" : ""}`}><span className="metric-icon" aria-hidden="true">{icon}</span><div><h2>{title}</h2><strong>{value}</strong><p>{note}</p></div></section>;
}
function Sources() {
  return <section className="planning-card"><div className="panel-heading"><div><h2>Data coverage & missing inputs</h2><p>The five base tables describe people, places, and historical exposure.</p></div></div><div className="source-cards">{[
    ["shelters", "FEMA shelter registry", "Coordinates, capacity, usage, and nullable access / generator / surge flags.", "Missing: current occupancy, operating status, verified entrances, staff, resources, assessment timestamps."],
    ["vulnerability_tracts", "ACS · CDC SVI · CDC PLACES", "Tract centroids, household counts, age and modeled disability measures.", "Missing: tract polygon geometry and pickup locations. No individual-level needs. FL transport-barrier prevalence is unreported."],
    ["hazard_tracts", "FEMA National Risk Index", "Join by geo_id for historical hazard exposure and expected annual loss.", "Missing: live forecasts, storm tracks and evacuation-order zones. Some tract vintages do not match."],
    ["power_dependent_counties", "HHS emPOWER", "County-level Medicare beneficiaries using power-dependent equipment.", "Missing: tract-level locations, individual needs, backup battery duration. Suppressed values represent 1–10."],
    ["care_facilities", "CMS nursing home registry", "Facility coordinates and certified bed counts. Inspect it in Data Explorer.", "Missing: clean county join in the base API, current beds, transfer agreements, assisted-living coverage. No county total inferred from city names."],
  ].map(([table, title, has, missing]) => <article key={table}><code>{table}</code><h3>{title}</h3><p>{has}</p><p className="source-missing">{missing}</p></article>)}</div><div className="amber-note">Not supplied by these tables: buses, drivers, staging-site inventory, travel times, tract boundaries, live shelter occupancy, or a verified count of people requiring evacuation.</div></section>;
}
