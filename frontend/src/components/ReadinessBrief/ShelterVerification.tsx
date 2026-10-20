import React from "react";
import { ShelterCandidate } from "../../types/brief";
import { MapsAttribution } from "../MapsAttribution";

interface ShelterVerificationProps {
  shelters: ShelterCandidate[];
}

export const ShelterVerification: React.FC<ShelterVerificationProps> = ({ shelters }) => {
  return (
    <section className="card">
      <div className="card-header">
        <h3>2. Where They Would Go — Historical Registry vs. Live Verification</h3>
        <span className="source-tag">FEMA ESF#6 Registry + Live Grounding</span>
      </div>

      <div className="shelter-list">
        {shelters.map((s) => (
          <div key={s.shelter_id} className="shelter-item">
            <div className="shelter-top">
              <div>
                <h4>
                  {s.shelter_name}{" "}
                  <span className="usage-pill">{s.usage || "UNSPECIFIED"}</span>
                  {s.is_medical && <span className="medical-pill">MEDICAL NEEDS</span>}
                </h4>
                <p className="shelter-address">
                  {s.address_1}, {s.city}, {s.county_name}
                </p>
              </div>
              <div className="capacity-box">
                <div>Evac Capacity: <strong>{s.evacuation_capacity?.toLocaleString() ?? "N/A"}</strong></div>
                <div>Post-Impact: <strong>{s.post_impact_capacity?.toLocaleString() ?? "N/A"}</strong></div>
              </div>
            </div>

            <div className="flag-row">
              <span className={`status-pill status-${s.wheelchair_status.toLowerCase()}`}>
                FEMA Wheelchair Record: {s.wheelchair_status}
              </span>
              <span className={`status-pill status-${s.generator_status.toLowerCase()}`}>
                Generator Record: {s.generator_status}
              </span>
              <span className={`status-pill ${s.in_surge_slosh_area ? "status-no" : "status-yes"}`}>
                Surge Zone: {s.in_surge_slosh_area ? "IN SURGE ZONE" : "Outside Surge Zone"}
              </span>
            </div>

            <div className="live-verification-box">
              <div className="verification-summary">
                <strong>Live Verification (Runtime Check):</strong> {s.maps_live_verification.summary}
                {s.maps_live_verification.drive_time_note && (
                  <div className="drive-time">
                    Routing Estimate: {s.maps_live_verification.drive_time_note}
                  </div>
                )}
              </div>
              <MapsAttribution chunks={s.maps_live_verification.grounding_chunks} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};
