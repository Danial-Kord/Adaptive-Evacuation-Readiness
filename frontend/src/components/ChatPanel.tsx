import React, { useEffect, useRef, useState } from "react";
import { DEPLOYED_CLOUD_RUN_URL, sendAgentMessage } from "../services/agentApi";
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
  suggestedQuestion?: {text: string; id: number} | null;
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

function renderMarkdownBlocks(markdown: string): React.ReactNode {
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
        .split("|")
        .map((c) => c.trim());
      i += 2; // skip header + separator line
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const rowCells = lines[i]
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
        rows.push(rowCells);
        i++;
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
      text: `Explore **${county} County, ${stateCode}** data, compare shelter records, and identify what to verify before the season. Select a tract or shelter and choose **Ask assistant** to draft a question.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [connection, setConnection] = useState<"ready" | "connected" | "error">("ready");
  useEffect(() => {
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
        text: `Started new session (\`${nextSession}\`). Ask a question below or click a prompt chip.`,
      },
    ]);
  };

  const handleSend = async (promptText?: string) => {
    const query = (promptText ?? input).trim();
    if (!query || loading) return;

    setMessages((prev) => [...prev, { role: "user", text: query }]);
    if (!promptText) setInput("");
    setLoading(true);

    try {
      const res = await sendAgentMessage(query, stateCode, county, sessionId);
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
          text: `Error communicating with deployed Cloud Run agent: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`chat-tab-container ${compact ? "compact-chat" : ""}`}>
      {/* Top Status & Controls Card */}
      <div className="card chat-status-card">
        <div className="admin-header-top">
          <div>
            <div className="admin-title-row">
              <h2>✧ Planning assistant</h2>
              <span className={`connection-badge ${connection === "error" ? "preview" : "live"}`}>
                {loading ? "Working…" : connection === "connected" ? "● Connected" : connection === "error" ? "Connection error" : "Ready to connect"}
              </span>
            </div>
            <p className="admin-subtitle">
              {compact ? "Google ADK · Gemini + BigQuery" : <>Endpoint: <code>{DEPLOYED_CLOUD_RUN_URL}</code> · Session: <code>{sessionId}</code></>}
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
            <button
              type="button"
              className="refresh-btn"
              onClick={handleNewSession}
              disabled={loading}
            >
              + New Session
            </button>
          </div>
        </div>

        <div className="chat-prompts-bar">
          <span className="quick-filter-label">Suggested Prompts:</span>
          {(compact ? [
            `Which tracts in ${county} County should we review first?`,
            `Which shelters in ${county} County need an accessibility assessment?`,
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
                    {m.tools_called?.map((tool) => (
                      <span key={tool} className="tool-badge">
                        🔧 {tool}
                      </span>
                    ))}
                    {m.elapsed_seconds !== undefined && (
                      <span className="elapsed-badge">
                        ⏱️ {m.elapsed_seconds}s
                      </span>
                    )}
                  </div>
                )}

              <div className="bubble-text">
                {m.role === "agent" ? renderMarkdownBlocks(m.text) : m.text}
              </div>

              {m.grounding_chunks && m.grounding_chunks.length > 0 && (
                <MapsAttribution chunks={m.grounding_chunks} />
              )}
            </div>
          ))}

          {loading && (
            <div className="chat-bubble agent">
              <div className="bubble-text">
                <strong>Running evac_agent on Cloud Run...</strong> Querying BigQuery & verifying live places/routes with{" "}
                <span translate="no">Google Maps</span> (live verification takes ~12–35s).
              </div>
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
            {loading ? "…" : "Send →"}
          </button>
        </form>
      </div>
    </div>
  );
};
