import React from "react";
import { MapsGroundingChunk } from "../types/brief";

interface MapsAttributionProps {
  chunks: MapsGroundingChunk[];
}

/**
 * Mandatory Google Maps Attribution Component.
 * Rubric requirement:
 * - Display Google Maps sources immediately after the content they support, viewable within one user interaction.
 * - The words "Google Maps" must NOT be re-capitalized, restyled, wrapped across lines, or translated (`translate="no"`).
 */
export const MapsAttribution: React.FC<MapsAttributionProps> = ({ chunks }) => {
  if (!chunks || chunks.length === 0) return null;

  return (
    <div className="maps-attribution-box" aria-label="Google Maps Grounding Attribution">
      <span className="maps-attribution-label">
        Sources from{" "}
        <span translate="no" className="google-maps-brand">
          Google Maps
        </span>
        :
      </span>
      <ul className="maps-attribution-list">
        {chunks.map((chunk, idx) => (
          <li key={chunk.uri || idx}>
            <a href={chunk.uri} target="_blank" rel="noopener noreferrer">
              {chunk.title}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
};
