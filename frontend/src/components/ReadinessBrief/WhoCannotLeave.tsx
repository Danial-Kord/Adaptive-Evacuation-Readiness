import React from "react";
import { VulnerableTract } from "../../types/brief";

interface WhoCannotLeaveProps {
  tracts: VulnerableTract[];
  powerDependentCount: number;
  powerCensored: boolean;
}

export const WhoCannotLeave: React.FC<WhoCannotLeaveProps> = ({
  tracts,
  powerDependentCount,
  powerCensored,
}) => {
  return (
    <section className="card">
      <div className="card-header">
        <h3>1. Who Cannot Self-Evacuate</h3>
        <span className="source-tag">Source: ACS + CDC SVI + CDC PLACES + HHS emPOWER</span>
      </div>

      <div className="empower-banner">
        <strong>County-Level Electricity-Dependent Residents (HHS emPOWER):</strong>{" "}
        {powerDependentCount.toLocaleString()} Medicare beneficiaries relying on power-dependent medical equipment
        {powerCensored && " (Censored value '11' indicates 1–10 residents)"}.{" "}
        <em>Note: Published at county grain only—never assigned to individual blocks.</em>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Census Tract</th>
            <th>No-Vehicle HHs</th>
            <th>65+ Share</th>
            <th>Disability</th>
            <th>Nearest Shelter (Any)</th>
            <th>Nearest Recorded Wheelchair Shelter</th>
            <th>Nearby Unrecorded Shelters (&lt;10km)</th>
          </tr>
        </thead>
        <tbody>
          {tracts.map((t) => (
            <tr key={t.geo_id}>
              <td>
                <strong>{t.geo_id}</strong>
                <div className="subtext">{t.priority_reason}</div>
              </td>
              <td>
                {t.households_no_vehicle.toLocaleString()} ({t.pct_no_vehicle}%)
              </td>
              <td>{t.pct_age_65_plus}%</td>
              <td>{t.pct_disability}%</td>
              <td>{t.nearest_any_shelter_km} km</td>
              <td className="warn-cell">
                {t.nearest_recorded_wheelchair_shelter_km !== null
                  ? `${t.nearest_recorded_wheelchair_shelter_km} km`
                  : "None recorded"}
              </td>
              <td>{t.shelters_within_reach_unrecorded_access} shelters</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};
