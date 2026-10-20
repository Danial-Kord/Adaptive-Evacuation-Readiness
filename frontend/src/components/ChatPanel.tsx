import React, { useState } from "react";
import { sendAgentMessage } from "../services/agentApi";
import { MapsGroundingChunk } from "../types/brief";
import { MapsAttribution } from "./MapsAttribution";

interface ChatMessage {
  role: "user" | "agent";
  text: string;
  grounding_chunks?: MapsGroundingChunk[];
}

interface ChatPanelProps {
  stateCode: string;
  county: string;
}

const SUGGESTED_QUESTIONS = [
  "Which neighborhoods in my county would struggle most to self-evacuate?",
  "Which shelters can take a wheelchair, and how many are simply unrecorded?",
  "Verify our top candidate shelters live on Google Maps—are they still open and accessible?",
  "How many residents depend on electricity for medical equipment, and where are the generator gaps?",
];

export const ChatPanel: React.FC<ChatPanelProps> = ({ stateCode, county }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "agent",
      text: `Ready to build the August Readiness Brief for ${county}, ${stateCode}. Ask any of the 7 emergency manager planning questions or click a prompt below.`,
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSend = async (promptText?: string) => {
    const query = (promptText ?? input).trim();
    if (!query || loading) return;

    setMessages((prev) => [...prev, { role: "user", text: query }]);
    if (!promptText) setInput("");
    setLoading(true);

    try {
      const res = await sendAgentMessage(query, stateCode, county);
      setMessages((prev) => [
        ...prev,
        {
          role: "agent",
          text: res.reply,
          grounding_chunks: res.grounding_chunks,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "agent",
          text: `Backend connection note: Start the ADK FastAPI server (\`uvicorn server:app --port 8080\` in \`agent/\`) to run live queries. Details: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <aside className="chat-panel">
      <div className="chat-header">
        <h2>ADK Planning Agent</h2>
        <span className="model-tag">Gemini 3.x + BigQuery + Maps Grounding</span>
      </div>

      <div className="suggested-prompts">
        {SUGGESTED_QUESTIONS.map((q) => (
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

      <div className="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className={`chat-bubble ${m.role}`}>
            <div className="bubble-text">{m.text}</div>
            {m.grounding_chunks && m.grounding_chunks.length > 0 && (
              <MapsAttribution chunks={m.grounding_chunks} />
            )}
          </div>
        ))}
        {loading && (
          <div className="chat-bubble agent">
            <div className="bubble-text">Querying BigQuery & grounding with Google Maps...</div>
          </div>
        )}
      </div>

      <form
        className="chat-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
      >
        <input
          type="text"
          placeholder={`Ask about ${county} tracts, shelters, or medical power needs...`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
        />
        <button type="submit" disabled={loading || !input.trim()}>
          Ask Agent
        </button>
      </form>
    </aside>
  );
};
