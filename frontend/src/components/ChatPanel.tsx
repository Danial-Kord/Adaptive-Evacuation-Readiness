import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AgentProgress,
  buildStarterAgentBriefing,
  DEPLOYED_CLOUD_RUN_URL,
  streamAgentMessage,
  submitActionDecision,
} from "../services/agentApi";
import {
  GeminiLiveSession,
  LiveTurnResult,
  LiveVoiceStatus,
} from "../services/geminiLive";
import {
  ActionDecisionRecord,
  ActionDecisionStatus,
  AgentSchemaOutput,
  MapsGroundingChunk,
  RecommendedAction,
} from "../types/brief";
import {
  AgentSchemaOutputView,
  FocusLocationTarget,
  RecommendedActionCard,
} from "./AgentSchemaCards";
import { DashboardData } from "../services/dashboardData";
import { MapsAttribution } from "./MapsAttribution";

export interface ExternalDecisionTrigger {
  id: number;
  action: RecommendedAction;
  decision: ActionDecisionStatus;
  selectedOptionId?: string;
  note?: string;
  sendFollowUp?: boolean;
}

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  tools_called?: string[];
  elapsed_seconds?: number;
  grounding_chunks?: MapsGroundingChunk[];
  recommended_actions?: RecommendedAction[];
  agent_outputs?: AgentSchemaOutput[];
}

interface ChatPanelProps {
  stateCode?: string;
  county?: string;
  compact?: boolean;
  suggestedQuestion?: { text: string; id: number; send?: boolean } | null;
  onFocusLocation?: (target: FocusLocationTarget) => void;
  dashboardData?: DashboardData | null;
  sharedDecisions?: Record<string, ActionDecisionRecord>;
  onSharedDecisionsChange?: React.Dispatch<
    React.SetStateAction<Record<string, ActionDecisionRecord>>
  >;
  selectedOptionsByAction?: Record<string, string>;
  onSelectActionOption?: (actionId: string, optionId: string) => void;
  activeActionId?: string | null;
  onActiveActionChange?: (actionId: string | null) => void;
  onActionsSync?: (actions: RecommendedAction[]) => void;
  externalDecisionTrigger?: ExternalDecisionTrigger | null;
}

type WidgetTab = "chat" | "actions" | "schemas";
type ActionFilter = "all" | "pending" | "decided";

const SUGGESTED_QUESTIONS = [
  "Which neighborhoods in Lee County would struggle most to self-evacuate?",
  "How many people in Lee County depend on electricity for medical equipment?",
  "Where would I send the households without a car in tract 12071020801, and how long is the drive?",
  "Which shelters in Lee County can take a wheelchair, and how many are unrecorded?",
  "Check if the shelters near North Fort Myers are still open on Google Maps.",
  "Run an equity audit for Lee County evacuation zones.",
  "Give me the full pre-season readiness brief for Lee County.",
];

/** What each agent step means, in the manager's words. */
const STEP_LABELS: Record<string, string> = {
  prioritization_agent: "Ranking neighborhoods by who would struggle to leave",
  destination_agent: "Finding shelters people can reach, with drive times from Google Maps",
  verification_agent: "Checking shelter records against Google Maps",
  evac_readiness_coordinator: "Coordinating multi-agent readiness brief",
  county_gap_report: "Listing what to fix before the season",
  rank_priority_tracts: "Scoring census tracts by vulnerability & SVI",
  plan_destinations_for_tracts: "Matching tracts to reachable shelters",
  verify_shelters_live: "Verifying shelter status on Google Maps",
  shelter_data_quality_report: "Auditing unrecorded (❓) shelter fields",
  execute_sql_readonly: "Looking up the county's records",
  find_shelters: "Finding the shelter in the records",
  record_shelter_assessment: "Saving the shelter's answers",
};
const friendlyStep = (tool: string) => STEP_LABELS[tool] ?? "Looking things up";

const SYMBOLS: [string, string][] = [
  ["🕰️", "From FEMA's shelter registry (historical record)"],
  ["🟢", "Checked live on Google Maps just now"],
  ["📊", "Measured by the Census"],
  ["🧮", "Estimated (CDC model), not counted"],
  ["🌊", "FEMA flood/hurricane hazard model"],
  ["❓", "Nobody recorded this. Unknown, not \"no\""],
  ["🗺️", "Only available county-wide"],
  ["📏", "Straight-line distance"],
  ["🚗", "Driving time from Google Maps"],
];

/** Drops HTML tags and the agent's one-line symbol legend (the UI shows its own). */
function cleanAgentText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !(/historical FEMA record/.test(l) && /live Google Maps check/.test(l)))
    .join("\n")
    .replace(/<br\s*\/?>/gi, " · ")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .trim();
}

/**
 * Lightweight renderer for the Markdown structure produced by `evac_agent`
 * (headings, GitHub-flavored Markdown tables, bulleted/numbered lists, bold, and inline code).
 */
