import React, { useEffect, useRef, useState } from "react";
import { AgentProgress, DEPLOYED_CLOUD_RUN_URL, streamAgentMessage } from "../services/agentApi";
import { MapsGroundingChunk } from "../types/brief";
import { MapsAttribution } from "./MapsAttribution";

interface ChatMessage {
  role: "user" | "agent";
  text: string;
  tools_called?: string[];
  elapsed_seconds?: number;
  grounding_chunks?: MapsGroundingChunk[];
}

interface ChatPanelProps {
  stateCode?: string;
  county?: string;
  compact?: boolean;
  suggestedQuestion?: {text: string; id: number; send?: boolean} | null;
}

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
  county_gap_report: "Listing what to fix before the season",
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

    // Markdown table block
    if (
      line.trim().startsWith("|") &&
      i + 1 < lines.length &&
      /^\s*\|[\s:-]+\|/.test(lines[i + 1])
    ) {
      const headerCells = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.replace(/\\\|/g, "|").trim());
      i += 2; // skip header + separator line
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const rowCells = lines[i]
          .trim()
          .replace(/^\||\|$/g, "")
          .split(/(?<!\\)\|/)
          .map((c) => c.replace(/\\\|/g, "|").trim());
        rows.push(rowCells);
        i++;
      }
      if (stacked) {
        // Narrow panel: one card per row ("Header: value"), so nothing wraps letter by letter.
        blocks.push(
          <div key={`cards-${i}`} className="md-row-cards">
            {rows.map((r, rIdx) => (
              <div key={rIdx} className="md-row-card">
                <div className="md-row-card-title">{renderInlineFormatted(r[0] ?? "")}</div>
                {r.slice(1).map((cell, cIdx) => (
                  <div key={cIdx} className="md-row-card-field">
                    <span className="md-row-card-label">{renderInlineFormatted(headerCells[cIdx + 1] ?? "")}</span>
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

export const ChatPanel: React.FC<ChatPanelProps> = ({
  stateCode = "FL",
  county = "Lee",
  compact = false,
  suggestedQuestion,
}) => {
  const bottom = useRef<HTMLDivElement>(null);
  const questionInput = useRef<HTMLInputElement>(null);
  const [sessionId, setSessionId] = useState<string>(
    () => `web-session-${crypto.randomUUID()}`
  );
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "agent",
      text: `Hi! I can help you plan for **${county} County** before hurricane season. Ask me who would struggle to evacuate, where they could go, or whether a shelter record is still accurate. Pick a suggestion below or type your own question.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [connection, setConnection] = useState<"ready" | "connected" | "error">("ready");
  const [expanded, setExpanded] = useState(false);
  const [steps, setSteps] = useState<{ tool: string; done: boolean }[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!loading) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [loading]);
  useEffect(() => {
    if (suggestedQuestion?.send) {
      handleSend(suggestedQuestion.text); // eslint-disable-line react-hooks/exhaustive-deps
      return;
    }
    setInput(suggestedQuestion?.text ?? "");
    if (suggestedQuestion) questionInput.current?.focus();
  }, [suggestedQuestion]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages, loading]);

  const handleNewSession = () => {
    const nextSession = `web-session-${crypto.randomUUID()}`;
    setSessionId(nextSession);
    setMessages([
      {
        role: "agent",
        text: "New conversation started. What would you like to know?",
      },
    ]);
  };

  const handleSend = async (promptText?: string) => {
    const query = (promptText ?? input).trim();
    if (!query || loading) return;

    setMessages((prev) => [...prev, { role: "user", text: query }]);
    if (!promptText) setInput("");
    setLoading(true);
    setSteps([]);
    setStartedAt(Date.now());

    try {
      const res = await streamAgentMessage(query, stateCode, county, sessionId, (p: AgentProgress) => {
        setSteps((prev) => {
          if (p.type === "step") {
            if (prev.some((s) => s.tool === p.tool && !s.done)) return prev;
            return [...prev, { tool: p.tool, done: false }];
          }
          return prev.map((s) => (s.tool === p.tool ? { ...s, done: true } : s));
        });
      });
      setConnection("connected");
      setMessages((prev) => [
        ...prev,
        {
          role: "agent",
          text: res.reply,
          tools_called: res.tools_called,
          elapsed_seconds: res.elapsed_seconds,
          grounding_chunks: res.grounding_chunks,
        },
      ]);
    } catch (err) {
      setConnection("error");
      setMessages((prev) => [
        ...prev,
        {
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

  return (
    <div className={`chat-tab-container ${compact ? "compact-chat" : ""} ${expanded ? "chat-expanded" : ""}`}>
      {/* Top Status & Controls Card */}
      <div className="card chat-status-card">
        <div className="admin-header-top">
          <div>
            <div className="admin-title-row">
              <h2>✧ Planning assistant</h2>
              <span className={`connection-badge ${connection === "error" ? "preview" : "live"}`}>
                {loading ? "Working…" : connection === "error" ? "Having trouble connecting" : "● Ready"}
              </span>
            </div>
            <p className="admin-subtitle">
              {compact ? "Answers from federal records, checked live on Google Maps" : <>Endpoint: <code>{DEPLOYED_CLOUD_RUN_URL}</code> · Session: <code>{sessionId}</code></>}
            </p>
          </div>

          <div className="chat-header-actions">
            {!compact && <a
              href={`${DEPLOYED_CLOUD_RUN_URL}/dev-ui/`}
              target="_blank"
              rel="noopener noreferrer"
              className="schema-toggle-btn"
              style={{ textDecoration: "none" }}
            >
              ↗ Open Cloud Run ADK Dev UI
            </a>}
            {compact && (
              <button type="button" className="refresh-btn" onClick={() => setExpanded((e) => !e)}>
                {expanded ? "⤡ Shrink" : "⤢ Expand"}
              </button>
            )}
            <button
              type="button"
              className="refresh-btn"
              onClick={handleNewSession}
              disabled={loading}
            >
              + New conversation
            </button>
          </div>
        </div>

        <div className="chat-prompts-bar">
          <span className="quick-filter-label">Try asking:</span>
          {(compact ? [
            `Which neighborhoods in ${county} County should we prioritize, and why?`,
            `Where would people without a car in the top neighborhood go?`,
            `Are our ${county} County shelter records accurate and up to date?`,
          ] : SUGGESTED_QUESTIONS.map(q => q.split("Lee County").join(`${county} County`))).map((q) => (
            <button
              key={q}
              type="button"
              className="prompt-chip"
              onClick={() => handleSend(q)}
              disabled={loading}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {/* Main Conversation Card */}
      <div className="card chat-conversation-card">
        <div className="chat-messages-large" role="log" aria-label="Agent conversation" aria-live="polite">
          {messages.map((m, i) => (
            <div key={i} className={`chat-bubble ${m.role}`}>
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
                      <span className="elapsed-badge">Answered in {Math.round(m.elapsed_seconds)}s</span>
                    )}
                  </div>
                )}

              <div className="bubble-text">
                {m.role === "agent" ? renderMarkdownBlocks(cleanAgentText(m.text), compact && !expanded) : m.text}
              </div>

              {m.role === "agent" && SYMBOLS.some(([sym]) => m.text.includes(sym)) && (
                <details className="symbol-legend">
                  <summary>What do the symbols mean?</summary>
                  <ul>
                    {SYMBOLS.filter(([sym]) => m.text.includes(sym)).map(([sym, meaning]) => (
                      <li key={sym}>
                        <span className="symbol-legend-icon">{sym}</span> {meaning}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {m.grounding_chunks && m.grounding_chunks.length > 0 && (
                <MapsAttribution chunks={m.grounding_chunks} />
              )}
            </div>
          ))}

          {loading && (
            <div className="chat-bubble agent progress-box" role="status">
              <div className="progress-title">
                <span className="loading-ring small" /> Working on it…
                <span className="progress-elapsed">{startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0}s</span>
              </div>
              <ul className="progress-steps">
                <li className="done">✓ Understood your question</li>
                {steps.map((s) => (
                  <li key={s.tool} className={s.done ? "done" : "active"}>
                    {s.done ? "✓" : <span className="step-dot" />} {friendlyStep(s.tool)}
                  </li>
                ))}
                {steps.length > 0 && steps.every((s) => s.done) && (
                  <li className="active"><span className="step-dot" /> Writing up the answer</li>
                )}
              </ul>
              <p className="progress-note">
                Most answers take 20–60 seconds. Checking shelters live on <span translate="no">Google Maps</span> takes a little longer.
              </p>
            </div>
          )}
          <div ref={bottom} />
        </div>

        <form
          className="chat-input-row"
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
        >
          <input
            ref={questionInput}
            type="text"
            aria-label="Question for the planning assistant"
            placeholder={`Ask about ${county} County…`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
          />
          <button type="submit" disabled={loading || !input.trim()}>
            {loading ? "Working…" : "Send →"}
          </button>
        </form>
      </div>
    </div>
  );
};
