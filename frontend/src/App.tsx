import React, { useState } from "react";
import { DataManagementTab } from "./components/DataManagementTab";
import { PlanningDashboard, PlanningView } from "./components/PlanningDashboard";
import { COUNTIES } from "./services/dashboardApi";

const NAV: {id: PlanningView | "data"; label: string; icon: string}[] = [
  {id: "overview", label: "Overview", icon: "▦"}, {id: "priority", label: "Priority tracts", icon: "▥"},
  {id: "shelters", label: "Shelters", icon: "⌂"}, {id: "gaps", label: "Planning gaps", icon: "△"},
  {id: "sources", label: "Sources & gaps", icon: "▤"}, {id: "data", label: "Data Explorer", icon: "▧"},
];
export const App: React.FC = () => {
  const [view, setView] = useState<PlanningView | "data">("overview");
  const [countyFips, setCountyFips] = useState("12071");
  const [mode, setMode] = useState<"live" | "preview">("live");
  const [refresh, setRefresh] = useState(0);
  const county = COUNTIES.find(c => c.fips === countyFips)!;
  return <div className="readiness-app">
    <header className="readiness-header"><a className="readiness-brand" href="#" onClick={e => {e.preventDefault(); setView("overview");}}><span className="brand-symbol" aria-hidden="true">◈</span><span><strong>Evacuation Readiness</strong><small>Pre-season planning workspace</small></span></a><div className="header-selectors"><label><span className="sr-only">State</span><select aria-label="State" value="FL" disabled><option value="FL">Florida</option></select></label><label><span className="sr-only">County</span><select aria-label="County" value={countyFips} onChange={e => setCountyFips(e.target.value)}>{COUNTIES.map(c => <option key={c.fips} value={c.fips}>{c.name}</option>)}</select></label><button className="header-refresh" onClick={() => setRefresh(n => n + 1)}>↻ <span>Refresh data</span></button></div><div className="header-context"><label>Data mode <select aria-label="Data mode" value={mode} onChange={e => setMode(e.target.value as "live" | "preview")}><option value="live">Live BigQuery</option><option value="preview">Preview subset</option></select></label><small>Historical records · not operational status</small></div></header>
    <div className="readiness-body"><nav className="readiness-sidebar" aria-label="Workspace navigation"><span className="sidebar-heading">WORKSPACE</span>{NAV.map(item => <button key={item.id} onClick={() => setView(item.id)} className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}<div className="sidebar-note"><span>◎</span><strong>Plan before the season</strong><p>Evidence, gaps, and the next question to ask.</p></div></nav><div className="readiness-main">{view === "data" ? <main className="explorer-page"><div className="workspace-title"><div><span className="eyebrow">SOURCE TABLES</span><h1>BigQuery Data Explorer</h1><p>Explorer has its own connection status and filters; overview county and data-mode selections do not apply here.</p></div></div><DataManagementTab /></main> : <PlanningDashboard view={view} county={county} mode={mode} refresh={refresh} onPreview={() => setMode("preview")} />}</div></div>
  </div>;
};
export default App;
