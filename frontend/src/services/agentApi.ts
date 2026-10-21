import sampleBrief from "../mocks/sampleBrief.json";
import {
  BigQueryTableRowsResponse,
  BigQueryTablesOverviewResponse,
  SAMPLE_BQ_OVERVIEW,
  SAMPLE_BQ_ROWS,
} from "../mocks/sampleBigQueryTables";
import {
  ActionDecisionRecord,
  ActionDecisionStatus,
  AgentSchemaOutput,
  AreaInspectResponse,
  ChatResponse,
  CountyMapPointsResponse,
  MapsGroundingChunk,
  ReadinessBriefData,
  RecommendedAction,
} from "../types/brief";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";
export const DEPLOYED_CLOUD_RUN_URL =
  "https://evac-readiness-agent-861336771001.us-east1.run.app";

const TOOL_SCHEMA_MAP: Record<string, { agent_name: string; schema_name: string }> = {
  rank_priority_tracts: { agent_name: "prioritization_agent", schema_name: "RankPriorityTractsOutput" },
  priority_weights: { agent_name: "prioritization_agent", schema_name: "PriorityWeightsOutput" },
  equity_audit: { agent_name: "prioritization_agent", schema_name: "EquityAuditOutput" },
  get_vulnerable_tracts: { agent_name: "prioritization_agent", schema_name: "RankPriorityTractsOutput" },
  plan_evacuation_destinations: { agent_name: "destination_agent", schema_name: "PlanDestinationsOutput" },
  reachability_rules: { agent_name: "destination_agent", schema_name: "ReachabilityRulesOutput" },
  verify_shelters_live: { agent_name: "verification_agent", schema_name: "VerifySheltersLiveOutput" },
  data_quality_report: { agent_name: "verification_agent", schema_name: "DataQualityReportOutput" },
  record_shelter_assessment: { agent_name: "verification_agent", schema_name: "RecordShelterAssessmentOutput" },
  county_gap_report: { agent_name: "evac_readiness_coordinator", schema_name: "CountyGapReportOutput" },
  find_shelters: { agent_name: "evac_readiness_coordinator", schema_name: "FindSheltersOutput" },
  analyze_shelter_readiness: { agent_name: "evac_readiness_coordinator", schema_name: "FindSheltersOutput" },
  get_power_and_medical_gaps: { agent_name: "evac_readiness_coordinator", schema_name: "CountyGapReportOutput" },
  generate_readiness_brief: { agent_name: "evac_readiness_coordinator", schema_name: "ReadinessBriefOutput" },
};

export async function fetchReadinessBrief(_state: string, _county: string): Promise<ReadinessBriefData> {
  // Returns the structured baseline brief immediately while the live agent chat handles ad-hoc queries
  return sampleBrief as ReadinessBriefData;
}

function extractMapsSourcesRecursive(
  obj: unknown,
  seenUris: Set<string>,
  out: MapsGroundingChunk[]
): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) extractMapsSourcesRecursive(item, seenUris, out);
    return;
  }
  const rec = obj as Record<string, unknown>;
  if (Array.isArray(rec.google_maps_sources)) {
    for (const src of rec.google_maps_sources) {
      if (src && typeof src === "object") {
        const s = src as Record<string, unknown>;
        const uri = typeof s.uri === "string" ? s.uri : "";
        if (uri && !seenUris.has(uri)) {
          seenUris.add(uri);
          out.push({
            place_id: (s.place_id as string) || (s.placeId as string) || null,
            title: (s.title as string) || "Google Maps Place",
            uri,
          });
        }
      }
    }
  }
  if (rec.maps && typeof rec.maps === "object") {
    const m = rec.maps as Record<string, unknown>;
    const uri = typeof m.uri === "string" ? m.uri : "";
    if (uri && !seenUris.has(uri)) {
      seenUris.add(uri);
      out.push({
        place_id: (m.placeId as string) || (m.place_id as string) || null,
        title: (m.title as string) || "Google Maps Place",
        uri,
      });
    }
  }
  for (const val of Object.values(rec)) {
    extractMapsSourcesRecursive(val, seenUris, out);
  }
}

