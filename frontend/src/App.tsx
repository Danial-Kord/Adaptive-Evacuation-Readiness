import React, { useEffect, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { CountyMap } from "./components/CountyMap";
import { CountySelector } from "./components/CountySelector";
import { DataManagementTab } from "./components/DataManagementTab";
import { PreSeasonGaps } from "./components/ReadinessBrief/PreSeasonGaps";
import { ShelterVerification } from "./components/ReadinessBrief/ShelterVerification";
import { UnrecordedFindings } from "./components/ReadinessBrief/UnrecordedFindings";
import { WhoCannotLeave } from "./components/ReadinessBrief/WhoCannotLeave";
import { fetchReadinessBrief } from "./services/agentApi";
import { ReadinessBriefData } from "./types/brief";

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<"brief" | "data">("brief");
  const [stateCode, setStateCode] = useState("FL");
  const [county, setCounty] = useState("Miami-Dade");
  const [brief, setBrief] = useState<ReadinessBriefData | null>(null);

  useEffect(() => {
    fetchReadinessBrief(stateCode, county).then(setBrief);
  }, [stateCode, county]);

  return (
    <div className="app-shell">
      <header className="top-nav">
        <div>
          <h1>Adaptive Evacuation Readiness & Vulnerable Community Planning</h1>
          <p className="subtitle">
            Pre-Season Emergency Manager Readiness Brief — Combining Federal Vulnerability Data with Live{" "}
            <span translate="no">Google Maps</span> Grounding
          </p>
        </div>

        <div className="nav-right-controls">
          <div className="main-tab-switcher">
            <button
              type="button"
              className={`main-tab-btn ${activeTab === "brief" ? "active" : ""}`}
              onClick={() => setActiveTab("brief")}
            >
              📋 Readiness Brief
            </button>
            <button
              type="button"
              className={`main-tab-btn ${activeTab === "data" ? "active" : ""}`}
              onClick={() => setActiveTab("data")}
            >
              🗄️ Data Management (BigQuery)
            </button>
          </div>

          {activeTab === "brief" && (
            <CountySelector
              stateCode={stateCode}
              county={county}
              onChangeState={setStateCode}
              onChangeCounty={setCounty}
            />
          )}
        </div>
      </header>

      {activeTab === "brief" ? (
        <main className="workspace-grid">
          <div className="brief-column">
            {brief && (
              <>
                <CountyMap
                  tracts={brief.who_cannot_leave}
                  shelters={brief.candidate_shelters}
                />
                <WhoCannotLeave
                  tracts={brief.who_cannot_leave}
                  powerDependentCount={brief.summary_metrics.power_dependent_dme}
                  powerCensored={brief.summary_metrics.power_dependent_is_censored}
                />
                <ShelterVerification shelters={brief.candidate_shelters} />
                <PreSeasonGaps gaps={brief.pre_season_gaps} />
                <UnrecordedFindings
                  items={brief.unrecorded_and_limitations}
                  wheelchairYes={brief.summary_metrics.wheelchair_yes}
                  wheelchairNo={brief.summary_metrics.wheelchair_no}
                  wheelchairUnrecorded={brief.summary_metrics.wheelchair_unrecorded}
                  pctUnrecorded={brief.summary_metrics.pct_wheelchair_unrecorded}
                />
              </>
            )}
          </div>

          <ChatPanel stateCode={stateCode} county={county} />
        </main>
      ) : (
        <main className="admin-workspace">
          <DataManagementTab />
        </main>
      )}
    </div>
  );
};

export default App;
