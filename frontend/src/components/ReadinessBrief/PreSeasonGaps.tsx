import React from "react";
import { PreSeasonGap } from "../../types/brief";

interface PreSeasonGapsProps {
  gaps: PreSeasonGap[];
}

export const PreSeasonGaps: React.FC<PreSeasonGapsProps> = ({ gaps }) => {
  return (
    <section className="card">
      <div className="card-header">
        <h3>3. What to Fix Before September (Actionable Recommendations)</h3>
        <span className="source-tag">Agent Synthesis</span>
      </div>
      <div className="gaps-grid">
        {gaps.map((g) => (
          <div key={g.id} className={`gap-card severity-${g.severity.toLowerCase()}`}>
            <div className="gap-meta">
              <span className="gap-category">{g.category}</span>
              <span className="gap-severity">{g.severity} PRIORITY</span>
            </div>
            <h4>{g.title}</h4>
            <p>{g.recommendation}</p>
          </div>
        ))}
      </div>
    </section>
  );
};