function extractRecommendedActionsRecursive(
  obj: unknown,
  actionsById: Map<string, RecommendedAction>
): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) extractRecommendedActionsRecursive(item, actionsById);
    return;
  }
  const rec = obj as Record<string, unknown>;
  if (Array.isArray(rec.recommended_actions)) {
    for (const raw of rec.recommended_actions) {
      if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).action_id === "string") {
        const act = raw as RecommendedAction;
        actionsById.set(act.action_id, act);
      }
    }
  }
  if (rec.recommended_action && typeof rec.recommended_action === "object") {
    const act = rec.recommended_action as RecommendedAction;
    if (typeof act.action_id === "string") {
      actionsById.set(act.action_id, act);
    }
  }
  for (const val of Object.values(rec)) {
    extractRecommendedActionsRecursive(val, actionsById);
  }
}

function extractAgentOutputsRecursive(
  obj: unknown,
  outputs: AgentSchemaOutput[],
  seenKeys: Set<string>
): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) extractAgentOutputsRecursive(item, outputs, seenKeys);
    return;
  }
  const rec = obj as Record<string, unknown>;
  if (rec.functionResponse && typeof rec.functionResponse === "object") {
    const fnResp = rec.functionResponse as Record<string, unknown>;
    const fnName = typeof fnResp.name === "string" ? fnResp.name : "";
    let rawData = fnResp.response as Record<string, unknown> | undefined;
    if (rawData && typeof rawData === "object" && rawData.result && typeof rawData.result === "object") {
      rawData = rawData.result as Record<string, unknown>;
    }
    const meta = TOOL_SCHEMA_MAP[fnName];
    if (meta && rawData && typeof rawData === "object") {
      const key = `${fnName}:${JSON.stringify(rawData).length}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        outputs.push({
          agent_name: meta.agent_name,
          tool_name: fnName,
          schema_name: meta.schema_name,
          data: rawData,
        });
      }
    }
  }
  for (const val of Object.values(rec)) {
    extractAgentOutputsRecursive(val, outputs, seenKeys);
  }
}

/**
 * Ensures every agent response has structured `recommended_actions` (Approve, Reject, Select between options)
 * and `agent_outputs` based on the specialist agent/tool schemas, even if the remote Cloud Run ADK instance
 * returns raw tool responses or narrative text without `recommended_actions` pre-populated.
 */
export function ensureStructuredAgentPayload(
  res: ChatResponse,
  countyName: string
): ChatResponse {
  const county = countyName || res.county || "Lee";
  const actions: RecommendedAction[] = [...(res.recommended_actions || [])];
  const outputs: AgentSchemaOutput[] = [...(res.agent_outputs || [])];
  const tools = res.tools_called || [];
  const replyLower = (res.reply || "").toLowerCase();

  if (actions.length > 0) {
    return { ...res, recommended_actions: actions, agent_outputs: outputs };
  }

  // Synthesize from structured `outputs` if present
  for (const out of outputs) {
    const d = out.data || {};
    if (out.tool_name === "rank_priority_tracts" || out.tool_name === "get_vulnerable_tracts") {
      const tracts = Array.isArray(d.tracts) ? d.tracts : [];
      if (tracts.length > 0) {
        const top = tracts[0];
        const gid = String(top.geo_id || "12071001602");
        const hhNv = Number(top.hh_no_vehicle ?? top.households_no_vehicle ?? 263);
        const pop = Number(top.total_pop ?? 2673);
        const nearMi = top.nearest_shelter_miles ?? top.nearest_any_shelter_km ?? 1.8;
        actions.push({
          action_id: `q1_bus_pickup_${gid}`,
          action_type: "ORGANIZE_BUS_PICKUP",
          interaction_mode: "APPROVAL_REQUIRED",
          severity: "CRITICAL",
          title: `Stage transit pickup for Tract ${gid} (${hhNv.toLocaleString()} no-vehicle households)`,
          summary: `Rank #1 priority tract in ${county} County (${pop.toLocaleString()} residents) has ${hhNv.toLocaleString()} households with no vehicle and ${Number(top.n_within_walk ?? 0)} shelters within 1 mi walk.`,
          rationale: "Households without vehicles beyond the 1-mile walking threshold require pre-positioned municipal bus pickup points before evacuation order.",
          source_agent: "prioritization_agent",
          source_tool: out.tool_name,
          location: {
            lat: typeof top.lat === "number" ? top.lat : null,
            lon: typeof top.lon === "number" ? top.lon : null,
            label: `Census Tract ${gid}`,
            county,
            tract_geoid: gid,
          },
          from_location: {
            lat: typeof top.lat === "number" ? top.lat : null,
            lon: typeof top.lon === "number" ? top.lon : null,
            label: `Pickup Origin: Tract ${gid}`,
            county,
            tract_geoid: gid,
          },
          affected_households: hhNv,
          affected_residents: pop,
          attention_items: [
            { label: "No-Vehicle Households", value: `${hhNv.toLocaleString()} HH`, badge: "📊 ACS", is_warning: true },
            { label: "Nearest Shelter", value: `${nearMi} mi`, badge: "🕰️ FEMA", is_warning: true },
          ],
          requires_approval: true,
          approval: {
            confirm_label: "Approve Bus Staging",
            reject_label: "Defer Staging",
            proposed_change: `Assign municipal transit pickup for Tract ${gid} (${hhNv.toLocaleString()} households)`,
            target_entity_type: "tract",
            target_entity_id: gid,
            payload: { tract_geoid: gid, hh_no_vehicle: hhNv },
            irreversible_or_high_impact: true,
          },
        });
      }
    } else if (out.tool_name === "plan_evacuation_destinations") {
      const plans = Array.isArray(d.tract_plans) ? d.tract_plans : [];
      for (const p of plans.slice(0, 2)) {
        const gid = String(p.tract_geoid || "");
        const cands = [
          ...(Array.isArray(p.walk_tier_shelters_1mi) ? p.walk_tier_shelters_1mi : []),
          ...(Array.isArray(p.short_drive_shelters_5mi) ? p.short_drive_shelters_5mi : []),
        ];
        if (!gid || cands.length === 0) continue;
        const opts = cands.slice(0, 3).map((c: any, idx: number) => ({
          option_id: `shelter_${c.shelter_id || idx}`,
          label: `${c.shelter_name || "Shelter"} (${c.city || county})`,
          description: `${c.live_driving_distance_miles ?? c.straight_line_miles ?? "?"} mi${c.live_driving_duration_minutes ? ` · ${c.live_driving_duration_minutes} min drive` : ""} · Cap ${Number(c.evacuation_capacity || 0).toLocaleString()} · ADA: ${c.wheelchair_accessible || "UNRECORDED"}`,
          recommended: idx === 0,
          location: {
            lat: typeof c.latitude === "number" ? c.latitude : null,
            lon: typeof c.longitude === "number" ? c.longitude : null,
            label: c.shelter_name,
            address: c.address,
            city: c.city,
            county,
            shelter_id: Number(c.shelter_id) || null,
          },
          metrics: {
            capacity: c.evacuation_capacity,
            wheelchair: c.wheelchair_accessible || "UNRECORDED",
            drive_minutes: c.live_driving_duration_minutes,
          },
          warnings: c.wheelchair_accessible === "UNRECORDED" ? ["Wheelchair access UNRECORDED in FEMA registry"] : [],
        }));
        actions.push({
          action_id: `q2_select_dest_${gid}`,
          action_type: "SELECT_TRACT_DESTINATION",
          interaction_mode: "SELECT_BETWEEN_OPTIONS",
          severity: "HIGH",
          title: `Select primary receiving shelter for Tract ${gid}`,
          summary: `Choose between ${opts.length} reachable candidate shelters for Tract ${gid} in ${county} County.`,
          rationale: "Locking a primary receiving shelter prevents overcrowding and directs ADA transit to verified facilities.",
          source_agent: "destination_agent",
          source_tool: "plan_evacuation_destinations",
          location: {
            lat: typeof p.tract_lat === "number" ? p.tract_lat : null,
            lon: typeof p.tract_lon === "number" ? p.tract_lon : null,
            label: `Tract ${gid}`,
            county,
            tract_geoid: gid,
          },
          from_location: {
            lat: typeof p.tract_lat === "number" ? p.tract_lat : 26.6345,
            lon: typeof p.tract_lon === "number" ? p.tract_lon : -81.8602,
            label: `Origin: Tract ${gid}`,
            county,
            tract_geoid: gid,
          },
          to_location: opts[0]?.location || null,
          requires_selection: true,
          requires_approval: true,
          options: opts,
          selected_option_id: opts[0]?.option_id || null,
          approval: {
            confirm_label: "Approve Selected Destination",
            reject_label: "Reject Routing",
            proposed_change: `Assign primary evacuation destination for Tract ${gid}`,
            target_entity_type: "tract",
            target_entity_id: gid,
          },
        });
      }
    }
  }

  return {
    ...res,
    recommended_actions: actions,
    agent_outputs: outputs,
  };
}

