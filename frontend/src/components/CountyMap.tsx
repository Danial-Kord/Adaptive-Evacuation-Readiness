import React, { useEffect, useMemo, useRef, useState } from "react";
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
import {
  ActionDecisionRecord,
  ActionDecisionStatus,
  RecommendedAction,
} from "../types/brief";
import {
  FocusLocationTarget,
  getAgentMeta,
  RecommendedActionCard,
  resolveActionFromTo,
} from "./AgentSchemaCards";

interface Props {
  data: DashboardData;
  selected: { kind: "shelter" | "tract"; id: string } | null;
  onSelect: (kind: "shelter" | "tract", id: string) => void;
  inspectedPoint?: { lat: number; lng: number; label?: string } | null;
  radiusKm?: number;
  onInspectPoint?: (lat: number, lng: number, label?: string) => void;
  /** Pending (undecided) agent actions synchronized with the Chat Widget */
  pendingActions?: RecommendedAction[];
  /** Currently focused action ID on the map & chat */
  activeActionId?: string | null;
  onSelectAction?: (actionId: string) => void;
  /** Synchronized option selection per action_id between Map and Chat */
  selectedOptionsByAction?: Record<string, string>;
  onSelectActionOption?: (actionId: string, optionId: string) => void;
  /** Synchronized Approve / Reject handler — dismisses from both Map and Chat */
  decisions?: Record<string, ActionDecisionRecord>;
  onDecideAction?: (
    action: RecommendedAction,
    decision: ActionDecisionStatus,
    selectedOptionId?: string,
    note?: string,
    sendFollowUp?: boolean
  ) => void;
  decidingActionId?: string | null;
  /** Explicit focus/zoom request from either Chat or Map widget */
  focusTarget?: FocusLocationTarget | null;
  onFocusLocation?: (target: FocusLocationTarget) => void;
}

