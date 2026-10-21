import React, { useCallback, useState } from "react";
import { ChatPanel, ExternalDecisionTrigger } from "./components/ChatPanel";
import { FocusLocationTarget } from "./components/AgentSchemaCards";
import { DataManagementTab } from "./components/DataManagementTab";
import { PlanningDashboard, PlanningView } from "./components/PlanningDashboard";
import { StoryPage } from "./components/StoryPage";
import { HurricaneGlyph, Theme } from "./components/HeroArt";
import "./themes.css";
import { COUNTIES } from "./services/dashboardApi";
import { buildStarterAgentBriefing } from "./services/agentApi";
import { ActionDecisionRecord, ActionDecisionStatus, RecommendedAction } from "./types/brief";
import "./story.css";

// Analyst views (the original workspace) stay available behind "For analysts".
const ANALYST_NAV: {id: PlanningView | "data"; label: string}[] = [
  {id: "overview", label: "Overview"}, {id: "priority", label: "Priority tracts"},
  {id: "shelters", label: "Shelter records"}, {id: "gaps", label: "Planning gaps"},
  {id: "sources", label: "Sources & coverage"}, {id: "data", label: "Data explorer"},
];

const THEMES: Theme[] = ["base", "watch", "eye", "chart"];
const initialTheme = (): Theme => {
  const t = new URLSearchParams(window.location.search).get("theme") as Theme | null;
  return t && THEMES.includes(t) ? t : "eye";
};

export const App: React.FC = () => {
  const [theme] = useState<Theme>(initialTheme);
  const [page, setPage] = useState<"plan" | "analysts">("plan");
  const [view, setView] = useState<PlanningView | "data">("overview");
  const [countyFips, setCountyFips] = useState("12071");
  const [chatOpen, setChatOpen] = useState(() => new URLSearchParams(window.location.search).get("assistant") === "open");
  const [question, setQuestion] = useState<{text: string; id: number; send?: boolean} | null>(null);
  const county = COUNTIES.find(c => c.fips === countyFips)!;
  const ask = useCallback((text: string) => { setQuestion({text, id: Date.now(), send: true}); setChatOpen(true); }, []);

  // Shared state between the global ChatPanel drawer and PlanningDashboard's CountyMap
  const [sharedActions, setSharedActions] = useState<RecommendedAction[]>(() => buildStarterAgentBriefing(county.name).actions);
  const [sharedDecisions, setSharedDecisions] = useState<Record<string, ActionDecisionRecord>>({});
  const [selectedOptionsByAction, setSelectedOptionsByAction] = useState<Record<string, string>>({});
  const [activeActionId, setActiveActionId] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusLocationTarget | null>(null);
  const [externalDecisionTrigger, setExternalDecisionTrigger] = useState<ExternalDecisionTrigger | null>(null);

  const selectUiCountyByNameOrFips = useCallback((countyNameOrFips: string) => {
    const cleaned = countyNameOrFips.replace(/\s+County$/i, "").trim().toLowerCase();
    if (!cleaned) return;
    const match = COUNTIES.find(
      c => c.fips === cleaned || c.name.toLowerCase() === cleaned
    );
    if (match) {
      setCountyFips(prev => (prev === match.fips ? prev : match.fips));
    }
  }, []);

  const handleSelectActionOption = useCallback((actionId: string, optionId: string) => {
    setSelectedOptionsByAction(prev => ({ ...prev, [actionId]: optionId }));
    setActiveActionId(actionId);
  }, []);

  const handleFocusLocation = useCallback((target: FocusLocationTarget) => {
    if (target.county) {
      selectUiCountyByNameOrFips(target.county);
    }
    if (target.actionId) {
      setActiveActionId(target.actionId);
    }
    setFocusTarget({ ...target });
    setPage("analysts");
    setView(prev => (prev === "overview" || prev === "priority" || prev === "shelters" ? prev : "overview"));
  }, [selectUiCountyByNameOrFips]);

  const handleDecideFromMap = useCallback(
    (
      action: RecommendedAction,
      decision: ActionDecisionStatus,
      selectedOptionId?: string,
      note?: string,
      sendFollowUp = false
    ) => {
      setExternalDecisionTrigger({
        id: Date.now(),
        action,
        decision,
        selectedOptionId,
        note,
        sendFollowUp,
      });
    },
    []
  );

  return <div className={`app-shell theme-${theme}`}>
    <header className="app-header">
      <a className="app-brand" href="#" onClick={e => { e.preventDefault(); setPage("plan"); }}>
        <span className="app-logo" aria-hidden="true">{theme === "base" ? "◈" : <HurricaneGlyph size={30} />}</span>
        <span><strong>Hurricane Readiness</strong><small>Pre-season planning for county emergency managers</small></span>
      </a>
      <label className="app-county">County
        <select aria-label="County" value={countyFips} onChange={e => setCountyFips(e.target.value)}>
          {COUNTIES.map(c => <option key={c.fips} value={c.fips}>{c.name}, FL</option>)}
        </select>
      </label>
      <nav className="app-tabs" aria-label="Pages">
        <button className={page === "plan" ? "active" : ""} onClick={() => setPage("plan")}>Readiness plan</button>
        <button className={page === "analysts" ? "active" : ""} onClick={() => setPage("analysts")}>For analysts</button>
      </nav>
      <button className="app-ask" onClick={() => setChatOpen(o => !o)}>✦ {chatOpen ? "Close assistant" : "Ask the assistant"}</button>
    </header>

    {page === "plan" ? <StoryPage county={county} onAsk={ask} theme={theme} /> :
      <div className="analyst-view">
        <nav className="analyst-nav" aria-label="Analyst views">
          {ANALYST_NAV.map(item => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>{item.label}</button>)}
        </nav>
        {view === "data" ? <main className="explorer-page"><DataManagementTab /></main> :
          <PlanningDashboard
            view={view}
            county={county}
            mode="live"
            refresh={0}
            onPreview={() => {}}
            hideAssistant
            sharedActions={sharedActions}
            sharedDecisions={sharedDecisions}
            onSharedDecisionsChange={setSharedDecisions}
            selectedOptionsByAction={selectedOptionsByAction}
            onSelectActionOption={handleSelectActionOption}
            activeActionId={activeActionId}
            onActiveActionChange={setActiveActionId}
            focusTarget={focusTarget}
            onFocusTargetChange={setFocusTarget}
            onDecideFromMap={handleDecideFromMap}
            onAskExternal={ask}
          />}
      </div>}

    <aside className={`chat-drawer ${chatOpen ? "open" : ""}`} aria-label="Planning assistant" aria-hidden={!chatOpen}>
      <ChatPanel
        stateCode="FL"
        county={county.name}
        compact
        suggestedQuestion={question}
        onFocusLocation={handleFocusLocation}
        onSelectUiCounty={selectUiCountyByNameOrFips}
        sharedDecisions={sharedDecisions}
        onSharedDecisionsChange={setSharedDecisions}
        selectedOptionsByAction={selectedOptionsByAction}
        onSelectActionOption={handleSelectActionOption}
        activeActionId={activeActionId}
        onActiveActionChange={setActiveActionId}
        onActionsSync={setSharedActions}
        externalDecisionTrigger={externalDecisionTrigger}
      />
    </aside>
    {!chatOpen && <button className="chat-fab" onClick={() => setChatOpen(true)}>✦ Ask the assistant</button>}
  </div>;
};
export default App;
