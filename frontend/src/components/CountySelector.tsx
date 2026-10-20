import React from "react";

interface CountySelectorProps {
  stateCode: string;
  county: string;
  onChangeState: (s: string) => void;
  onChangeCounty: (c: string) => void;
}

const COUNTIES_BY_STATE: Record<string, string[]> = {
  FL: ["Miami-Dade", "Lee", "Pinellas", "Hillsborough", "Broward", "Duval"],
  TX: ["Harris", "Galveston", "Nueces", "Jefferson"],
  LA: ["Orleans", "Jefferson", "East Baton Rouge"],
  GA: ["Chatham", "Glynn", "Fulton"],
  NC: ["New Hanover", "Wake", "Mecklenburg"],
  SC: ["Charleston", "Horry"],
  NY: ["Kings", "Queens", "New York"],
  CA: ["Los Angeles", "San Diego", "Alameda"],
};

export const CountySelector: React.FC<CountySelectorProps> = ({
  stateCode,
  county,
  onChangeState,
  onChangeCounty,
}) => {
  const counties = COUNTIES_BY_STATE[stateCode] || ["Miami-Dade"];

  return (
    <div className="selector-bar">
      <div className="selector-group">
        <label htmlFor="state-select">State</label>
        <select
          id="state-select"
          value={stateCode}
          onChange={(e) => {
            const nextState = e.target.value;
            onChangeState(nextState);
            const defaultCounty = (COUNTIES_BY_STATE[nextState] || [""])[0];
            if (defaultCounty) onChangeCounty(defaultCounty);
          }}
        >
          {Object.keys(COUNTIES_BY_STATE).map((st) => (
            <option key={st} value={st}>
              {st}
            </option>
          ))}
        </select>
      </div>

      <div className="selector-group">
        <label htmlFor="county-select">County / Parish</label>
        <select
          id="county-select"
          value={county}
          onChange={(e) => onChangeCounty(e.target.value)}
        >
          {counties.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="season-badge">
        Planning Window: <strong>August Pre-Season Readiness</strong>
      </div>
    </div>
  );
};
