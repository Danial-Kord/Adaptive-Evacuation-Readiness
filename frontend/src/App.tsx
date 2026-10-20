import React, { useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { DataManagementTab } from "./components/DataManagementTab";

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<"data" | "chat">("data");

  return (
    <div className="app-shell">
      <header className="top-nav">
        <div>
          <h1>Adaptive Evacuation Readiness — Data & ADK Agent Dashboard</h1>
          <p className="subtitle">
            Live BigQuery Table Explorer (<code>evacuation_readiness</code>) & Deployed Cloud Run{" "}
            <code>evac_agent</code> Chat
          </p>
        </div>

        <div className="nav-right-controls">
          <div className="main-tab-switcher">
            <button
              type="button"
              className={`main-tab-btn ${activeTab === "data" ? "active" : ""}`}
              onClick={() => setActiveTab("data")}
            >
              🗄️ Data Management (BigQuery)
            </button>
            <button
              type="button"
              className={`main-tab-btn ${activeTab === "chat" ? "active" : ""}`}
              onClick={() => setActiveTab("chat")}
            >
              💬 Agent Chat (Cloud Run)
            </button>
          </div>
        </div>
      </header>

      <main className="admin-workspace">
        {activeTab === "data" ? <DataManagementTab /> : <ChatPanel />}
      </main>
    </div>
  );
};

export default App;
