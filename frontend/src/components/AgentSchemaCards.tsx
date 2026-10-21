import React, { useEffect, useState } from "react";
import { DashboardData } from "../services/dashboardData";
import {
  ActionDecisionRecord,
  ActionDecisionStatus,
  ActionOption,
  AgentSchemaOutput,
  LocationInfo,
  RecommendedAction,
} from "../types/brief";

export interface FocusLocationTarget {
  kind: "tract" | "shelter" | "coords" | "action";
  id?: string;
  actionId?: string;
  county?: string;
  label?: string;
  latitude?: number;
  longitude?: number;
  fromLat?: number;
  fromLng?: number;
  fromLabel?: string;
  toLat?: number;
  toLng?: number;
  toLabel?: string;
}

export interface ResolvedMapEndpoint {
  lat: number;
  lng: number;
  label: string;
  kind?: "tract" | "shelter" | "coords";
  id?: string;
  routeLabel?: string;
}

export interface ResolvedCandidateEndpoint extends ResolvedMapEndpoint {
  optionId: string;
  recommended: boolean;
  selected: boolean;
}

export interface ResolvedActionFromTo {
  from: ResolvedMapEndpoint | null;
  to: ResolvedMapEndpoint | null;
  candidates: ResolvedCandidateEndpoint[];
}

const AGENT_META: Record<
  string,
  { label: string; shortLabel: string; colorClass: string; role: string }
> = {
  prioritization_agent: {
    label: "Prioritization Specialist",
    shortLabel: "Prioritization",
    colorClass: "agent-pill--prioritization",
    role: "Vulnerability & Tract Ranking",
  },
  destination_agent: {
    label: "Destination Optimization Specialist",
    shortLabel: "Destination",
    colorClass: "agent-pill--destination",
    role: "Shelter Routing & Capacity",
  },
  verification_agent: {
    label: "Verification & Grounding Specialist",
    shortLabel: "Verification",
    colorClass: "agent-pill--verification",
    role: "Google Maps Live Grounding & Audit",
  },
  evac_readiness_coordinator: {
    label: "Evacuation Readiness Coordinator",
    shortLabel: "Coordinator",
    colorClass: "agent-pill--coordinator",
    role: "County Gap Synthesis & Command",
  },
};

export function getAgentMeta(agentName?: string) {
  if (!agentName) return AGENT_META.evac_readiness_coordinator;
  return (
    AGENT_META[agentName] || {
      label: agentName.replace(/_/g, " "),
      shortLabel: agentName.replace(/_agent$/i, ""),
      colorClass: "agent-pill--coordinator",
      role: "Specialist Agent",
    }
  );
}

function toEndpoint(
  loc?: LocationInfo | null,
  data?: DashboardData | null
): ResolvedMapEndpoint | null {
  if (!loc) return null;
  let lat = typeof loc.lat === "number" ? loc.lat : undefined;
  let lng = typeof loc.lon === "number" ? loc.lon : undefined;

  if ((lat === undefined || lng === undefined) && loc.tract_geoid && data?.tracts) {
    const t = data.tracts.find((tr) => tr.id === String(loc.tract_geoid));
    if (t?.position) {
      lat = t.position[0];
      lng = t.position[1];
    }
  }
  if ((lat === undefined || lng === undefined) && loc.shelter_id != null && data?.shelters) {
    const s = data.shelters.find((sh) => sh.id === String(loc.shelter_id));
    if (s?.position) {
      lat = s.position[0];
      lng = s.position[1];
    }
  }

  if (lat === undefined || lng === undefined) return null;

  return {
    lat,
    lng,
    label:
      loc.label ||
      (loc.tract_geoid
        ? `Tract ${loc.tract_geoid}`
        : loc.shelter_id != null
        ? `Shelter #${loc.shelter_id}`
        : "Target Location"),
    kind: loc.tract_geoid
      ? "tract"
      : loc.shelter_id != null
      ? "shelter"
      : "coords",
    id: loc.tract_geoid
      ? String(loc.tract_geoid)
      : loc.shelter_id != null
      ? String(loc.shelter_id)
      : undefined,
  };
}

/**
 * Resolves the FROM origin, active TO destination, and all candidate option endpoints
 * for a RecommendedAction so the map can draw a clear FROM -> TO connection line and auto-zoom.
 */