export function CountyMap({
  data,
  selected,
  onSelect,
  inspectedPoint = null,
  radiusKm = 15,
  onInspectPoint,
  pendingActions = [],
  activeActionId = null,
  onSelectAction,
  selectedOptionsByAction = {},
  onSelectActionOption,
  decisions = {},
  onDecideAction,
  decidingActionId = null,
  focusTarget = null,
  onFocusLocation,
}: Props) {
  const element = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, L.Marker>());
  const inspectLayerRef = useRef<L.LayerGroup | null>(null);
  const actionLayerRef = useRef<L.LayerGroup | null>(null);
  const onInspectRef = useRef(onInspectPoint);
  onInspectRef.current = onInspectPoint;
  const onSelectOptionRef = useRef(onSelectActionOption);
  onSelectOptionRef.current = onSelectActionOption;

  const [showShelters, setShowShelters] = useState(true);
  const [showTracts, setShowTracts] = useState(true);
  const [onlyYes, setOnlyYes] = useState(false);
  const [tilesUnavailable, setTilesUnavailable] = useState(false);
  const [mapWidgetCollapsed, setMapWidgetCollapsed] = useState(false);

  // Determine the active pending action to display & highlight on the map
  const activeAction = useMemo(() => {
    if (!pendingActions.length) return null;
    if (activeActionId) {
      const match = pendingActions.find((a) => a.action_id === activeActionId);
      if (match) return match;
    }
    return pendingActions[0];
  }, [pendingActions, activeActionId]);

  const activeSelectedOptionId = activeAction
    ? selectedOptionsByAction[activeAction.action_id]
    : undefined;

  const resolvedFromTo = useMemo(() => {
    if (!activeAction) return null;
    return resolveActionFromTo(activeAction, activeSelectedOptionId, data);
  }, [activeAction, activeSelectedOptionId, data]);

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
    actionLayerRef.current = L.layerGroup().addTo(map);

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
      actionLayerRef.current = null;
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

  // Render FROM -> TO connection lines, candidate options, and auto-zoom to the targeted area
  useEffect(() => {
    const map = mapRef.current;
    const layer = actionLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    if (!activeAction || !resolvedFromTo) return;

    const { from, to, candidates } = resolvedFromTo;
    const boundsPoints: [number, number][] = [];

    // 1. Draw alternative unselected candidate option connectors
    if (from && candidates.length > 1) {
      for (const cand of candidates) {
        if (cand.selected) continue;
        L.polyline(
          [
            [from.lat, from.lng],
            [cand.lat, cand.lng],
          ],
          {
            color: "#64748b",
            weight: 2,
            opacity: 0.55,
            dashArray: "5 7",
          }
        ).addTo(layer);

        const altMarker = L.marker([cand.lat, cand.lng], {
          icon: L.divIcon({
            className: "map-from-to-marker-wrap",
            html: `<div class="map-endpoint-badge map-endpoint-badge--alt" title="Click to select option: ${cand.label}">
              <span class="map-endpoint-dot"></span>
              <span class="map-endpoint-tag">ALT OPTION</span>
              <span class="map-endpoint-name">${cand.label}</span>
            </div>`,
            iconSize: [160, 28],
            iconAnchor: [80, 14],
          }),
        }).addTo(layer);

        altMarker.on("click", (e: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(e);
          onSelectOptionRef.current?.(activeAction.action_id, cand.optionId);
        });
      }
    }

    // 2. Draw primary FROM -> TO connection line + midpoint callout
    if (from && to && (from.lat !== to.lat || from.lng !== to.lng)) {
      const latlngs: [number, number][] = [
        [from.lat, from.lng],
        [to.lat, to.lng],
      ];

      // Outer highlight glow
      L.polyline(latlngs, {
        color: "#1d4ed8",
        weight: 10,
        opacity: 0.22,
        lineCap: "round",
      }).addTo(layer);

      // Animated dashed core line
      L.polyline(latlngs, {
        color: "#0284c7",
        weight: 3.5,
        opacity: 0.95,
        dashArray: "10 7",
        className: "map-from-to-animated-line",
      }).addTo(layer);

      // Midpoint route callout badge
      const midLat = (from.lat + to.lat) / 2;
      const midLng = (from.lng + to.lng) / 2;
      const routeText = to.routeLabel || "FROM → TO Route";
      L.marker([midLat, midLng], {
        interactive: false,
        icon: L.divIcon({
          className: "map-route-pill-wrap",
          html: `<div class="map-route-pill">➔ ${routeText}</div>`,
          iconSize: [140, 24],
          iconAnchor: [70, 12],
        }),
      }).addTo(layer);
    }

    // 3. Draw FROM origin pulsing marker & badge
    if (from) {
      boundsPoints.push([from.lat, from.lng]);

      L.circleMarker([from.lat, from.lng], {
        radius: 14,
        color: "#d97706",
        weight: 2.5,
        fillColor: "#f59e0b",
        fillOpacity: 0.22,
      }).addTo(layer);

      const fromMarker = L.marker([from.lat, from.lng], {
        icon: L.divIcon({
          className: "map-from-to-marker-wrap",
          html: `<div class="map-endpoint-badge map-endpoint-badge--from">
            <span class="map-endpoint-pulse map-endpoint-pulse--from"></span>
            <span class="map-endpoint-tag">FROM</span>
            <span class="map-endpoint-name">${from.label}</span>
          </div>`,
          iconSize: [190, 32],
          iconAnchor: [95, 36],
        }),
      }).addTo(layer);

      fromMarker.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        if (from.kind && from.id && (from.kind === "tract" || from.kind === "shelter")) {
          onSelect(from.kind, from.id);
        }
        onInspectRef.current?.(from.lat, from.lng, `FROM: ${from.label}`);
      });
    }

    // 4. Draw TO destination pulsing marker & badge
    if (to) {
      boundsPoints.push([to.lat, to.lng]);

      L.circleMarker([to.lat, to.lng], {
        radius: 14,
        color: "#059669",
        weight: 2.5,
        fillColor: "#10b981",
        fillOpacity: 0.25,
      }).addTo(layer);

      const toMarker = L.marker([to.lat, to.lng], {
        icon: L.divIcon({
          className: "map-from-to-marker-wrap",
          html: `<div class="map-endpoint-badge map-endpoint-badge--to">
            <span class="map-endpoint-pulse map-endpoint-pulse--to"></span>
            <span class="map-endpoint-tag">TO</span>
            <span class="map-endpoint-name">${to.label}</span>
          </div>`,
          iconSize: [190, 32],
          iconAnchor: [95, -6],
        }),
      }).addTo(layer);

      toMarker.on("click", (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        if (to.kind && to.id && (to.kind === "tract" || to.kind === "shelter")) {
          onSelect(to.kind, to.id);
        }
        onInspectRef.current?.(to.lat, to.lng, `TO: ${to.label}`);
      });
    }

    // Auto-zoom to frame the targeted FROM -> TO area
    if (boundsPoints.length >= 2) {
      const bounds = L.latLngBounds(boundsPoints);
      map.flyToBounds(bounds.pad(0.35), {
        maxZoom: 13,
        duration: 0.65,
      });
    } else if (boundsPoints.length === 1) {
      map.flyTo(boundsPoints[0], 13, { duration: 0.65 });
    }
  }, [activeAction, resolvedFromTo, onSelect]);

  // Also respond to explicit focusTarget requests from Chat or Schema cards
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusTarget) return;

    if (
      typeof focusTarget.fromLat === "number" &&
      typeof focusTarget.fromLng === "number" &&
      typeof focusTarget.toLat === "number" &&
      typeof focusTarget.toLng === "number"
    ) {
      const bounds = L.latLngBounds([
        [focusTarget.fromLat, focusTarget.fromLng],
        [focusTarget.toLat, focusTarget.toLng],
      ]);
      map.flyToBounds(bounds.pad(0.35), { maxZoom: 13, duration: 0.65 });
    } else if (
      typeof focusTarget.latitude === "number" &&
      typeof focusTarget.longitude === "number"
    ) {
      map.flyTo([focusTarget.latitude, focusTarget.longitude], 13, {
        duration: 0.65,
      });
    } else if (focusTarget.kind === "tract" && focusTarget.id) {
      const tract = data.tracts.find((t) => t.id === focusTarget.id);
      if (tract && tract.position) {
        map.flyTo(tract.position, 13, { duration: 0.65 });
      }
    } else if (focusTarget.kind === "shelter" && focusTarget.id) {
      const shelter = data.shelters.find(
        (s) => s.id === focusTarget.id || s.label.toLowerCase() === focusTarget.id?.toLowerCase()
      );
      if (shelter && shelter.position) {
        map.flyTo(shelter.position, 13, { duration: 0.65 });
      }
    }
  }, [focusTarget, data]);

  const handleZoomActiveFromTo = () => {
    const map = mapRef.current;
    if (!map || !resolvedFromTo) return;
    const pts: [number, number][] = [];
    if (resolvedFromTo.from) pts.push([resolvedFromTo.from.lat, resolvedFromTo.from.lng]);
    if (resolvedFromTo.to) pts.push([resolvedFromTo.to.lat, resolvedFromTo.to.lng]);
    if (pts.length >= 2) {
      map.flyToBounds(L.latLngBounds(pts).pad(0.35), { maxZoom: 13, duration: 0.65 });
    } else if (pts.length === 1) {
      map.flyTo(pts[0], 13, { duration: 0.65 });
    }
  };

  return (
    <section className="planning-card map-card" aria-label="County readiness map">
      <div className="panel-heading">
        <div>
          <h2>Shelters &amp; priority areas</h2>
          <p>
            Registered sites, top 15 no-vehicle tracts, and live{" "}
            <strong>FROM → TO agent decision routing</strong>
          </p>
        </div>
        <div className="map-heading-badges">
          {activeAction && resolvedFromTo?.from && resolvedFromTo?.to && (
            <button
              type="button"
              className="map-zoom-route-btn"
              onClick={handleZoomActiveFromTo}
              title="Auto-zoom map to active FROM → TO connection"
            >
              ⊕ Zoom FROM → TO
            </button>
          )}
          <span className="small-tag">Click map to inspect area</span>
        </div>
      </div>

      <div className="map-toolbar">
        <label>
          <input
            type="checkbox"
            checked={showTracts}
            onChange={(e) => setShowTracts(e.target.checked)}
          />{" "}
          Priority tract centroids
        </label>
        <label>
          <input
            type="checkbox"
            checked={showShelters}
            onChange={(e) => setShowShelters(e.target.checked)}
          />{" "}
          Shelters
        </label>
        <label>
          <input
            type="checkbox"
            checked={onlyYes}
            onChange={(e) => setOnlyYes(e.target.checked)}
            disabled={!showShelters}
          />{" "}
          Recorded YES only
        </label>

        {pendingActions.length > 0 && (
          <div className="map-toolbar-actions-switcher">
            <span className="map-switcher-label">
              ✧ Map Decisions ({pendingActions.length} pending):
            </span>
            {pendingActions.map((act, idx) => {
              const meta = getAgentMeta(act.source_agent);
              const isCurrent = activeAction?.action_id === act.action_id;
              return (
                <button
                  key={act.action_id}
                  type="button"
                  className={`map-action-tab-pill ${isCurrent ? "active" : ""}`}
                  onClick={() => {
                    onSelectAction?.(act.action_id);
                    setMapWidgetCollapsed(false);
                  }}
                >
                  {idx + 1}. {meta.shortLabel}
                </button>
              );
            })}
          </div>
        )}
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
                {shelterMaps && !loadingMaps && !shelterMaps.error && (
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

        {/* On-Map Synchronized Agent Decision Widget Overlay */}
        {activeAction && onDecideAction && (
          <div
            className={`map-action-widget-overlay ${
              mapWidgetCollapsed ? "collapsed" : ""
            }`}
            aria-label="On-map agent decision widget"
          >
            <div className="map-action-widget-bar">
              <div className="map-action-widget-title">
                <span className="map-action-live-dot" />
                <strong>On-Map Agent Decision</strong>
                <span className="map-action-count-pill">
                  {pendingActions.length} Pending · Synced with Chat
                </span>
              </div>
              <div className="map-action-widget-controls">
                <button
                  type="button"
                  className="map-widget-ctrl-btn"
                  onClick={handleZoomActiveFromTo}
                  title="Auto-zoom to FROM → TO area"
                >
                  ⊕ Fit Route
                </button>
                <button
                  type="button"
                  className="map-widget-ctrl-btn"
                  onClick={() => setMapWidgetCollapsed((c) => !c)}
                >
                  {mapWidgetCollapsed ? "▲ Expand Card" : "▼ Minimize"}
                </button>
              </div>
            </div>

            {!mapWidgetCollapsed && (
              <div className="map-action-widget-body">
                <RecommendedActionCard
                  key={`map-card-${activeAction.action_id}`}
                  action={activeAction}
                  decision={decisions[activeAction.action_id]}
                  selectedOptionId={selectedOptionsByAction[activeAction.action_id]}
                  onSelectOption={onSelectActionOption}
                  onDecide={onDecideAction}
                  onFocusLocation={(target) => {
                    onFocusLocation?.(target);
                    handleZoomActiveFromTo();
                  }}
                  dashboardData={data}
                  isFocusedOnMap={true}
                  compactMapMode={true}
                  busy={decidingActionId === activeAction.action_id}
                />
              </div>
            )}
          </div>
        )}

        <div className="map-key">
          <strong>Map Legend</strong>
          <span>
            <i className="key-dot from-pin" /> FROM Origin
          </span>
          <span>
            <i className="key-dot to-pin" /> TO Destination
          </span>
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
            <i className="key-dot tract" /> Tract centroid
          </span>
        </div>
      </div>
      <div className="map-footnote">
        {tilesUnavailable ? "Basemap unavailable — check network access. Points use source coordinates. " : ""}
        Approving or rejecting a recommendation on the map or in the chat dismisses it from both views simultaneously.
      </div>
    </section>
  );
}