function renderInlineFormatted(text: string): React.ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return tokens.map((tok, idx) => {
    if (tok.startsWith("**") && tok.endsWith("**") && tok.length > 4) {
      return <strong key={idx}>{tok.slice(2, -2)}</strong>;
    }
    if (tok.startsWith("`") && tok.endsWith("`") && tok.length > 2) {
      return (
        <code key={idx} className="md-inline-code">
          {tok.slice(1, -1)}
        </code>
      );
    }
    const linkMatch = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a
          key={idx}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="md-link"
        >
          {linkMatch[1]}
        </a>
      );
    }
    return tok;
  });
}

function renderMarkdownBlocks(markdown: string, stacked = false): React.ReactNode {
  const lines = markdown.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Markdown table block. Forgiving on purpose: the model sometimes drops the "| --- |" separator
    // or puts blank lines between rows, so any run of "|...|" lines becomes a table.
    const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
    const isSeparator = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes("-");
    const splitRow = (l: string) =>
      l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
    if (isRow(line)) {
      const tableLines: string[] = [];
      while (i < lines.length && (isRow(lines[i]) || (!lines[i].trim() && i + 1 < lines.length && isRow(lines[i + 1])))) {
        if (lines[i].trim() && !isSeparator(lines[i])) tableLines.push(lines[i]);
        i++;
      }
      const headerCells = splitRow(tableLines[0] ?? "");
      const rows: string[][] = tableLines.slice(1).map(splitRow);
      if (stacked) {
        // Narrow panel: one card per row ("Header: value"), so nothing wraps letter by letter.
        blocks.push(
          <div key={`cards-${i}`} className="md-row-cards">
            {rows.map((r, rIdx) => (
              <div key={rIdx} className="md-row-card">
                <div className="md-row-card-title">{renderInlineFormatted(r[0] ?? "")}</div>
                {r.slice(1).map((cell, cIdx) => (
                  <div key={cIdx} className="md-row-card-field">
                    <span className="md-row-card-label">
                      {renderInlineFormatted(headerCells[cIdx + 1] ?? "")}
                    </span>
                    <span>{renderInlineFormatted(cell)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        );
        continue;
      }
      blocks.push(
        <div key={`tbl-${i}`} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {headerCells.map((h, hIdx) => (
                  <th key={hIdx}>{renderInlineFormatted(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, rIdx) => (
                <tr key={rIdx}>
                  {r.map((cell, cIdx) => (
                    <td key={cIdx}>{renderInlineFormatted(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = renderInlineFormatted(headingMatch[2]);
      if (level <= 2) {
        blocks.push(
          <h3 key={`h-${i}`} className="md-heading">
            {content}
          </h3>
        );
      } else {
        blocks.push(
          <h4 key={`h-${i}`} className="md-subheading">
            {content}
          </h4>
        );
      }
      i++;
      continue;
    }

    // Bullet or numbered list
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const isOrdered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        i++;
      }
      const ListTag = isOrdered ? "ol" : "ul";
      blocks.push(
        <ListTag key={`lst-${i}`} className="md-list">
          {items.map((it, idx) => (
            <li key={idx}>{renderInlineFormatted(it)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    // Paragraph
    blocks.push(
      <p key={`p-${i}`} className="md-paragraph">
        {renderInlineFormatted(line)}
      </p>
    );
    i++;
  }

  return <div className="md-body">{blocks}</div>;
}

function buildInitialMessages(county: string, stateCode: string): ChatMessage[] {
  const starter = buildStarterAgentBriefing(county);
  return [
    {
      id: `starter-${county}-${stateCode}`,
      role: "agent",
      text:
        `Hi! I've loaded the initial multi-agent readiness briefing for **${county} County, ${stateCode}** below.\n\n` +
        `Review the **4 specialist agent outputs** (` +
        "`prioritization_agent`, `destination_agent`, `verification_agent`, `evac_readiness_coordinator`" +
        `) and use the interactive cards to **Approve**, **Reject**, or **Select Between Options** — or ask a question by text or **Gemini Live Voice**.`,
      tools_called: [
        "prioritization_agent",
        "destination_agent",
        "verification_agent",
        "county_gap_report",
      ],
      recommended_actions: starter.actions,
      agent_outputs: starter.outputs,
    },
  ];
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  stateCode = "FL",
  county = "Lee",
  compact = false,
  suggestedQuestion,
  onFocusLocation,
  dashboardData = null,
  sharedDecisions,
  onSharedDecisionsChange,
  selectedOptionsByAction,
  onSelectActionOption,
  activeActionId,
  onActiveActionChange,
  onActionsSync,
  externalDecisionTrigger = null,
}) => {
  const bottom = useRef<HTMLDivElement>(null);
  const liveSessionRef = useRef<GeminiLiveSession | null>(null);
  const lastExternalDecisionId = useRef<number | null>(null);

  const [sessionId, setSessionId] = useState<string>(
    () => `web-session-${crypto.randomUUID()}`
  );
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    buildInitialMessages(county, stateCode)
  );

  // Widget UI state
  const [activeTab, setActiveTab] = useState<WidgetTab>("chat");
  const [actionFilter, setActionFilter] = useState<ActionFilter>("pending");
  const [schemaAgentFilter, setSchemaAgentFilter] = useState<string>("all");
  const [textInput, setTextInput] = useState<string>("");
  const [minimized, setMinimized] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<boolean>(false);

  // Decisions state keyed by action_id (supports controlled shared state with CountyMap)
  const [internalDecisions, setInternalDecisions] = useState<
    Record<string, ActionDecisionRecord>
  >({});
  const decisions = sharedDecisions ?? internalDecisions;
  const updateDecisions = onSharedDecisionsChange ?? setInternalDecisions;

  const [internalSelectedOptions, setInternalSelectedOptions] = useState<
    Record<string, string>
  >({});
  const effectiveSelectedOptions = selectedOptionsByAction ?? internalSelectedOptions;
  const handleSelectOption = (actionId: string, optionId: string) => {
    setInternalSelectedOptions((prev) => ({ ...prev, [actionId]: optionId }));
    onSelectActionOption?.(actionId, optionId);
    onActiveActionChange?.(actionId);
  };

  const [decidingActionId, setDecidingActionId] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [connection, setConnection] = useState<"ready" | "connected" | "error">("ready");
  const [steps, setSteps] = useState<{ tool: string; done: boolean }[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [, setTick] = useState(0);

  // Gemini Live Voice state
  const [voiceStatus, setVoiceStatus] = useState<LiveVoiceStatus>("idle");
  const [voiceDetail, setVoiceDetail] = useState<string>("");
  const [micVolume, setMicVolume] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [liveUserTranscript, setLiveUserTranscript] = useState<string>("");
  const [liveAgentTranscript, setLiveAgentTranscript] = useState<string>("");
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const isVoiceActive =
    voiceStatus === "connecting" ||
    voiceStatus === "listening" ||
    voiceStatus === "thinking" ||
    voiceStatus === "speaking";

  // Aggregate all unique recommended actions & agent schema outputs across conversation
  const allActions = useMemo(() => {
    const map = new Map<string, RecommendedAction>();
    for (const msg of messages) {
      if (Array.isArray(msg.recommended_actions)) {
        for (const act of msg.recommended_actions) {
          if (act?.action_id) {
            map.set(act.action_id, act);
          }
        }
      }
    }
    return Array.from(map.values());
  }, [messages]);

  // Synchronize allActions up to PlanningDashboard so CountyMap shows the exact same actions
  useEffect(() => {
    onActionsSync?.(allActions);
  }, [allActions, onActionsSync]);

  const allAgentOutputs = useMemo(() => {
    const list: AgentSchemaOutput[] = [];
    const seen = new Set<string>();
    for (let i = messages.length - 1; i >= 0; i--) {
      const outputs = messages[i].agent_outputs;
      if (Array.isArray(outputs)) {
        for (const out of outputs) {
          const key = `${out.agent_name}::${out.schema_name}::${out.tool_name}`;
          if (!seen.has(key)) {
            seen.add(key);
            list.push(out);
          }
        }
      }
    }
    return list;
  }, [messages]);

  const pendingActionsCount = useMemo(
    () => allActions.filter((a) => !decisions[a.action_id]).length,
    [allActions, decisions]
  );

  const decidedActionsCount = useMemo(
    () => allActions.filter((a) => Boolean(decisions[a.action_id])).length,
    [allActions, decisions]
  );

  const filteredActions = useMemo(() => {
    return allActions.filter((a) => {
      if (actionFilter === "pending") return !decisions[a.action_id];
      if (actionFilter === "decided") return Boolean(decisions[a.action_id]);
      return true;
    });
  }, [allActions, decisions, actionFilter]);

  const filteredSchemas = useMemo(() => {
    if (schemaAgentFilter === "all") return allAgentOutputs;
    return allAgentOutputs.filter((o) => o.agent_name === schemaAgentFilter);
  }, [allAgentOutputs, schemaAgentFilter]);

  useEffect(() => {
    if (!loading && voiceStatus !== "thinking") return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [loading, voiceStatus]);

  useEffect(() => {
    liveSessionRef.current?.updateContext(county, stateCode, sessionId);
  }, [county, stateCode, sessionId]);

  useEffect(() => {
    return () => {
      liveSessionRef.current?.stop();
      liveSessionRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (suggestedQuestion?.text) {
      setMinimized(false);
      setActiveTab("chat");
      void handleSend(suggestedQuestion.text);
    }
  }, [suggestedQuestion]);

  useEffect(() => {
    if (activeTab === "chat") {
      bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [messages, loading, liveUserTranscript, liveAgentTranscript, voiceStatus, activeTab]);

  const createLiveSession = () => {
    if (liveSessionRef.current) {
      liveSessionRef.current.stop();
    }
    const session = new GeminiLiveSession(county, stateCode, sessionId, {
      onStatusChange: (status, detail) => {
        setVoiceStatus(status);
        if (detail) setVoiceDetail(detail);
        if (status === "thinking") {
          setStartedAt((prev) => prev ?? Date.now());
        } else if (status === "listening" || status === "idle") {
          setStartedAt(null);
        }
        if (status === "listening" || status === "speaking") {
          setConnection("connected");
          setVoiceError(null);
        }
      },
      onVolume: (level) => {
        setMicVolume(level);
      },
      onInputTranscript: (text) => {
        setLiveUserTranscript(text);
      },
      onOutputTranscript: (text) => {
        setLiveAgentTranscript(text);
      },
      onStep: (p: AgentProgress) => {
        setSteps((prev) => {
          if (p.type === "step") {
            if (prev.some((s) => s.tool === p.tool && !s.done)) return prev;
            return [...prev, { tool: p.tool, done: false }];
          }
          return prev.map((s) => (s.tool === p.tool ? { ...s, done: true } : s));
        });
      },
      onTurnComplete: (turn: LiveTurnResult) => {
        setLiveUserTranscript("");
        setLiveAgentTranscript("");
        setSteps([]);
        setStartedAt(null);
        setConnection("connected");
        setMessages((prev) => {
          const next = [...prev];
          if (turn.userText) {
            next.push({
              id: `user-${Date.now()}`,
              role: "user",
              text: turn.userText,
            });
          }
          if (turn.agentText) {
            next.push({
              id: `agent-${Date.now()}`,
              role: "agent",
              text: turn.agentText,
              tools_called: turn.tools_called,
              elapsed_seconds: turn.elapsed_seconds,
              grounding_chunks: turn.grounding_chunks,
              recommended_actions: turn.recommended_actions,
              agent_outputs: turn.agent_outputs,
            });
          }
          return next;
        });
      },
      onError: (msg) => {
        setVoiceError(msg);
      },
    });
    liveSessionRef.current = session;
    return session;
  };

  const handleToggleVoice = async () => {
    if (isVoiceActive) {
      liveSessionRef.current?.stop();
      setVoiceStatus("idle");
      setVoiceDetail("");
      setIsMuted(false);
      setLiveUserTranscript("");
      setLiveAgentTranscript("");
      setSteps([]);
      return;
    }

    setVoiceError(null);
    setSteps([]);
    const session = createLiveSession();
    await session.start();
  };

  const handleToggleMute = () => {
    if (!liveSessionRef.current) return;
    const nextMuted = !isMuted;
    liveSessionRef.current.setMuted(nextMuted);
    setIsMuted(nextMuted);
  };

  const handleInterrupt = () => {
    liveSessionRef.current?.stopAudioPlayback();
    setVoiceStatus("listening");
    setVoiceDetail("Listening — speak anytime");
  };

  const handleNewSession = () => {
    liveSessionRef.current?.stop();
    setVoiceStatus("idle");
    setVoiceDetail("");
    setIsMuted(false);
    setLiveUserTranscript("");
    setLiveAgentTranscript("");
    setSteps([]);
    updateDecisions({});
    const nextSession = `web-session-${crypto.randomUUID()}`;
    setSessionId(nextSession);
    setMessages(buildInitialMessages(county, stateCode));
  };

  const handleSend = async (promptText: string) => {
    const query = promptText.trim();
    if (!query || loading) return;

    setTextInput("");

    // If Gemini Live voice session is active, send prompt directly into the live session
    if (isVoiceActive && liveSessionRef.current) {
      setSteps([]);
      setStartedAt(Date.now());
      await liveSessionRef.current.sendPrompt(query);
      return;
    }

    setMessages((prev) => [
      ...prev,
      { id: `user-${Date.now()}`, role: "user", text: query },
    ]);
    setLoading(true);
    setSteps([]);
    setStartedAt(Date.now());

    try {
      const res = await streamAgentMessage(
        query,
        stateCode,
        county,
        sessionId,
        (p: AgentProgress) => {
          setSteps((prev) => {
            if (p.type === "step") {
              if (prev.some((s) => s.tool === p.tool && !s.done)) return prev;
              return [...prev, { tool: p.tool, done: false }];
            }
            return prev.map((s) => (s.tool === p.tool ? { ...s, done: true } : s));
          });
        }
      );
      setConnection("connected");
      setMessages((prev) => [
        ...prev,
        {
          id: `agent-${Date.now()}`,
          role: "agent",
          text: res.reply,
          tools_called: res.tools_called,
          elapsed_seconds: res.elapsed_seconds,
          grounding_chunks: res.grounding_chunks,
          recommended_actions: res.recommended_actions,
          agent_outputs: res.agent_outputs,
        },
      ]);
    } catch (err) {
      setConnection("error");
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "agent",
          text: `Sorry, something went wrong while I was working on that. Please try again in a moment. (${
            err instanceof Error ? err.message : String(err)
          })`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleActionDecision = async (
    action: RecommendedAction,
    decision: ActionDecisionStatus,
    selectedOptionId?: string,
    note?: string,
    sendFollowUp = false
  ) => {
    setDecidingActionId(action.action_id);
    const selectedOpt = action.options?.find(
      (o) => o.option_id === selectedOptionId
    );
    // Immediately record decision so the card disappears on both Map and Chat simultaneously
    const optimisticRecord: ActionDecisionRecord = {
      action_id: action.action_id,
      decision,
      selected_option_id: selectedOptionId,
      selected_option_label: selectedOpt?.label,
      note,
      decided_at: new Date().toISOString(),
      applied_summary:
        decision === "REJECTED"
          ? `Rejected: ${action.title}`
          : selectedOpt
          ? `Selected option "${selectedOpt.label}" for ${action.title}`
          : `Approved: ${action.title}`,
    };
    updateDecisions((prev) => ({
      ...prev,
      [action.action_id]: optimisticRecord,
    }));

    try {
      const record = await submitActionDecision({
        action_id: action.action_id,
        decision,
        selected_option_id: selectedOptionId,
        selected_option_label: selectedOpt?.label,
        note,
        county,
        session_id: sessionId,
        action,
      });
      updateDecisions((prev) => ({
        ...prev,
        [action.action_id]: record,
      }));

      if (sendFollowUp && record.follow_up_prompt) {
        setActiveTab("chat");
        await handleSend(record.follow_up_prompt);
      }
    } finally {
      setDecidingActionId(null);
    }
  };

  // Handle decisions triggered directly from the On-Map Widget so follow-up prompts & API calls stay unified
  useEffect(() => {
    if (
      externalDecisionTrigger &&
      externalDecisionTrigger.id !== lastExternalDecisionId.current
    ) {
      lastExternalDecisionId.current = externalDecisionTrigger.id;
      void handleActionDecision(
        externalDecisionTrigger.action,
        externalDecisionTrigger.decision,
        externalDecisionTrigger.selectedOptionId,
        externalDecisionTrigger.note,
        externalDecisionTrigger.sendFollowUp
      );
    }
  }, [externalDecisionTrigger]);

  const handleTextFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim() || loading) return;
    void handleSend(textInput);
  };

  const badgeLabel = isVoiceActive
    ? voiceStatus === "speaking"
      ? "◉ Speaking Live"
      : voiceStatus === "thinking"
      ? "◌ Checking Records…"
      : voiceStatus === "connecting"
      ? "◌ Connecting Live…"
      : isMuted
      ? "🔇 Mic Muted"
      : "● Gemini Live Listening"
    : loading
    ? "Working…"
    : connection === "error"
    ? "Having trouble connecting"
    : "● Multi-Agent Ready";

  // Floating minimized launcher pill when user minimizes the chat widget
  if (minimized) {
    return (
      <div className="chat-widget-minimized-wrap">
        <button
          type="button"
          className="chat-widget-launcher-btn"
          onClick={() => setMinimized(false)}
          aria-label="Open Evacuation Readiness Chat Widget"
        >
          <span className="chat-widget-launcher-icon">✧</span>
          <span className="chat-widget-launcher-text">
            <strong>Evacuation Agent Widget</strong>
            <small>
              {county} County · {pendingActionsCount} pending{" "}
              {pendingActionsCount === 1 ? "approval" : "approvals"}
            </small>
          </span>
          {pendingActionsCount > 0 && (
            <span className="chat-widget-launcher-badge">{pendingActionsCount}</span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div
      className={`chat-tab-container ${compact ? "compact-chat" : ""} ${
        expanded ? "chat-expanded" : ""
      }`}
    >
      {/* Top Status & Controls Card */}
      <div className="card chat-status-card">
        <div className="admin-header-top">
          <div>
            <div className="admin-title-row">
              <h2>✧ Planning assistant</h2>
              <span
                className={`connection-badge ${
                  connection === "error" ? "preview" : "live"
                } ${isVoiceActive ? "voice-live-badge" : ""}`}
              >
                {badgeLabel}
              </span>
            </div>
            <p className="admin-subtitle">
              {compact ? (
                "4 specialist agents · Approve, reject, or select options · Live Voice & Text"
              ) : (
                <>
                  Endpoint: <code>{DEPLOYED_CLOUD_RUN_URL}</code> · Session:{" "}
                  <code>{sessionId}</code>
                </>
              )}
            </p>
          </div>

          <div className="chat-header-actions">
            {!compact && (
              <a
                href={`${DEPLOYED_CLOUD_RUN_URL}/dev-ui/`}
                target="_blank"
                rel="noopener noreferrer"
                className="schema-toggle-btn"
                style={{ textDecoration: "none" }}
              >
                ↗ Open Cloud Run ADK Dev UI
              </a>
            )}
            {compact && (
              <button
                type="button"
                className="refresh-btn"
                onClick={() => setExpanded((e) => !e)}
              >
                {expanded ? "⤡ Shrink" : "⤢ Expand"}
              </button>
            )}
            <button
              type="button"
              className="refresh-btn"
              onClick={() => {
                setExpanded(false);
                setMinimized(true);
              }}
              title="Minimize chat widget to floating launcher"
            >
              _ Minimize
            </button>
            <button
              type="button"
              className="refresh-btn"
              onClick={handleNewSession}
              disabled={loading}
            >
              + Reset
            </button>
          </div>
        </div>

        {/* Multi-Agent Widget Navigation Tabs */}
        <div className="chat-widget-tabs" role="tablist" aria-label="Assistant views">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "chat"}
            className={`chat-widget-tab ${activeTab === "chat" ? "active" : ""}`}
            onClick={() => setActiveTab("chat")}
          >
            Chat &amp; Briefings
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "actions"}
            className={`chat-widget-tab ${activeTab === "actions" ? "active" : ""}`}
            onClick={() => setActiveTab("actions")}
          >
            Actions &amp; Approvals
            {pendingActionsCount > 0 ? (
              <span className="chat-tab-badge chat-tab-badge--pending">
                {pendingActionsCount}
              </span>
            ) : (
              <span className="chat-tab-badge">{allActions.length}</span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "schemas"}
            className={`chat-widget-tab ${activeTab === "schemas" ? "active" : ""}`}
            onClick={() => setActiveTab("schemas")}
          >
            Agent Schemas
            <span className="chat-tab-badge">{allAgentOutputs.length}</span>
          </button>
        </div>

        {/* Specialist Prompt Chips */}
        <div className="chat-prompts-bar">
          <span className="quick-filter-label">Ask an agent:</span>
          {(compact
            ? [
                `Rank priority tracts in ${county} County and propose weight options`,
                `Plan reachable shelter options for ${county} County's top tracts`,
                `Verify ${county} County shelters on Google Maps and audit missing fields`,
                `Give me the full pre-season readiness brief for ${county} County`,
              ]
            : SUGGESTED_QUESTIONS.map((q) =>
                q.split("Lee County").join(`${county} County`)
              )
          ).map((q) => (
            <button
              key={q}
              type="button"
              className="prompt-chip"
              onClick={() => {
                setActiveTab("chat");
                void handleSend(q);
              }}
              disabled={loading || voiceStatus === "thinking"}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {/* Main Conversation / Actions / Schemas Card */}
      <div className="card chat-conversation-card">
        {activeTab === "chat" && (
          <div
            className="chat-messages-large"
            role="log"
            aria-label="Agent conversation"
            aria-live="polite"
          >
            {messages.map((m) => (
              <div key={m.id} className={`chat-bubble ${m.role}`}>
                {m.role === "agent" &&
                  ((m.tools_called && m.tools_called.length > 0) ||
                    m.elapsed_seconds !== undefined) && (
                    <div className="agent-meta-bar">
                      {m.tools_called
                        ?.filter((tool) => STEP_LABELS[tool])
                        .map((tool) => (
                          <span key={tool} className="tool-badge" title={tool}>
                            ✓ {friendlyStep(tool)}
                          </span>
                        ))}
                      {m.elapsed_seconds !== undefined && (
                        <span className="elapsed-badge">
                          Answered in {Math.round(m.elapsed_seconds)}s
                        </span>
                      )}
                    </div>
                  )}

                <div className="bubble-text">
                  {m.role === "agent"
                    ? renderMarkdownBlocks(cleanAgentText(m.text), compact && !expanded)
                    : m.text}
                </div>

                {/* Structured Specialist Agent Output Schemas for this turn */}
                {m.role === "agent" &&
                  Array.isArray(m.agent_outputs) &&
                  m.agent_outputs.length > 0 && (
                    <div className="chat-turn-schemas">
                      <div className="chat-section-header">
                        <span>Structured Agent Output Schemas ({m.agent_outputs.length})</span>
                        <button
                          type="button"
                          className="chat-link-btn"
                          onClick={() => setActiveTab("schemas")}
                        >
                          Open Schema Inspector →
                        </button>
                      </div>
                      {m.agent_outputs.map((out, idx) => (
                        <AgentSchemaOutputView
                          key={`${m.id}-schema-${idx}`}
                          output={out}
                          onFocusLocation={onFocusLocation}
                          defaultExpanded={idx === 0}
                        />
                      ))}
                    </div>
                  )}

                {/* Interactive Recommended Actions (Approve / Reject / Select Between Options) */}
                {m.role === "agent" &&
                  Array.isArray(m.recommended_actions) &&
                  m.recommended_actions.length > 0 && (() => {
                    const turnPending = m.recommended_actions.filter(
                      (act) => !decisions[act.action_id]
                    );
                    const turnDecidedCount =
                      m.recommended_actions.length - turnPending.length;
                    return (
                      <div className="chat-turn-actions">
                        <div className="chat-section-header">
                          <span>
                            Recommended Decisions &amp; Options ({turnPending.length} active
                            {turnDecidedCount > 0 ? ` · ${turnDecidedCount} decided` : ""})
                          </span>
                          <button
                            type="button"
                            className="chat-link-btn"
                            onClick={() => {
                              setActionFilter(turnPending.length > 0 ? "pending" : "decided");
                              setActiveTab("actions");
                            }}
                          >
                            {turnPending.length > 0
                              ? `Decision Queue (${pendingActionsCount} pending) →`
                              : `View Decided History (${decidedActionsCount}) →`}
                          </button>
                        </div>
                        {turnPending.length === 0 ? (
                          <div className="chat-all-decided-banner">
                            ✓ All {m.recommended_actions.length} recommendations in this briefing have been decided and dismissed from the active Map &amp; Chat views.
                          </div>
                        ) : (
                          turnPending.map((act) => (
                            <RecommendedActionCard
                              key={`${m.id}-act-${act.action_id}`}
                              action={act}
                              decision={decisions[act.action_id]}
                              selectedOptionId={effectiveSelectedOptions[act.action_id]}
                              onSelectOption={handleSelectOption}
                              onDecide={handleActionDecision}
                              onFocusLocation={(target) => {
                                if (target.actionId) {
                                  onActiveActionChange?.(target.actionId);
                                } else {
                                  onActiveActionChange?.(act.action_id);
                                }
                                onFocusLocation?.(target);
                              }}
                              dashboardData={dashboardData}
                              isFocusedOnMap={activeActionId === act.action_id}
                              busy={decidingActionId === act.action_id || loading}
                            />
                          ))
                        )}
                      </div>
                    );
                  })()}

                {m.role === "agent" &&
                  SYMBOLS.some(([sym]) => m.text.includes(sym)) && (
                    <details className="symbol-legend">
                      <summary>What do the symbols mean?</summary>
                      <ul>
                        {SYMBOLS.filter(([sym]) => m.text.includes(sym)).map(
                          ([sym, meaning]) => (
                            <li key={sym}>
                              <span className="symbol-legend-icon">{sym}</span> {meaning}
                            </li>
                          )
                        )}
                      </ul>
                    </details>
                  )}

                {m.grounding_chunks && m.grounding_chunks.length > 0 && (
                  <MapsAttribution chunks={m.grounding_chunks} />
                )}
              </div>
            ))}

            {/* Live real-time user speech transcription */}
            {liveUserTranscript && (
              <div className="chat-bubble user live-transcript-bubble">
                <span className="live-transcript-tag">🎙️ Speaking live</span>
                <div className="bubble-text">{liveUserTranscript}</div>
              </div>
            )}

            {/* Live real-time Gemini Live spoken output transcription */}
            {liveAgentTranscript && (
              <div className="chat-bubble agent live-transcript-bubble">
                <div className="agent-meta-bar">
                  <span className="tool-badge">🔊 Gemini Live Voice</span>
                </div>
                <div className="bubble-text">
                  {renderMarkdownBlocks(
                    cleanAgentText(liveAgentTranscript),
                    compact && !expanded
                  )}
                </div>
              </div>
            )}

            {(loading || voiceStatus === "thinking" || steps.length > 0) && (
              <div className="chat-bubble agent progress-box" role="status">
                <div className="progress-title">
                  <span className="loading-ring small" /> Working on it…
                  <span className="progress-elapsed">
                    {startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0}s
                  </span>
                </div>
                <ul className="progress-steps">
                  <li className="done">✓ Heard your question</li>
                  {steps.map((s) => (
                    <li key={s.tool} className={s.done ? "done" : "active"}>
                      {s.done ? "✓" : <span className="step-dot" />} {friendlyStep(s.tool)}
                    </li>
                  ))}
                  {steps.length > 0 && steps.every((s) => s.done) && (
                    <li className="active">
                      <span className="step-dot" /> Preparing structured response
                    </li>
                  )}
                </ul>
                <p className="progress-note">
                  Most answers take 20–60 seconds. Checking shelters live on{" "}
                  <span translate="no">Google Maps</span> takes a little longer.
                </p>
              </div>
            )}
            <div ref={bottom} />
          </div>
        )}

        {/* TAB 2: Dedicated Actions & Approvals Queue */}
        {activeTab === "actions" && (
          <div className="chat-messages-large chat-actions-tab-view">
            <div className="chat-subfilter-bar">
              <div className="chat-subfilter-title">
                <strong>Operator Decision Queue</strong>
                <span>
                  {pendingActionsCount} pending · {decidedActionsCount} decided
                </span>
              </div>
              <div className="chat-subfilter-pills">
                {(["all", "pending", "decided"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`chat-subfilter-pill ${actionFilter === f ? "active" : ""}`}
                    onClick={() => setActionFilter(f)}
                  >
                    {f === "all"
                      ? `All (${allActions.length})`
                      : f === "pending"
                      ? `Pending (${pendingActionsCount})`
                      : `Decided (${decidedActionsCount})`}
                  </button>
                ))}
              </div>
            </div>

            {filteredActions.length === 0 ? (
              <div className="chat-empty-tab">
                <p>No actions match this filter.</p>
              </div>
            ) : (
              filteredActions.map((act) => (
                <RecommendedActionCard
                  key={`queue-${act.action_id}`}
                  action={act}
                  decision={decisions[act.action_id]}
                  selectedOptionId={effectiveSelectedOptions[act.action_id]}
                  onSelectOption={handleSelectOption}
                  onDecide={handleActionDecision}
                  onFocusLocation={(target) => {
                    if (target.actionId) {
                      onActiveActionChange?.(target.actionId);
                    } else {
                      onActiveActionChange?.(act.action_id);
                    }
                    onFocusLocation?.(target);
                  }}
                  dashboardData={dashboardData}
                  isFocusedOnMap={activeActionId === act.action_id}
                  busy={decidingActionId === act.action_id || loading}
                />
              ))
            )}
          </div>
        )}

        {/* TAB 3: Dedicated Specialist Agent Output Schemas View */}
        {activeTab === "schemas" && (
          <div className="chat-messages-large chat-schemas-tab-view">
            <div className="chat-subfilter-bar">
              <div className="chat-subfilter-title">
                <strong>Specialist Agent Output Schemas</strong>
                <span>Structured Pydantic models emitted by each agent</span>
              </div>
              <div className="chat-subfilter-pills">
                {[
                  ["all", "All Agents"],
                  ["prioritization_agent", "Prioritization"],
                  ["destination_agent", "Destination"],
                  ["verification_agent", "Verification"],
                  ["evac_readiness_coordinator", "Coordinator"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={`chat-subfilter-pill ${
                      schemaAgentFilter === id ? "active" : ""
                    }`}
                    onClick={() => setSchemaAgentFilter(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {filteredSchemas.length === 0 ? (
              <div className="chat-empty-tab">
                <p>No structured outputs recorded for this agent filter yet.</p>
              </div>
            ) : (
              filteredSchemas.map((out, idx) => (
                <AgentSchemaOutputView
                  key={`inspector-${idx}-${out.schema_name}`}
                  output={out}
                  onFocusLocation={onFocusLocation}
                  defaultExpanded={true}
                />
              ))
            )}
          </div>
        )}

        {/* Interactive Text Input Bar */}
        <form className="chat-text-input-bar" onSubmit={handleTextFormSubmit}>
          <input
            type="text"
            className="chat-text-input"
            placeholder={`Ask about ${county} County tracts, shelter routing, or live Google Maps status…`}
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            disabled={loading}
            aria-label={`Ask the ${county} County planning assistant`}
          />
          <button
            type="submit"
            className="chat-text-send-btn"
            disabled={loading || !textInput.trim()}
          >
            {loading ? "…" : "Send"}
          </button>
        </form>

        {/* Gemini Live Voice Talk Bar */}
        <div
          className={`gemini-live-voice-bar ${
            isVoiceActive ? `active-${voiceStatus}` : ""
          }`}
        >
          {voiceError && (
            <div className="voice-error-banner" role="alert">
              <span>⚠️ {voiceError}</span>
              <button
                type="button"
                onClick={() => setVoiceError(null)}
                aria-label="Dismiss error"
              >
                ✕
              </button>
            </div>
          )}

          {!isVoiceActive ? (
            <div className="voice-idle-controls">
              <button
                type="button"
                className="voice-start-btn"
                onClick={handleToggleVoice}
                disabled={loading}
                aria-label={`Start Gemini Live voice conversation for ${county} County`}
              >
                <span className="voice-mic-orb" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
                  </svg>
                </span>
                <span className="voice-start-text">
                  <strong>Start Gemini Live Voice</strong>
                  <small>Talk naturally about {county} County evacuation readiness</small>
                </span>
              </button>
            </div>
          ) : (
            <div className="voice-active-session">
              <div className="voice-visualizer-row">
                <div
                  className={`voice-live-orb ${voiceStatus} ${isMuted ? "muted" : ""}`}
                  style={
                    {
                      "--mic-scale": (1 + (isMuted ? 0 : micVolume) * 0.45).toFixed(2),
                    } as React.CSSProperties
                  }
                >
                  <div className="voice-wave-bars" aria-hidden="true">
                    {[0.55, 0.9, 1.25, 0.95, 0.6].map((mult, idx) => {
                      const heightPct =
                        voiceStatus === "speaking"
                          ? 65
                          : isMuted
                          ? 18
                          : Math.max(
                              20,
                              Math.min(100, Math.round((0.18 + micVolume * mult) * 100))
                            );
                      return (
                        <span
                          key={idx}
                          className={`wave-bar ${
                            voiceStatus === "speaking" ? "speaking-anim" : ""
                          }`}
                          style={{
                            height: `${heightPct}%`,
                            animationDelay: `${idx * 0.12}s`,
                          }}
                        />
                      );
                    })}
                  </div>
                </div>

                <div className="voice-status-info">
                  <div className="voice-status-headline">
                    <span className={`voice-status-dot ${voiceStatus}`} />
                    <strong>
                      {isMuted
                        ? "Microphone muted"
                        : voiceStatus === "connecting"
                        ? "Connecting to Gemini Live…"
                        : voiceStatus === "speaking"
                        ? "Gemini Live is speaking…"
                        : voiceStatus === "thinking"
                        ? "Checking county records & Google Maps…"
                        : `Listening — ask about ${county} County`}
                    </strong>
                  </div>
                  <p className="voice-status-sub">
                    {voiceDetail || "Speak naturally; you can interrupt at any time."}
                  </p>
                </div>
              </div>

              <div className="voice-action-buttons">
                <button
                  type="button"
                  className={`voice-ctrl-btn ${isMuted ? "muted-active" : ""}`}
                  onClick={handleToggleMute}
                  aria-pressed={isMuted}
                >
                  {isMuted ? "🔇 Unmute Mic" : "🎙️ Mute Mic"}
                </button>

                {voiceStatus === "speaking" && (
                  <button
                    type="button"
                    className="voice-ctrl-btn interrupt-btn"
                    onClick={handleInterrupt}
                  >
                    ⏹ Interrupt
                  </button>
                )}

                <button
                  type="button"
                  className="voice-ctrl-btn end-voice-btn"
                  onClick={handleToggleVoice}
                >
                  ✕ End Live Voice
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