export function resolveActionFromTo(
  action: RecommendedAction,
  selectedOptionId?: string,
  data?: DashboardData | null
): ResolvedActionFromTo {
  const options: ActionOption[] = Array.isArray(action.options) ? action.options : [];
  const defaultOptId =
    selectedOptionId ||
    action.selected_option_id ||
    options.find((o) => o.recommended)?.option_id ||
    options[0]?.option_id ||
    "";

  const candidates: ResolvedCandidateEndpoint[] = [];
  for (const opt of options) {
    const ep = toEndpoint(opt.location, data);
    if (ep) {
      const m = opt.metrics || {};
      const routeParts: string[] = [];
      if (m.drive_miles != null) routeParts.push(`${m.drive_miles} mi`);
      if (m.drive_minutes != null) routeParts.push(`${m.drive_minutes} min`);
      candidates.push({
        ...ep,
        label: opt.location?.label || opt.label,
        optionId: opt.option_id,
        recommended: Boolean(opt.recommended),
        selected: opt.option_id === defaultOptId,
        routeLabel: routeParts.length ? routeParts.join(" · ") : undefined,
      });
    }
  }

  // Resolve FROM origin
  let fromEp = toEndpoint(action.from_location, data);
  if (!fromEp) {
    const locEp = toEndpoint(action.location, data);
    if (locEp && locEp.kind === "tract") {
      fromEp = locEp;
    } else if (data?.tracts && data.tracts.length > 0 && data.tracts[0].position) {
      fromEp = {
        lat: data.tracts[0].position[0],
        lng: data.tracts[0].position[1],
        label: `Origin: ${data.tracts[0].label}`,
        kind: "tract",
        id: data.tracts[0].id,
      };
    } else if (locEp) {
      fromEp = locEp;
    }
  }

  // Resolve TO destination (prefer selected candidate option if available)
  const selectedCand =
    candidates.find((c) => c.selected) || candidates[0] || null;
  let toEp: ResolvedMapEndpoint | null = selectedCand
    ? {
        lat: selectedCand.lat,
        lng: selectedCand.lng,
        label: selectedCand.label,
        kind: selectedCand.kind,
        id: selectedCand.id,
        routeLabel: selectedCand.routeLabel,
      }
    : toEndpoint(action.to_location, data);

  if (!toEp) {
    const locEp = toEndpoint(action.location, data);
    if (
      locEp &&
      (!fromEp || locEp.lat !== fromEp.lat || locEp.lng !== fromEp.lng)
    ) {
      toEp = locEp;
    } else if (data?.shelters && data.shelters.length > 0 && data.shelters[0].position) {
      toEp = {
        lat: data.shelters[0].position[0],
        lng: data.shelters[0].position[1],
        label: data.shelters[0].label,
        kind: "shelter",
        id: data.shelters[0].id,
      };
    }
  }

  return {
    from: fromEp,
    to: toEp,
    candidates,
  };
}

function extractFocusFromLocation(
  loc?: LocationInfo | null,
  actionId?: string
): FocusLocationTarget | null {
  if (!loc) return null;
  const lat = typeof loc.lat === "number" ? loc.lat : undefined;
  const lon = typeof loc.lon === "number" ? loc.lon : undefined;
  const county = loc.county ? String(loc.county).replace(/\s+County$/i, "").trim() : undefined;

  if (loc.tract_geoid) {
    return {
      kind: "tract",
      id: String(loc.tract_geoid),
      actionId,
      county,
      label: loc.label || `Tract ${loc.tract_geoid}`,
      latitude: lat,
      longitude: lon,
    };
  }
  if (loc.shelter_id != null) {
    return {
      kind: "shelter",
      id: String(loc.shelter_id),
      actionId,
      county,
      label: loc.label || `Shelter ${loc.shelter_id}`,
      latitude: lat,
      longitude: lon,
    };
  }
  if (lat !== undefined && lon !== undefined) {
    return {
      kind: "coords",
      actionId,
      county,
      label: loc.label || "Map Location",
      latitude: lat,
      longitude: lon,
    };
  }
  return null;
}

/* ============================================================================
 * 1. RECOMMENDED ACTION CARD (Approve / Reject / Select Between Options)
 * ============================================================================ */

interface RecommendedActionCardProps {
  action: RecommendedAction;
  decision?: ActionDecisionRecord;
  selectedOptionId?: string;
  onSelectOption?: (actionId: string, optionId: string) => void;
  onDecide: (
    action: RecommendedAction,
    decision: ActionDecisionStatus,
    selectedOptionId?: string,
    note?: string,
    sendFollowUp?: boolean
  ) => void;
  onFocusLocation?: (target: FocusLocationTarget) => void;
  dashboardData?: DashboardData | null;
  isFocusedOnMap?: boolean;
  compactMapMode?: boolean;
  busy?: boolean;
}

