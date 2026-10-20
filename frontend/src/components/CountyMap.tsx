import React from "react";
import { ShelterCandidate, VulnerableTract } from "../types/brief";

interface CountyMapProps {
  tracts: VulnerableTract[];
  shelters: ShelterCandidate[];
}

export const CountyMap: React.FC<CountyMapProps> = ({ tracts, shelters }) => {
  return (
    <section className="card map-placeholder-card">
      <div className="card-header">
        <h3>Spatial Overview: Priority Tracts & Shelter Accessibility Coverage</h3>
        <span className="badge-subtle">
           Frontend Lane: Plug in Leaflet / Mapbox / Google Maps JS here
        </span>
      </div>
      <div className="map-legend">
        <span className="legend-item">
          <span className="dot yes" /> Wheelchair Recorded YES
        </span>
        <span className="legend-item">
          <span className="dot unrecorded" /> Wheelchair UNRECORDED (NULL != No)
        </span>
        <span className="legend-item">
          <span className="dot no" /> Wheelchair Recorded NO
        </span>
      </div>
      <div className="coord-preview-grid">
        <div>
          <strong>Priority Tracts Plotted:</strong> {tracts.length}
        </div>
        <div>
          <strong>Candidate Shelters Plotted:</strong> {shelters.length}
        </div>
      </div>
    </section>
  );
};
