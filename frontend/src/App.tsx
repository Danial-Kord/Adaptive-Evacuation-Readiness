import React from "react";
import { DataManagementTab } from "./components/DataManagementTab";

export const App: React.FC = () => {
  return (
    <div className="app-shell">
      <header className="top-nav">
        <div>
          <h1>Adaptive Evacuation Readiness — BigQuery Data Dashboard</h1>
          <p className="subtitle">
            Admin Data Management & Table Explorer for <code>evacuation_readiness</code>
          </p>
        </div>
      </header>

      <main className="admin-workspace">
        <DataManagementTab />
      </main>
    </div>
  );
};

export default App;