export async function submitActionDecision(params: {
  action_id: string;
  decision: ActionDecisionStatus;
  selected_option_id?: string | null;
  selected_option_label?: string | null;
  note?: string | null;
  county?: string;
  session_id?: string;
  action?: RecommendedAction;
}): Promise<ActionDecisionRecord> {
  try {
    const res = await fetch(`${API_BASE}/api/chat/action-decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Fallback to client-side decision synthesis if backend is offline
  }

  const nowIso = new Date().toISOString();
  const title = params.action?.title || params.action_id;
  const proposed = params.action?.approval?.proposed_change || title;
  const optLabel = params.selected_option_label || params.selected_option_id;

  let applied_summary = "";
  let follow_up_prompt = "";
  if (params.decision === "APPROVED") {
    applied_summary = `Approved: ${proposed}${optLabel ? ` (Option: ${optLabel})` : ""}.`;
    follow_up_prompt = `I have APPROVED action "${title}"${optLabel ? ` with option "${optLabel}"` : ""} for ${params.county || "Lee"} County.${params.note ? ` Note: ${params.note}.` : ""} Please update the readiness plan and advise the next step.`;
  } else if (params.decision === "REJECTED") {
    applied_summary = `Rejected / Deferred: ${title}.`;
    follow_up_prompt = `I have REJECTED / DEFERRED action "${title}" for ${params.county || "Lee"} County.${params.note ? ` Reason: ${params.note}.` : ""} Please suggest an alternative mitigation.`;
  } else {
    applied_summary = `Selected option "${optLabel}" for ${title}.`;
    follow_up_prompt = `For "${title}" in ${params.county || "Lee"} County, I selected option "${optLabel}".${params.note ? ` Note: ${params.note}.` : ""} Please proceed with this selection.`;
  }

  return {
    action_id: params.action_id,
    decision: params.decision,
    selected_option_id: params.selected_option_id,
    selected_option_label: params.selected_option_label,
    decided_at: nowIso,
    note: params.note,
    applied_summary,
    follow_up_prompt,
  };
}

export type AgentProgress = { type: "step" | "step_done"; tool: string };

/**
 * Streams progress from /api/chat/stream so the UI can show what the agent is doing, then resolves
 * with the final answer. Falls back to the one-shot sendAgentMessage if streaming is unavailable.
 */
export async function streamAgentMessage(
  message: string,
  state: string,
  county: string,
  sessionId: string,
  onProgress: (p: AgentProgress) => void
): Promise<ChatResponse> {
  const contextualMessage = `[Pre-season planning context: ${county} County, ${state}] ${message}`;
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: contextualMessage, state, county, session_id: sessionId }),
    });
  } catch {
    return sendAgentMessage(message, state, county, sessionId);
  }
  if (!response.ok || !response.body) return sendAgentMessage(message, state, county, sessionId);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const ev = JSON.parse(line.slice(5).trim());
      if (ev.type === "step" || ev.type === "step_done") onProgress(ev);
      else if (ev.type === "error") throw new Error(ev.message);
      else if (ev.type === "final") {
        return ensureStructuredAgentPayload(
          {
            reply: ev.reply,
            county,
            state,
            tools_called: ev.tools_called,
            elapsed_seconds: ev.elapsed_seconds,
            grounding_chunks: ev.grounding_chunks || [],
            recommended_actions: ev.recommended_actions || [],
            agent_outputs: ev.agent_outputs || [],
          },
          county
        );
      }
    }
  }
  throw new Error("The connection closed before an answer arrived. Please try again.");
}

export async function sendAgentMessage(
  message: string,
  state: string,
  county: string,
  sessionId = "manager-session-01"
): Promise<ChatResponse> {
  const contextualMessage = `[Pre-season planning context: ${county} County, ${state}] ${message}`;
  // 1. Try local FastAPI backend (/api/chat) which proxies to Cloud Run evac_agent
  try {
    const response = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: contextualMessage,
        state,
        county,
        session_id: sessionId,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as ChatResponse;
      return ensureStructuredAgentPayload(data, county);
    }
  } catch {
    // Fall through to Vite proxy -> Cloud Run ADK service
  }

  // 2. Fallback: Call Cloud Run ADK service directly via Vite proxy (/adk-cloud-run)
  const t0 = performance.now();
  const userId = "emergency-manager";
  const appName = "evac_agent";

  await fetch(
    `/adk-cloud-run/apps/${appName}/users/${userId}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }
  );

  const runRes = await fetch(`/adk-cloud-run/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appName,
      userId,
      sessionId,
      newMessage: {
        role: "user",
        parts: [{ text: contextualMessage }],
      },
    }),
  });

  if (!runRes.ok) {
    const errText = await runRes.text();
    throw new Error(`Cloud Run ADK error (${runRes.status}): ${errText}`);
  }

  const events = (await runRes.json()) as Array<Record<string, unknown>>;
  const toolsCalled: string[] = [];
  const texts: string[] = [];
  const groundingChunks: MapsGroundingChunk[] = [];
  const seenUris = new Set<string>();
  const actionsById = new Map<string, RecommendedAction>();
  const agentOutputs: AgentSchemaOutput[] = [];
  const seenOutputKeys = new Set<string>();

  for (const ev of events) {
    const content = (ev.content as Record<string, unknown>) || {};
    const parts = (content.parts as Array<Record<string, unknown>>) || [];
    for (const part of parts) {
      if (part.functionCall && typeof part.functionCall === "object") {
        const fnName = (part.functionCall as Record<string, unknown>).name;
        if (typeof fnName === "string" && !toolsCalled.includes(fnName)) {
          toolsCalled.push(fnName);
        }
      } else if (typeof part.text === "string" && !part.thought) {
        texts.push(part.text);
      }
    }
    extractMapsSourcesRecursive(ev, seenUris, groundingChunks);
    extractRecommendedActionsRecursive(ev, actionsById);
    extractAgentOutputsRecursive(ev, agentOutputs, seenOutputKeys);
  }

  const elapsedSeconds = Number(((performance.now() - t0) / 1000).toFixed(1));

  return ensureStructuredAgentPayload(
    {
      reply: texts.length ? texts[texts.length - 1].trim() : "No response generated.",
      county,
      state,
      tools_called: toolsCalled,
      elapsed_seconds: elapsedSeconds,
      agent_url: DEPLOYED_CLOUD_RUN_URL,
      grounding_chunks: groundingChunks,
      recommended_actions: Array.from(actionsById.values()),
      agent_outputs: agentOutputs,
    },
    county
  );
}

export async function fetchBigQueryTablesOverview(): Promise<BigQueryTablesOverviewResponse> {
  try {
    const res = await fetch(`${API_BASE}/api/admin/tables`);
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Fallback to preview dataset when backend or BigQuery auth is offline
  }
  return SAMPLE_BQ_OVERVIEW;
}

export async function fetchBigQueryTableRows(params: {
  tableName: string;
  limit?: number;
  offset?: number;
  county?: string;
  search?: string;
  quickFilter?: string;
}): Promise<BigQueryTableRowsResponse> {
  const { tableName, limit = 50, offset = 0, county = "", search = "", quickFilter = "" } = params;
  const qs = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  if (county) qs.set("county", county);
  if (search) qs.set("search", search);
  if (quickFilter) qs.set("quick_filter", quickFilter);

  try {
    const res = await fetch(`${API_BASE}/api/admin/tables/${encodeURIComponent(tableName)}/rows?${qs.toString()}`);
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Fallback to local sample rows when backend or BigQuery auth is offline
  }

  const tableMeta = SAMPLE_BQ_OVERVIEW.tables.find((t) => t.table_name === tableName);
  let rows = [...(SAMPLE_BQ_ROWS[tableName] || [])];

  if (search.trim()) {
    const q = search.trim().toLowerCase();
    rows = rows.filter((r) =>
      Object.values(r).some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(q))
    );
  }

  if (quickFilter) {
    if (tableName === "shelters") {
      if (quickFilter === "ada_unrecorded") rows = rows.filter((r) => r.wheelchair_accessible === null);
      if (quickFilter === "ada_yes") rows = rows.filter((r) => r.wheelchair_accessible === true);
      if (quickFilter === "ada_no") rows = rows.filter((r) => r.wheelchair_accessible === false);
      if (quickFilter === "medical") rows = rows.filter((r) => r.is_medical === true);
      if (quickFilter === "surge") rows = rows.filter((r) => r.in_surge_slosh_area === true);
    } else if (tableName === "vulnerability_tracts") {
      if (quickFilter === "high_no_vehicle") rows = rows.filter((r) => Number(r.pct_no_vehicle || 0) >= 15);
      if (quickFilter === "high_disability") rows = rows.filter((r) => Number(r.pct_disability || 0) >= 20);
    } else if (tableName === "power_dependent_counties") {
      if (quickFilter === "censored") rows = rows.filter((r) => r.power_dependent_is_censored === true);
    }
  }

  const whereParts: string[] = [];
  if (quickFilter === "ada_unrecorded") whereParts.push("wheelchair_accessible IS NULL");
  if (quickFilter === "ada_yes") whereParts.push("wheelchair_accessible IS TRUE");
  if (quickFilter === "ada_no") whereParts.push("wheelchair_accessible IS FALSE");
  if (quickFilter === "medical") whereParts.push("is_medical IS TRUE");
  if (quickFilter === "surge") whereParts.push("in_surge_slosh_area IS TRUE");
  if (quickFilter === "censored") whereParts.push("power_dependent_is_censored IS TRUE");
  if (search.trim()) whereParts.push(`/* search: '${search.trim()}' */`);

  const whereClause = whereParts.length ? `WHERE ${whereParts.join(" AND ")} ` : "";
  const sql = `SELECT * FROM \`${SAMPLE_BQ_OVERVIEW.project}.${SAMPLE_BQ_OVERVIEW.dataset}.${tableName}\` ${whereClause}LIMIT ${limit} OFFSET ${offset}`;

  return {
    connected: false,
    table_name: tableName,
    project: SAMPLE_BQ_OVERVIEW.project,
    dataset: SAMPLE_BQ_OVERVIEW.dataset,
    total_matching_rows: rows.length,
    limit,
    offset,
    executed_sql: sql,
    columns: tableMeta?.columns || [],
    rows: rows.slice(offset, offset + limit),
  };
}

export async function fetchCountyMapPoints(county: string): Promise<CountyMapPointsResponse> {
  const res = await fetch(`${API_BASE}/api/area/map-points?county=${encodeURIComponent(county)}`);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to fetch map points (${res.status}): ${errText}`);
  }
  return res.json();
}

export async function fetchAreaInspection(params: {
  lat: number;
  lng: number;
  radiusKm?: number;
  includeMaps?: boolean;
}): Promise<AreaInspectResponse> {
  const { lat, lng, radiusKm = 15, includeMaps = true } = params;
  const qs = new URLSearchParams({
    lat: String(lat),
    lng: String(lng),
    radius_km: String(radiusKm),
    include_maps: String(includeMaps),
  });
  const res = await fetch(`${API_BASE}/api/area/inspect?${qs.toString()}`);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to inspect area (${res.status}): ${errText}`);
  }
  return res.json();
}


