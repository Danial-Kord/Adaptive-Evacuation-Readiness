import React from "react";

interface UnrecordedFindingsProps {
  items: string[];
  wheelchairYes: number;
  wheelchairNo: number;
  wheelchairUnrecorded: number;
  pctUnrecorded: number;
}

export const UnrecordedFindings: React.FC<UnrecordedFindingsProps> = ({
  items,
  wheelchairYes,
  wheelchairNo,
  wheelchairUnrecorded,
  pctUnrecorded,
}) => {
  return (
    <section className="card unrecorded-card">
      <div className="card-header">
        <h3>4. What We Could Not Tell You (Paperwork vs. Reality Audit)</h3>
        <span className="source-tag">Required Epistemic Honesty</span>
      </div>

      <div className="tri-stat-row">
        <div className="stat-box yes">
          <span className="stat-num">{wheelchairYes}</span>
          <span className="stat-label">Recorded YES</span>
        </div>
        <div className="stat-box no">
          <span className="stat-num">{wheelchairNo}</span>
          <span className="stat-label">Recorded NO</span>
        </div>
        <div className="stat-box unrecorded">
          <span className="stat-num">
            {wheelchairUnrecorded} ({pctUnrecorded}%)
          </span>
          <span className="stat-label">UNRECORDED (Blank != No)</span>
        </div>
      </div>

      <ul className="limitations-list">
        {items.map((item, idx) => (
          <li key={idx}>{item}</li>
        ))}
      </ul>
    </section>
  );
};
