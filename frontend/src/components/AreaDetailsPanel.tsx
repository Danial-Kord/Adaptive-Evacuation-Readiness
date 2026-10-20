import React, { useEffect, useState } from "react";
import { fetchAreaInspection } from "../services/agentApi";
import { AreaInspectResponse } from "../types/brief";
import { MapsAttribution } from "./MapsAttribution";

export interface AreaDetailsPanelProps {
  lat: number;
  lng: number;
  radiusKm: number;
  label?: string;
  onRadiusChange?: (radiusKm: number) => void;
  onAskAgent?: (prompt: string) => void;
  onClose?: () => void;
}

export const AreaDetailsPanel: React.FC<AreaDetailsPanelProps> = ({
  lat,
  lng,
  radiusKm,
  label,
  onRadiusChange,
  onAskAgent,
  onClose,
}) => {
  const [bqData, setBqData] = useState<AreaInspectResponse | null>(null);
  const [mapsLive, setMapsLive] = useState<AreaInspectResponse["google_maps_live"] | null>(null);
  const [loadingBq, setLoadingBq] = useState<boolean>(false);
  const [loadingMaps, setLoadingMaps] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingBq(true);
    setLoadingMaps(true);
    setError(null);
    setMapsLive(null);

    // 1. Fast BigQuery spatial lookup (< 1.5s)
    fetchAreaInspection({ lat, lng, radiusKm, includeMaps: false })
      .then((res) => {
        if (!cancelled) {
          setBqData(res);
          setLoadingBq(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoadingBq(false);
        }
      });

    // 2. Parallel live Vertex AI Google Maps Grounding (Places + Routing)
    fetchAreaInspection({ lat, lng, radiusKm, includeMaps: true })
      .then((res) => {
        if (!cancelled) {
          setBqData(res);
          setMapsLive(res.google_maps_live);
          setLoadingMaps(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setMapsLive({
            summary: "",
            route_to_nearest_shelter: null,
            grounding_chunks: [],
            error: err instanceof Error ? err.message : String(err),
          });
          setLoadingMaps(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [lat, lng, radiusKm]);

  const tract = bqData?.nearest_tract;
  const power = bqData?.county_power_dependent;
  const shelters = bqData?.nearby_shelters || [];
  const careFacilities = bqData?.nearby_care_facilities || [];
  const route = mapsLive?.route_to_nearest_shelter;

  return (
    <div className="area-details-panel">
      {/* Header Card: Clicked Coordinates & Quick Action */}
      <div className="card area-header-card">
        <div className="area-header-top">
          <div>
            <div className="admin-title-row">
              <h3>📍 Selected Geolocation Details</h3>
              <span className="connection-badge live">
                ({lat.toFixed(4)}, {lng.toFixed(4)}) • {radiusKm} km radius
              </span>
            </div>
            {label && <p className="admin-subtitle">Selected Point: <strong>{label}</strong></p>}
          </div>

          <div className="inspector-filter-controls">
            {onRadiusChange && (
              <label className="inspector-select-label">
                Radius:
                <select
                  value={radiusKm}
                  onChange={(e) => onRadiusChange(Number(e.target.value))}
                  className="inspector-select"
                >
                  <option value={5}>5 km</option>
                  <option value={10}>10 km</option>
                  <option value={15}>15 km</option>
                  <option value={25}>25 km</option>
                </select>
              </label>
            )}

            {onAskAgent && tract && (
              <button
                type="button"
                className="ask-agent-area-btn"
                onClick={() =>
                  onAskAgent(
                    `Where would I send the households without a car in tract ${tract.geo_id} near (${lat.toFixed(
                      4
                    )}, ${lng.toFixed(4)}), and how long is the drive?`
                  )
                }
              >
                ✧ Ask assistant about tract {tract.geo_id}
              </button>
            )}

            {onClose && (
              <button type="button" className="text-button" onClick={onClose}>
                Close ×
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="admin-setup-banner">
            <strong>Area Lookup Error:</strong> {error}
          </div>
        )}
      </div>

      {/* 1. Live Google Maps Grounding (Places + Routing via Vertex AI) */}
      <div className="card area-maps-live-card">
        <div className="card-header">
          <h3>
            🌐 Live <span translate="no">Google Maps</span> Grounding & Route Check
          </h3>
          <span className="source-tag">Vertex AI Grounding with Google Maps (Places + Routing)</span>
        </div>

        {loadingMaps ? (
          <div className="maps-loading-box">
            <div className="spinner-dot" />
            <div>
              <strong>Querying live <span translate="no">Google Maps</span> Places & Routing...</strong>
              <div className="subtext">
                Identifying neighborhood, verifying nearest FEMA shelter operational/ADA status, and computing live driving route from ({lat.toFixed(4)}, {lng.toFixed(4)}).
              </div>
            </div>
          </div>
        ) : mapsLive?.error ? (
          <div className="admin-setup-banner">
            Could not fetch live Google Maps Grounding: {mapsLive.error}
          </div>
        ) : (
          <div className="maps-live-content">
            {route && (
              <div className="route-highlight-banner">
                <span>
                  🚗 <strong>Live Drive to Nearest Shelter ({shelters[0]?.shelter_name || "Nearest Shelter"}):</strong>{" "}
                  <strong>{route.drive_minutes} min</strong> ({route.drive_miles} mi / {route.drive_km} km)
                </span>
                <span className="route-source-pill">Live Google Maps Route</span>
              </div>
            )}

            {mapsLive?.summary && (
              <div className="maps-summary-text">
                {mapsLive.summary.split(/\r?\n/).map((line, idx) =>
                  line.trim() ? (
                    <p key={idx} style={{ margin: "0.35rem 0" }}>
                      {line}
                    </p>
                  ) : null
                )}
              </div>
            )}

            {mapsLive?.grounding_chunks && mapsLive.grounding_chunks.length > 0 && (
              <MapsAttribution chunks={mapsLive.grounding_chunks} />
            )}
          </div>
        )}
      </div>

      {/* 2. Nearest Census Tract Vulnerability & Hazard Profile */}
      <div className="card">
        <div className="card-header">
          <h3>🏘️ Nearest Census Tract Vulnerability & Hazard Profile</h3>
          <span className="source-tag">BigQuery: vulnerability_tracts + hazard_tracts</span>
        </div>

        {loadingBq && !tract ? (
          <div className="admin-empty-state">Running BigQuery spatial lookup...</div>
        ) : tract ? (
          <>
            <div className="tract-summary-banner">
              <div>
                <strong>Tract GEOID:</strong> <code>{tract.geo_id}</code> ({tract.distance_km} km from clicked point)
              </div>
              <div>
                <strong>Total Population:</strong> {(tract.total_pop ?? 0).toLocaleString()} •{" "}
                <strong>Households:</strong> {(tract.households ?? 0).toLocaleString()}
              </div>
            </div>

            <div className="area-metrics-grid">
              <div className="metric-tile warn">
                <span className="metric-val">
                  {(tract.households_no_vehicle ?? 0).toLocaleString()} ({tract.pct_no_vehicle ?? 0}%)
                </span>
                <span className="metric-lbl">No-Vehicle Households (ACS)</span>
              </div>
              <div className="metric-tile">
                <span className="metric-val">
                  {(tract.pop_65_plus ?? 0).toLocaleString()} ({tract.pct_age_65_plus ?? 0}%)
                </span>
                <span className="metric-lbl">Residents Age 65+ (ACS)</span>
              </div>
              <div className="metric-tile">
                <span className="metric-val">{tract.pct_disability ?? "N/A"}%</span>
                <span className="metric-lbl">Overall Disability (CDC SVI)</span>
              </div>
              <div className="metric-tile">
                <span className="metric-val">{tract.pct_mobility ?? "N/A"}%</span>
                <span className="metric-lbl">Mobility Disability (CDC PLACES)</span>
              </div>
              <div className="metric-tile">
                <span className="metric-val">
                  {(tract.mobile_homes ?? 0).toLocaleString()} ({tract.pct_mobile_homes ?? 0}%)
                </span>
                <span className="metric-lbl">Mobile Homes (Wind Risk)</span>
              </div>
              <div className="metric-tile">
                <span className="metric-val">
                  {(tract.cfld_expp ?? 0).toLocaleString()} pop
                </span>
                <span className="metric-lbl">Coastal Flood Exposure (FEMA NRI)</span>
              </div>
            </div>

            {power && (
              <div className="empower-banner" style={{ marginTop: "0.85rem", marginBottom: 0 }}>
                <strong>County-Level Medical Power Dependence ({power.county_name} — HHS emPOWER):</strong>{" "}
                <strong>{(power.power_dependent_dme ?? 0).toLocaleString()}</strong> Medicare beneficiaries rely on electricity-dependent DME
                {power.power_dependent_is_censored ? " (Censored value 11 = 1–10 residents)" : ""} •{" "}
                Oxygen: <strong>{(power.o2_services_any_dme ?? 0).toLocaleString()}</strong> •{" "}
                Dialysis: <strong>{(power.facility_esrd_dialysis_any_dme ?? 0).toLocaleString()}</strong> •{" "}
                Home Health: <strong>{(power.home_health_services_any_dme ?? 0).toLocaleString()}</strong>.
              </div>
            )}
          </>
        ) : (
          <div className="admin-empty-state">No census tract found near these coordinates.</div>
        )}
      </div>

      {/* 3. Nearby Shelters within Radius */}
      <div className="card">
        <div className="card-header">
          <h3>
            🛡️ Nearby Shelters Within {radiusKm} km ({shelters.length})
          </h3>
          <span className="source-tag">BigQuery: shelters (ST_DWITHIN)</span>
        </div>

        {shelters.length === 0 ? (
          <div className="admin-empty-state">
            No registered shelters found within {radiusKm} km of ({lat.toFixed(4)}, {lng.toFixed(4)}). Try increasing the search radius.
          </div>
        ) : (
          <div className="table-scroll-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Distance</th>
                  <th>Shelter Name & Address</th>
                  <th>Usage</th>
                  <th>Evac Cap</th>
                  <th>Wheelchair (FEMA)</th>
                  <th>Generator (FEMA)</th>
                  <th>Surge Zone</th>
                </tr>
              </thead>
              <tbody>
                {shelters.map((s) => (
                  <tr key={s.shelter_id}>
                    <td>
                      <strong>{s.distance_km} km</strong>
                    </td>
                    <td>
                      <strong>{s.shelter_name}</strong>
                      {s.is_medical && <span className="medical-pill">MEDICAL</span>}
                      <div className="subtext">
                        {s.address_1}, {s.city}
                      </div>
                    </td>
                    <td>
                      <span className="usage-pill">{s.usage || "UNSPECIFIED"}</span>
                    </td>
                    <td>{s.evacuation_capacity?.toLocaleString() ?? "N/A"}</td>
                    <td>
                      <span className={`status-pill status-${s.wheelchair_status.toLowerCase()}`}>
                        {s.wheelchair_status}
                      </span>
                    </td>
                    <td>
                      <span className={`status-pill status-${s.generator_status.toLowerCase()}`}>
                        {s.generator_status}
                      </span>
                    </td>
                    <td>
                      {s.in_surge_slosh_area === true ? (
                        <span className="status-pill status-no">IN SURGE</span>
                      ) : s.in_surge_slosh_area === false ? (
                        <span className="status-pill status-yes">OUTSIDE</span>
                      ) : (
                        <span className="status-pill status-unrecorded">UNRECORDED</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 4. Nearby Care Facilities / Nursing Homes */}
      <div className="card">
        <div className="card-header">
          <h3>
            🏥 Nearby Care Facilities & Nursing Homes Within {radiusKm} km ({careFacilities.length})
          </h3>
          <span className="source-tag">BigQuery: care_facilities (CMS)</span>
        </div>

        {careFacilities.length === 0 ? (
          <div className="admin-empty-state">
            No Medicare-certified nursing homes within {radiusKm} km.
          </div>
        ) : (
          <div className="table-scroll-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Distance</th>
                  <th>Facility Name</th>
                  <th>Address</th>
                  <th>Certified Beds</th>
                  <th>Ownership</th>
                </tr>
              </thead>
              <tbody>
                {careFacilities.map((c, idx) => (
                  <tr key={c.cms_certification_number_ccn || idx}>
                    <td>
                      <strong>{c.distance_km} km</strong>
                    </td>
                    <td>
                      <strong>{c.provider_name}</strong>
                    </td>
                    <td>
                      {c.provider_address}, {c.citytown} {c.zip_code}
                    </td>
                    <td>
                      <strong>{c.number_of_certified_beds?.toLocaleString() ?? "N/A"}</strong> beds
                    </td>
                    <td>{c.ownership_type || "N/A"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
