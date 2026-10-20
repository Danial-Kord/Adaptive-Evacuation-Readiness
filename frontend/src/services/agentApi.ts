import sampleBrief from "../mocks/sampleBrief.json";
import { ChatResponse, ReadinessBriefData } from "../types/brief";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

export async function fetchReadinessBrief(_state: string, _county: string): Promise<ReadinessBriefData> {
  // Returns the structured baseline brief immediately while the live agent chat handles ad-hoc queries
  return sampleBrief as ReadinessBriefData;
}

export async function sendAgentMessage(
  message: string,
  state: string,
  county: string,
  sessionId = "manager-session-01"
): Promise<ChatResponse> {
  const response = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      state,
      county,
      session_id: sessionId,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Agent API error (${response.status}): ${errText}`);
  }

  return response.json();
}
