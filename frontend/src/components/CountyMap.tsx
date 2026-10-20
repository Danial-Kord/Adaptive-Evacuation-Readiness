import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  DashboardData,
  DashboardShelter,
  displayNumber as fmt,
  MapPoint,
} from "../services/dashboardData";
import {
  fetchShelterGoogleMaps,
  ShelterGoogleMapsDetail,
} from "../services/dashboardApi";
import { OpenHoursHistogram } from "./OpenHoursHistogram";
import { MapsAttribution } from "./MapsAttribution";

interface Props {
  data: DashboardData;
  selected: { kind: "shelter" | "tract"; id: string } | null;
  onSelect: (kind: "shelter" | "tract", id: string) => void;
  inspectedPoint?: { lat: number; lng: number; label?: string } | null;
  radiusKm?: number;
  onInspectPoint?: (lat: number, lng: number, label?: string) => void;
}

export function CountyMap({
  data,
  selected,
  onSelect,
  inspectedPoint = null,
  radiusKm = 15,
  onInspectPoint,
}: Props) {
  const element = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, L.Marker>());
  const inspectLayerRef = useRef<L.LayerGroup | null>(null);
  const onInspectRef = useRef(onInspectPoint);
  onInspectRef.current = onInspectPoint;

  const [showShelters, setShowShelters] = useState(true);
  const [showTracts, setShowTracts] = useState(true);
  const [onlyYes, setOnlyYes] = useState(false);
  const [tilesUnavailable, setTilesUnavailable] = useState(false);

  // Floating Shelter Card state
  const [activeShelter, setActiveShelter] = useState<DashboardShelter | null>(null);
  const [cardPos, setCardPos] = useState<{ left: number; top: number } | null>(null);
  const [mapsCache, setMapsCache] = useState<Record<string, ShelterGoogleMapsDetail>>({});
  const [loadingMaps, setLoadingMaps] = useState(false);
  const pinnedRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);

  const clearHideTimer = () => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const scheduleHide = () => {
    clearHideTimer();
    if (pinnedRef.current) return;
    hideTimerRef.current = window.setTimeout(() => {
      setActiveShelter(null);
    }, 220);
  };

  const updateCardPosition = (shelter: DashboardShelter | null) => {
    if (!shelter?.position || !mapRef.current || !element.current) {
      setCardPos(null);
      return;
    }
    const pt = mapRef.current.latLngToContainerPoint(shelter.position);
    const w = element.current.clientWidth || 600;
    const h = element.current.clientHeight || 420;
    const cardW = 320;
    const cardH = 240;
    const placeRight = pt.x < w / 2;
    const rawLeft = placeRight ? pt.x + 14 : pt.x - cardW - 14;
    const left = Math.max(10, Math.min(rawLeft, w - cardW - 10));
    const top = Math.max(10, Math.min(pt.y - 70, h - cardH - 10));
    setCardPos({ left, top });
  };

  useEffect(() => {
    if (!element.current) return;
    const map = L.map(element.current, { scrollWheelZoom: false }).setView([26.5, -81.8], 10);
    mapRef.current = map;
    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    tiles.on("tileerror", () => setTilesUnavailable(true));

    inspectLayerRef.current = L.layerGroup().addTo(map);

    map.on("click", (e: L.LeafletMouseEvent) => {
      clearHideTimer();
      pinnedRef.current = false;
      setActiveShelter(null);
      onInspectRef.current?.(
        Number(e.latlng.lat.toFixed(5)),
        Number(e.latlng.lng.toFixed(5)),
        "Clicked map location"
      );
    });

    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(element.current);
    return () => {
      clearHideTimer();
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      inspectLayerRef.current = null;
    };
  }, []);

  // Update card position when map moves or zooms
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    updateCardPosition(activeShelter);
    const onMove = () => updateCardPosition(activeShelter);
    map.on("move zoom", onMove);
    return () => {
      map.off("move zoom", onMove);
    };
  }, [activeShelter]);

  // Sync activeShelter if parent selects a shelter
  useEffect(() => {
    if (selected?.kind === "shelter") {
      const match = data.shelters.find(s => s.id === selected.id);
      if (match) {
        pinnedRef.current = true;
        setActiveShelter(match);
      }
    } else if (selected?.kind === "tract") {
      pinnedRef.current = false;
      setActiveShelter(null);
    }
  }, [selected, data.shelters]);

  // Clear active shelter when dataset changes (e.g. county switch)
  useEffect(() => {
    clearHideTimer();
    pinnedRef.current = false;
    setActiveShelter(null);
  }, [data]);

  // Fetch Google Maps details for hovered/pinned shelter
  useEffect(() => {
    if (!activeShelter) {
      setLoadingMaps(false);
      return;
    }
    if (mapsCache[activeShelter.id]) {
      setLoadingMaps(false);
      return;
    }
    const ctrl = new AbortController();
    setLoadingMaps(true);
    const timer = window.setTimeout(() => {
      fetchShelterGoogleMaps(activeShelter, ctrl.signal)
        .then(res => {
          if (!ctrl.signal.aborted) {
            setMapsCache(prev => ({ ...prev, [activeShelter.id]: res }));
            setLoadingMaps(false);
          }
        })
        .catch(() => {
          if (!ctrl.signal.aborted) {
            setLoadingMaps(false);
          }
        });
    }, 150);

    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [activeShelter, mapsCache]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const points = [...data.shelters, ...data.tracts]
      .map(p => p.position)
      .filter((p): p is [number, number] => p !== null);
    if (points.length) map.fitBounds(L.latLngBounds(points).pad(0.12), { maxZoom: 12 });
  }, [data]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const group = L.layerGroup().addTo(map);
    markers.current.clear();

    function add(point: MapPoint, kind: "shelter" | "tract", status: string) {
      if (!point.position) return;
      const marker = L.marker(point.position, {
        title: point.label,
        alt: point.label,
        keyboard: true,
        icon: L.divIcon({
          className: "planning-marker",
          html: `<span class="map-pin pin-${status.toLowerCase()}"></span>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        }),
      }).addTo(group);

      if (kind === "shelter") {
        const shelter = point as DashboardShelter;
        marker.on("mouseover", () => {
          clearHideTimer();
          if (!pinnedRef.current) {
            setActiveShelter(shelter);
          }
        });
        marker.on("mouseout", () => {
          scheduleHide();
        });
        marker.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          clearHideTimer();
          pinnedRef.current = true;
          setActiveShelter(shelter);
          onSelect(kind, point.id);
          if (point.position) {
            onInspectRef.current?.(point.position[0], point.position[1], point.label);
          }
        });
      } else {
        const popup = document.createElement("div");
        const heading = document.createElement("strong");
        heading.textContent = point.label;
        popup.append(heading);
        const note = document.createElement("p");
        note.textContent = "Tract centroid; not a boundary or pickup location.";
        popup.append(note);
        marker.bindPopup(popup);

        marker.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          clearHideTimer();
          pinnedRef.current = false;
          setActiveShelter(null);
          onSelect(kind, point.id);
          if (point.position) {
            onInspectRef.current?.(point.position[0], point.position[1], point.label);
          }
        });
      }

      markers.current.set(`${kind}:${point.id}`, marker);
    }

    if (showTracts) data.tracts.slice(0, 15).forEach(p => add(p, "tract", "tract"));
    if (showShelters)
      data.shelters.filter(s => !onlyYes || s.access === "YES").forEach(p => add(p, "shelter", p.access));

    return () => {
      group.remove();
    };
  }, [data, showShelters, showTracts, onlyYes, onSelect]);

  useEffect(() => {
    if (!selected) return;
    const marker = markers.current.get(`${selected.kind}:${selected.id}`);
    if (marker) {
      mapRef.current?.panTo(marker.getLatLng());
      if (selected.kind === "tract") {
        marker.openPopup();
      }
    }
  }, [selected, data, showShelters, showTracts, onlyYes, onSelect]);

  // Render clicked geolocation inspection circle & target marker
  useEffect(() => {
    const layer = inspectLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!inspectedPoint) return;

    L.circle([inspectedPoint.lat, inspectedPoint.lng], {
      radius: radiusKm * 1000,
      color: "#1261e8",
      weight: 1.75,
      dashArray: "5 4",
      fillColor: "#1261e8",
      fillOpacity: 0.07,
    }).addTo(layer);

    L.circleMarker([inspectedPoint.lat, inspectedPoint.lng], {
      radius: 8,
      color: "#123250",
      weight: 2.5,
      fillColor: "#1261e8",
      fillOpacity: 0.95,
    })
      .bindTooltip(
        `${inspectedPoint.label || "Inspected location"} (${inspectedPoint.lat.toFixed(
          4
        )}, ${inspectedPoint.lng.toFixed(4)})`,
        { direction: "top" }
      )
      .addTo(layer);
  }, [inspectedPoint, radiusKm]);

  const shelterMaps = activeShelter ? mapsCache[activeShelter.id] : undefined;
  const recon = shelterMaps?.reconciliation;
  const shelterFlags = activeShelter ? (() => {
    const items: Array<[string, string]> = [
      ["Medical", activeShelter.medical],
      ["Generator", activeShelter.generator],
      ["Self-sufficient", activeShelter.selfSufficientPower],
      ["Surge", activeShelter.surge],
      ["100-yr flood", activeShelter.floodplain100yr],
      ["Pets", activeShelter.pets],
    ];
    return {
      recorded: items.filter(([, v]) => v && v !== "UNRECORDED"),
      unrecorded: items.filter(([, v]) => !v || v === "UNRECORDED").map(([k]) => k),
    };
  })() : null;

  return (
    <section className="planning-card map-card" aria-label="County readiness map">
      <div className="panel-heading">
        <div>
          <h2>Shelters & priority areas</h2>
          <p>
            Registered sites and the top 15 no-vehicle household tracts ·{" "}
            <strong>Click anywhere on the map or any marker to inspect geolocation area details</strong>
          </p>
        </div>
        <span className="small-tag">Click map to inspect area</span>
      </div>
      <div className="map-toolbar">
        <label>
          <input type="checkbox" checked={showTracts} onChange={e => setShowTracts(e.target.checked)} /> Priority tract
          centroids
        </label>
        <label>
          <input type="checkbox" checked={showShelters} onChange={e => setShowShelters(e.target.checked)} /> Shelters
        </label>
        <label>
          <input
            type="checkbox"
            checked={onlyYes}
            onChange={e => setOnlyYes(e.target.checked)}
            disabled={!showShelters}
          />{" "}
          Recorded YES only
        </label>
      </div>
      <div className="map-stage">
        <div ref={element} className="planning-map" />

        {activeShelter && cardPos && (
          <aside
            className="planning-floating-shelter-card"
            style={{ left: `${cardPos.left}px`, top: `${cardPos.top}px` }}
            aria-label="Selected shelter details"
            onMouseEnter={clearHideTimer}
            onMouseLeave={scheduleHide}
          >
            <div className="planning-floating-header">
              <strong>{activeShelter.label}</strong>
              <button
                type="button"
                className="planning-floating-close"
                onClick={() => {
                  clearHideTimer();
                  pinnedRef.current = false;
                  setActiveShelter(null);
                }}
                aria-label="Close shelter card"
              >
                ×
              </button>
            </div>
            <div className="planning-floating-body">
              <div>
                <p>
                  <span>Address & open hours</span>
                  {activeShelter.address}{activeShelter.zip ? ` ${activeShelter.zip}` : ""}
                  {loadingMaps ? (
                    <em className="checking"> · Checking <span translate="no">Google Maps</span>…</em>
                  ) : shelterMaps ? (
                    <> ({shelterMaps.placeType} · <b className={`record-badge ${shelterMaps.businessStatus === "OPERATIONAL" ? "yes" : shelterMaps.businessStatus.includes("CLOSED") ? "no" : "unrecorded"}`}>{shelterMaps.businessStatus}</b>)</>
                  ) : null}
                </p>
                {shelterMaps && !loadingMaps && shelterMaps.openHours && (
                  <OpenHoursHistogram hoursText={shelterMaps.openHours} />
                )}
              </div>
              <p>
                <span>Capacity & usage</span>
                {activeShelter.usage} · Pre-landfall: <b>{fmt(activeShelter.capacity)}</b> · Post-impact: <b>{fmt(activeShelter.postCapacity)}</b>
              </p>
              <p>
                <span>♿ Wheelchair accessibility</span>
                <span className="wheelchair-reconcile-row">
                  <span className="wheelchair-icon" aria-hidden="true">♿</span>
                  {loadingMaps ? (
                    <><b className={`record-badge ${activeShelter.access.toLowerCase()}`}>{activeShelter.access}</b> · Source: BigQuery <em className="checking">(checking <span translate="no">Google Maps</span>…)</em></>
                  ) : recon ? (
                    <>
                      <b className={`record-badge ${recon.resolvedAccess.toLowerCase()}`}>{recon.resolvedAccess}</b>
                      {recon.state === "MATCH" && (
                        <> · <span className="source-highlight">Source: BigQuery</span> <small>(matched with <span translate="no">Google Maps</span>)</small></>
                      )}
                      {recon.state === "CONFLICT" && (
                        <> · <span className="source-highlight">Source: <span translate="no">Google Maps</span></span> <small>(conflict with BigQuery: {recon.bqAccess})</small></>
                      )}
                      {recon.state === "FROM_GOOGLE_MAPS" && (
                        <> · <span className="source-highlight">Source: <span translate="no">Google Maps</span></span> <small>(BigQuery unrecorded)</small></>
                      )}
                      {recon.state === "FROM_BIGQUERY_ONLY" && (
                        <> · <span className="source-highlight">Source: BigQuery</span> <small>(unlisted on <span translate="no">Google Maps</span>)</small></>
                      )}
                      {recon.state === "UNRECORDED" && (
                        <> · <small>Source: Unrecorded in BigQuery & <span translate="no">Google Maps</span></small></>
                      )}
                    </>
                  ) : (
                    <><b className={`record-badge ${activeShelter.access.toLowerCase()}`}>{activeShelter.access}</b> · Source: BigQuery</>
                  )}
                </span>
              </p>
              <p>
                <span>Facility, power & flood flags</span>
                {shelterFlags?.recorded.map(([k, v], i) => (
                  <React.Fragment key={k}>{i > 0 ? " · " : ""}{k}: <b className={`record-badge ${v.toLowerCase()}`}>{v}</b></React.Fragment>
                ))}
                {shelterFlags && shelterFlags.unrecorded.length > 0 && (
                  <>{shelterFlags.recorded.length > 0 ? " · " : ""}<small>Unrecorded: {shelterFlags.unrecorded.join(", ")}</small></>
                )}
              </p>
            </div>
            {shelterMaps && shelterMaps.groundingChunks.length > 0 && (
              <MapsAttribution chunks={shelterMaps.groundingChunks} />
            )}
          </aside>
        )}

        <div className="map-key">
          <strong>Wheelchair record</strong>
          <span>
            <i className="key-dot yes" /> YES
          </span>
          <span>
            <i className="key-dot no" /> NO
          </span>
          <span>
            <i className="key-dot unknown" /> UNRECORDED
          </span>
          <span>
            <i className="key-dot tract" /> Priority tract centroid
          </span>
        </div>
      </div>
      <div className="map-footnote">
        {tilesUnavailable ? "Basemap unavailable — check network access. Points use source coordinates. " : ""}
        Centroids show approximate tract locations. Click any point on the map to fetch BigQuery spatial records and
        live Google Maps Grounding details.
      </div>
    </section>
  );
}
