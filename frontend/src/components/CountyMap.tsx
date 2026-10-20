import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { DashboardData, MapPoint } from "../services/dashboardData";

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
      onInspectRef.current?.(
        Number(e.latlng.lat.toFixed(5)),
        Number(e.latlng.lng.toFixed(5)),
        "Clicked map location"
      );
    });

    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      inspectLayerRef.current = null;
    };
  }, []);

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
      const popup = document.createElement("div");
      const heading = document.createElement("strong");
      heading.textContent = point.label;
      popup.append(heading);
      const note = document.createElement("p");
      note.textContent =
        kind === "shelter"
          ? `Wheelchair record: ${status}. Maps verification pending.`
          : "Tract centroid; not a boundary or pickup location.";
      popup.append(note);
      marker.bindPopup(popup);
      marker.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        onSelect(kind, point.id);
        if (point.position) {
          onInspectRef.current?.(point.position[0], point.position[1], point.label);
        }
      });
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
      marker.openPopup();
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