export const RecommendedActionCard: React.FC<RecommendedActionCardProps> = ({
  action,
  decision,
  selectedOptionId: controlledOptionId,
  onSelectOption,
  onDecide,
  onFocusLocation,
  dashboardData = null,
  isFocusedOnMap = false,
  compactMapMode = false,
  busy = false,
}) => {
  const options: ActionOption[] = Array.isArray(action.options) ? action.options : [];
  const hasOptions =
    options.length > 0 ||
    action.interaction_mode === "SELECT_BETWEEN_OPTIONS" ||
    Boolean(action.requires_selection);

  const defaultRecommendedOption =
    action.selected_option_id ||
    options.find((o) => o.recommended)?.option_id ||
    options[0]?.option_id ||
    "";

  const [internalOptionId, setInternalOptionId] = useState<string>(
    decision?.selected_option_id || controlledOptionId || defaultRecommendedOption
  );

  useEffect(() => {
    if (controlledOptionId) {
      setInternalOptionId(controlledOptionId);
    }
  }, [controlledOptionId]);

  const activeOptionId = controlledOptionId || internalOptionId;

  const [note, setNote] = useState<string>(decision?.note || "");
  const [showNoteInput, setShowNoteInput] = useState<boolean>(false);
  const [editingDecision, setEditingDecision] = useState<boolean>(false);

  const agentMeta = getAgentMeta(action.source_agent);
  const severity = (action.severity || "HIGH").toUpperCase();
  const resolvedFromTo = resolveActionFromTo(action, activeOptionId, dashboardData);

  const confirmLabel =
    action.approval?.confirm_label ||
    (hasOptions ? "Approve Selected Option" : "Approve Action");
  const rejectLabel = action.approval?.reject_label || "Reject";

  const selectedOption = options.find((o) => o.option_id === activeOptionId);
  const isDecided = Boolean(decision) && !editingDecision;
  const actionCounty = (
    selectedOption?.location?.county ||
    action.location?.county ||
    action.from_location?.county ||
    action.to_location?.county ||
    ""
  )
    .replace(/\s+County$/i, "")
    .trim() || undefined;

  const handleOptionChange = (optionId: string) => {
    setInternalOptionId(optionId);
    onSelectOption?.(action.action_id, optionId);
    const nextFromTo = resolveActionFromTo(action, optionId, dashboardData);
    if (onFocusLocation && (nextFromTo.from || nextFromTo.to)) {
      onFocusLocation({
        kind: "action",
        actionId: action.action_id,
        county: actionCounty,
        label: action.title,
        fromLat: nextFromTo.from?.lat,
        fromLng: nextFromTo.from?.lng,
        fromLabel: nextFromTo.from?.label,
        toLat: nextFromTo.to?.lat,
        toLng: nextFromTo.to?.lng,
        toLabel: nextFromTo.to?.label,
      });
    }
  };

  const handleFocusFromTo = () => {
    if (!onFocusLocation) return;
    onFocusLocation({
      kind: "action",
      actionId: action.action_id,
      county: actionCounty,
      id:
        resolvedFromTo.to?.id ||
        resolvedFromTo.from?.id ||
        action.location?.tract_geoid ||
        (action.location?.shelter_id != null
          ? String(action.location.shelter_id)
          : undefined),
      label: action.title,
      latitude: resolvedFromTo.to?.lat ?? resolvedFromTo.from?.lat,
      longitude: resolvedFromTo.to?.lng ?? resolvedFromTo.from?.lng,
      fromLat: resolvedFromTo.from?.lat,
      fromLng: resolvedFromTo.from?.lng,
      fromLabel: resolvedFromTo.from?.label,
      toLat: resolvedFromTo.to?.lat,
      toLng: resolvedFromTo.to?.lng,
      toLabel: resolvedFromTo.to?.label,
    });
  };

  const handleConfirm = (sendFollowUp: boolean) => {
    const status: ActionDecisionStatus = hasOptions
      ? "OPTION_SELECTED"
      : "APPROVED";
    setEditingDecision(false);
    onDecide(
      action,
      status,
      hasOptions ? activeOptionId : undefined,
      note.trim() || undefined,
      sendFollowUp
    );
  };

  const handleReject = (sendFollowUp: boolean) => {
    setEditingDecision(false);
    onDecide(
      action,
      "REJECTED",
      hasOptions ? activeOptionId : undefined,
      note.trim() || undefined,
      sendFollowUp
    );
  };

  const popBadge =
    action.affected_households != null
      ? `${action.affected_households.toLocaleString()} HH affected`
      : action.affected_residents != null
      ? `${action.affected_residents.toLocaleString()} residents`
      : action.capacity_at_stake != null
      ? `${action.capacity_at_stake.toLocaleString()} cap at stake`
      : null;

  return (
    <div
      className={`chat-action-card chat-action-card--${severity.toLowerCase()} ${
        isFocusedOnMap ? "chat-action-card--map-active" : ""
      } ${decision ? `chat-action-card--decided-${decision.decision.toLowerCase()}` : ""}`}
    >
      {/* Top bar: specialist agent source + interaction mode + severity + FROM -> TO focus */}
      <div className="chat-action-card__header">
        <div className="chat-action-card__badges">
          <span className={`chat-agent-pill ${agentMeta.colorClass}`}>
            {agentMeta.shortLabel}
          </span>
          <span className={`chat-severity-pill chat-severity-pill--${severity.toLowerCase()}`}>
            {severity}
          </span>
          <span className="chat-mode-pill">
            {action.interaction_mode === "SELECT_BETWEEN_OPTIONS"
              ? "Select Option"
              : action.interaction_mode === "APPROVAL_REQUIRED"
              ? "Approval Required"
              : "Action Item"}
          </span>
        </div>

        {onFocusLocation && (resolvedFromTo.from || resolvedFromTo.to) && (
          <button
            type="button"
            className={`chat-locate-btn ${isFocusedOnMap ? "chat-locate-btn--active" : ""}`}
            onClick={handleFocusFromTo}
            title="Auto-zoom and highlight FROM → TO connection on the map"
          >
            {isFocusedOnMap ? "◉ Highlighted on Map" : "⊕ Zoom FROM → TO"}
          </button>
        )}
      </div>

      {/* Explicit FROM -> TO Connection Strip */}
      {(resolvedFromTo.from || resolvedFromTo.to) && (
        <div
          className="chat-from-to-strip"
          onClick={handleFocusFromTo}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") handleFocusFromTo();
          }}
          title="Click to zoom map to FROM → TO connection"
        >
          {resolvedFromTo.from && (
            <span className="chat-from-to-node chat-from-node">
              <strong>FROM:</strong> {resolvedFromTo.from.label}
            </span>
          )}
          {resolvedFromTo.from && resolvedFromTo.to && (
            <span className="chat-from-to-arrow">
              ➔{" "}
              {resolvedFromTo.to.routeLabel ? (
                <small>{resolvedFromTo.to.routeLabel}</small>
              ) : null}
            </span>
          )}
          {resolvedFromTo.to && (
            <span className="chat-from-to-node chat-to-node">
              <strong>TO:</strong> {resolvedFromTo.to.label}
            </span>
          )}
        </div>
      )}

      {/* Title & summary */}
      <div className="chat-action-card__title-row">
        <h4 className="chat-action-card__title">{action.title}</h4>
        {popBadge && <span className="chat-action-card__pop">{popBadge}</span>}
      </div>

      <p className="chat-action-card__desc">{action.summary}</p>

      {/* Rationale & proposed change */}
      {!compactMapMode && (action.rationale || action.approval?.proposed_change) && (
        <div className="chat-action-card__rationale">
          {action.rationale && (
            <div>
              <strong>Rationale:</strong> {action.rationale}
            </div>
          )}
          {action.approval?.proposed_change && (
            <div>
              <strong>Proposed Change:</strong> {action.approval.proposed_change}
            </div>
          )}
        </div>
      )}

      {/* Grounded Attention Items */}
      {!compactMapMode &&
        Array.isArray(action.attention_items) &&
        action.attention_items.length > 0 && (
          <div className="chat-attention-list">
            {action.attention_items.map((item, idx) => (
              <div
                key={`${item.label}-${idx}`}
                className={`chat-attention-item ${
                  item.is_warning ? "chat-attention-item--high" : ""
                }`}
              >
                <div className="chat-attention-item__top">
                  {item.badge && (
                    <span className="chat-attention-item__cat">{item.badge}</span>
                  )}
                  <span className="chat-attention-item__title">{item.label}:</span>
                  <span className="chat-attention-item__summary">{item.value}</span>
                </div>
                {item.maps_uri && (
                  <div className="chat-maps-attribution">
                    <span>Google Maps</span> —{" "}
                    <a
                      href={item.maps_uri}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {item.maps_title || item.label}
                    </a>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

      {/* Option Selector (SELECT_BETWEEN_OPTIONS) */}
      {options.length > 0 && (
        <div className="chat-options-group" role="radiogroup" aria-label={action.title}>
          <div className="chat-options-group__label">
            Select an option ({options.length} available — updates map FROM → TO route):
          </div>
          {options.map((opt) => {
            const isSelected = activeOptionId === opt.option_id;
            const optFocus = extractFocusFromLocation(opt.location, action.action_id);
            const metricsEntries = opt.metrics ? Object.entries(opt.metrics) : [];
            const warnings = Array.isArray(opt.warnings) ? opt.warnings : [];
            return (
              <label
                key={opt.option_id}
                className={`chat-option-card ${
                  isSelected ? "chat-option-card--selected" : ""
                } ${opt.recommended ? "chat-option-card--recommended" : ""}`}
              >
                <div className="chat-option-card__top">
                  <input
                    type="radio"
                    name={`option-${compactMapMode ? "map" : "chat"}-${action.action_id}`}
                    value={opt.option_id}
                    checked={isSelected}
                    disabled={isDecided || busy}
                    onChange={() => handleOptionChange(opt.option_id)}
                  />
                  <span className="chat-option-card__title">{opt.label}</span>
                  {opt.recommended && (
                    <span className="chat-option-card__rec-badge">Recommended</span>
                  )}
                  {optFocus && onFocusLocation && (
                    <button
                      type="button"
                      className="chat-locate-btn chat-locate-btn--xs"
                      onClick={(e) => {
                        e.preventDefault();
                        handleOptionChange(opt.option_id);
                      }}
                    >
                      Zoom Route
                    </button>
                  )}
                </div>

                {opt.description && (
                  <p className="chat-option-card__desc">{opt.description}</p>
                )}

                {!compactMapMode && metricsEntries.length > 0 && (
                  <div className="chat-option-card__metrics">
                    {metricsEntries.map(([k, v]) => (
                      <span key={k}>
                        {k.replace(/_/g, " ")}: <strong>{String(v)}</strong>
                      </span>
                    ))}
                  </div>
                )}

                {warnings.length > 0 && (
                  <div className="chat-option-card__pros-cons">
                    {warnings.map((w: string, idx: number) => (
                      <span key={`w-${idx}`} className="chat-con-chip">
                        ⚠ {w}
                      </span>
                    ))}
                  </div>
                )}
              </label>
            );
          })}
        </div>
      )}

      {/* Decision Banner or Interactive Decision Buttons */}
      {isDecided && decision ? (
        <div
          className={`chat-decision-banner chat-decision-banner--${decision.decision.toLowerCase()}`}
        >
          <div className="chat-decision-banner__main">
            <span className="chat-decision-banner__badge">
              {decision.decision === "APPROVED"
                ? "✓ Approved"
                : decision.decision === "OPTION_SELECTED"
                ? "✓ Option Approved"
                : "✕ Rejected"}
            </span>
            <span className="chat-decision-banner__summary">
              {decision.applied_summary}
            </span>
          </div>
          <div className="chat-decision-banner__actions">
            <button
              type="button"
              className="chat-decision-change-btn"
              onClick={() => setEditingDecision(true)}
            >
              Change
            </button>
          </div>
        </div>
      ) : (
        <div className="chat-action-controls">
          {showNoteInput && (
            <div className="chat-action-note-row">
              <input
                type="text"
                className="chat-action-note-input"
                placeholder="Optional operator note or constraint (e.g., reserve 2 buses for dialysis)…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={busy}
              />
            </div>
          )}

          <div className="chat-action-buttons">
            <button
              type="button"
              className="chat-btn-approve"
              disabled={busy || (hasOptions && !activeOptionId)}
              onClick={() => handleConfirm(false)}
              title={
                selectedOption
                  ? `${confirmLabel}: ${selectedOption.label}`
                  : confirmLabel
              }
            >
              ✓ {confirmLabel}
            </button>

            <button
              type="button"
              className="chat-btn-approve-send"
              disabled={busy || (hasOptions && !activeOptionId)}
              onClick={() => handleConfirm(true)}
              title="Approve and ask the coordinator agent to update downstream plans"
            >
              ✓ Approve &amp; Ask Agent
            </button>

            <button
              type="button"
              className="chat-btn-reject"
              disabled={busy}
              onClick={() => handleReject(false)}
            >
              ✕ {rejectLabel}
            </button>

            {!compactMapMode && (
              <button
                type="button"
                className="chat-btn-note-toggle"
                onClick={() => setShowNoteInput((v) => !v)}
                title="Add an operator note"
              >
                {showNoteInput ? "Hide Note" : "+ Note"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

/* ============================================================================
 * 2. SPECIALIST AGENT OUTPUT SCHEMA VIEWER
 * ============================================================================ */

interface AgentSchemaOutputViewProps {
  output: AgentSchemaOutput;
  onFocusLocation?: (target: FocusLocationTarget) => void;
  defaultExpanded?: boolean;
}

function summarizeSchemaOutput(output: AgentSchemaOutput): string {
  const d = output.data || {};
  switch (output.schema_name) {
    case "RankPriorityTractsOutput": {
      const list = d.tracts || d.ranked_tracts || [];
      return `Ranked ${list.length} priority tracts in ${d.county || "county"} by zero-vehicle households, mobility disability, age 65+, and shelter access gaps.`;
    }
    case "PlanDestinationsOutput": {
      const plans = d.tract_plans || d.tract_assignments || [];
      return `Evaluated reachable shelter destinations (${d.max_drive_miles || 5} mi tier) for ${plans.length} priority tract(s) with Google Maps drive times.`;
    }
    case "VerifySheltersLiveOutput": {
      const v = d.verified_shelters || d.results || [];
      return `Cross-checked ${v.length} FEMA shelter record(s) against live Google Maps place data.`;
    }
    case "CountyGapReportOutput": {
      return `County-wide readiness gap synthesis across tracts, ADA shelter records, flood exposure, and HHS emPOWER medical power needs.`;
    }
    default:
      return `Structured ${output.schema_name} from ${output.tool_name}.`;
  }
}

export const AgentSchemaOutputView: React.FC<AgentSchemaOutputViewProps> = ({
  output,
  onFocusLocation,
  defaultExpanded = true,
}) => {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
  const agentMeta = getAgentMeta(output.agent_name);
  const data = output.data || {};
  const outputCounty =
    typeof data.county === "string"
      ? data.county.replace(/\s+County$/i, "").trim()
      : undefined;

  const renderSchemaBody = () => {
    switch (output.schema_name) {
      case "RankPriorityTractsOutput": {
        const ranked: any[] = Array.isArray(data.tracts)
          ? data.tracts
          : Array.isArray(data.ranked_tracts)
          ? data.ranked_tracts
          : [];
        const weights = data.weights_used || {};
        return (
          <div className="schema-body">
            {Object.keys(weights).length > 0 && (
              <div className="schema-weights-bar">
                <span className="schema-weights-bar__label">Active Weights:</span>
                {Object.entries(weights).map(([k, v]) => (
                  <span key={k} className="schema-weight-chip">
                    {k.replace(/_/g, " ")}: <strong>{Math.round(Number(v) * 100)}%</strong>
                  </span>
                ))}
              </div>
            )}
            <div className="schema-tract-list">
              {ranked.slice(0, 6).map((t, idx) => {
                const geoid = t.geo_id || t.geoid;
                const noVeh = t.hh_no_vehicle ?? t.no_vehicle_hh ?? 0;
                const elderly = t.pop_65_plus ?? t.elderly_pop ?? 0;
                const disPct =
                  t.pct_mobility_disability != null
                    ? `${t.pct_mobility_disability}% mobility dis.`
                    : `${t.disability_pop ?? 0} dis.`;
                return (
                  <div key={geoid || idx} className="schema-tract-row">
                    <div className="schema-tract-row__left">
                      <span className="schema-rank-badge">#{t.rank ?? idx + 1}</span>
                      <div>
                        <div className="schema-tract-row__title">
                          Tract {geoid}{" "}
                          <span className="schema-score-pill">
                            Score {(Number(t.priority_score || 0) * 100).toFixed(0)}
                          </span>
                        </div>
                        <div className="schema-tract-row__meta">
                          📊 {Number(noVeh).toLocaleString()} no-vehicle HH ·{" "}
                          {Number(elderly).toLocaleString()} age 65+ · 🧮 {disPct} · 📏{" "}
                          {t.nearest_shelter_miles ?? "?"} mi to shelter
                        </div>
                      </div>
                    </div>
                    {onFocusLocation && geoid && (
                      <button
                        type="button"
                        className="chat-locate-btn chat-locate-btn--xs"
                        onClick={() =>
                          onFocusLocation({
                            kind: "tract",
                            id: String(geoid),
                            county:
                              (typeof t.county_name === "string"
                                ? t.county_name.replace(/\s+County$/i, "").trim()
                                : undefined) || outputCounty,
                            label: `Tract ${geoid}`,
                            latitude: typeof t.lat === "number" ? t.lat : undefined,
                            longitude: typeof t.lon === "number" ? t.lon : undefined,
                            fromLat: typeof t.lat === "number" ? t.lat : undefined,
                            fromLng: typeof t.lon === "number" ? t.lon : undefined,
                            fromLabel: `Tract ${geoid}`,
                          })
                        }
                      >
                        Zoom Map
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      }

      case "PlanDestinationsOutput":
      case "ReachabilityRulesOutput": {
        const plans: any[] = Array.isArray(data.tract_plans)
          ? data.tract_plans
          : Array.isArray(data.tract_assignments)
          ? data.tract_assignments
          : [];
        return (
          <div className="schema-body">
            <div className="schema-rule-banner">
              <span>
                Short-Drive Threshold: <strong>{data.max_drive_miles ?? 5.0} mi</strong>
              </span>
              <span>Walk Threshold: 1.0 mi</span>
            </div>
            <div className="schema-assignment-list">
              {plans.slice(0, 5).map((p, idx) => {
                const cands: any[] = Array.isArray(p.short_drive_shelters_5mi)
                  ? p.short_drive_shelters_5mi
                  : [];
                const primary = cands[0] || p.primary_shelter;
                return (
                  <div key={p.tract_geoid || idx} className="schema-assignment-row">
                    <div className="schema-assignment-row__main">
                      <div>
                        <strong>Tract {p.tract_geoid}</strong> (
                        {p.hh_no_vehicle ?? p.no_vehicle_hh ?? 0} no-veh HH)
                        {" → "}
                        {primary ? (
                          <span className="schema-shelter-target">
                            {primary.shelter_name || primary.name} (🚗{" "}
                            {primary.live_driving_distance_miles ??
                              primary.straight_line_miles ??
                              primary.distance_miles}{" "}
                            mi
                            {primary.live_driving_duration_minutes
                              ? ` / ${primary.live_driving_duration_minutes} min`
                              : ""}{" "}
                            · Cap {primary.evacuation_capacity ?? "❓"} · ADA:{" "}
                            {primary.wheelchair_accessible ?? primary.ada ?? "UNRECORDED"})
                          </span>
                        ) : (
                          <span className="schema-shelter-none">
                            No reachable shelter within threshold
                          </span>
                        )}
                      </div>
                      {Array.isArray(p.routing_caveats) && p.routing_caveats.length > 0 && (
                        <div className="schema-tract-row__meta">
                          ⚠ {p.routing_caveats[0]}
                        </div>
                      )}
                    </div>
                    {onFocusLocation && (
                      <div className="schema-assignment-row__btns">
                        <button
                          type="button"
                          className="chat-locate-btn chat-locate-btn--xs"
                          onClick={() =>
                            onFocusLocation({
                              kind: "action",
                              id: String(p.tract_geoid),
                              county: outputCounty,
                              label: `Tract ${p.tract_geoid} → ${
                                primary?.shelter_name || primary?.name || "Shelter"
                              }`,
                              fromLat:
                                typeof p.tract_lat === "number" ? p.tract_lat : undefined,
                              fromLng:
                                typeof p.tract_lon === "number" ? p.tract_lon : undefined,
                              fromLabel: `Tract ${p.tract_geoid}`,
                              toLat:
                                typeof primary?.latitude === "number"
                                  ? primary.latitude
                                  : undefined,
                              toLng:
                                typeof primary?.longitude === "number"
                                  ? primary.longitude
                                  : undefined,
                              toLabel: primary?.shelter_name || primary?.name,
                            })
                          }
                        >
                          Zoom FROM → TO
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      }

      case "VerifySheltersLiveOutput": {
        const results: any[] = Array.isArray(data.verified_shelters)
          ? data.verified_shelters
          : Array.isArray(data.results)
          ? data.results
          : [];
        return (
          <div className="schema-body">
            <div className="schema-kpi-grid">
              <div className="schema-kpi">
                <span>Shelters Checked Live</span>
                <strong>{data.shelters_checked ?? results.length}</strong>
              </div>
              <div className="schema-kpi">
                <span>Discrepancies Flagged</span>
                <strong>
                  {results.filter((r) => r.discrepancy_flagged).length}
                </strong>
              </div>
            </div>
            <div className="schema-verify-list">
              {results.slice(0, 6).map((r, idx) => {
                const status = r.verified_status || "CHECKED";
                const name = r.fema_shelter_name || r.fema_name || "Shelter";
                const uri = r.maps_place_uri || r.live_verification?.google_maps_uri;
                const placeTitle =
                  r.maps_place_title || r.live_verification?.matched_place_name || name;
                return (
                  <div key={r.shelter_id || idx} className="schema-verify-row">
                    <div className="schema-verify-row__top">
                      <span
                        className={`schema-verify-status ${
                          status === "OPEN" ? "schema-verify-status--operational" : ""
                        }`}
                      >
                        {status}
                      </span>
                      <strong>{name}</strong>
                      <span className="schema-verify-meta">
                        ADA: {r.fema_wheelchair_accessible ?? r.ada ?? "UNRECORDED"} · Gen:{" "}
                        {r.fema_generator_onsite ?? r.generator ?? "UNRECORDED"} · Cap:{" "}
                        {r.fema_evacuation_capacity ?? r.evacuation_capacity ?? "❓"}
                      </span>
                      {onFocusLocation && r.shelter_id != null && (
                        <button
                          type="button"
                          className="chat-locate-btn chat-locate-btn--xs"
                          onClick={() =>
                            onFocusLocation({
                              kind: "shelter",
                              id: String(r.shelter_id),
                              county: outputCounty,
                              label: name,
                            })
                          }
                        >
                          Zoom Map
                        </button>
                      )}
                    </div>
                    {r.live_finding && (
                      <div className="schema-tract-row__meta">{r.live_finding}</div>
                    )}
                    {uri && (
                      <div className="chat-maps-attribution">
                        <span>Google Maps</span> —{" "}
                        <a href={uri} target="_blank" rel="noopener noreferrer">
                          {placeTitle}
                        </a>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      }

      case "CountyGapReportOutput":
      default: {
        const noWalk = data.evacuation_zone_tracts_with_no_shelter_within_1_mile || {};
        const med = data.medical_and_power_dependence || {};
        const unrec = data.what_the_record_cannot_tell_us || {};
        return (
          <div className="schema-body">
            <div className="schema-kpi-grid">
              {noWalk.tracts != null && (
                <div className="schema-kpi">
                  <span>Tracts &gt;1 mi from Shelter</span>
                  <strong>{noWalk.tracts}</strong>
                </div>
              )}
              {noWalk.households_no_vehicle != null && (
                <div className="schema-kpi">
                  <span>Zero-Vehicle HH Exposed</span>
                  <strong>{Number(noWalk.households_no_vehicle).toLocaleString()}</strong>
                </div>
              )}
              {med.power_dependent_residents != null && (
                <div className="schema-kpi">
                  <span>⚡ emPOWER DME</span>
                  <strong>{Number(med.power_dependent_residents).toLocaleString()}</strong>
                </div>
              )}
              {unrec.wheelchair_unrecorded != null && (
                <div className="schema-kpi">
                  <span>❓ Unrecorded ADA</span>
                  <strong>
                    {unrec.wheelchair_unrecorded} / {unrec.total_shelters ?? "?"}
                  </strong>
                </div>
              )}
            </div>
          </div>
        );
      }
    }
  };

  return (
    <div className="chat-schema-card">
      <button
        type="button"
        className="chat-schema-card__header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <div className="chat-schema-card__header-left">
          <span className={`chat-agent-pill ${agentMeta.colorClass}`}>
            {agentMeta.label}
          </span>
          <span className="chat-schema-name-pill">{output.schema_name}</span>
        </div>
        <span className="chat-schema-card__toggle">{expanded ? "▾" : "▸"}</span>
      </button>

      <div className="chat-schema-card__summary">
        {summarizeSchemaOutput(output)}
      </div>

      {expanded && renderSchemaBody()}
    </div>
  );
};
