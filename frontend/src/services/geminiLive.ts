import { AgentProgress, streamAgentMessage } from "./agentApi";
import { AgentSchemaOutput, MapsGroundingChunk, RecommendedAction } from "../types/brief";

export type LiveVoiceStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

export interface LiveTurnResult {
  userText: string;
  agentText: string;
  tools_called?: string[];
  elapsed_seconds?: number;
  grounding_chunks?: MapsGroundingChunk[];
  recommended_actions?: RecommendedAction[];
  agent_outputs?: AgentSchemaOutput[];
}

export interface GeminiLiveCallbacks {
  onStatusChange: (status: LiveVoiceStatus, detail?: string) => void;
  onVolume: (level: number) => void;
  onInputTranscript: (text: string, finished: boolean) => void;
  onOutputTranscript: (text: string, finished: boolean) => void;
  onStep: (progress: AgentProgress) => void;
  onTurnComplete: (turn: LiveTurnResult) => void;
  onError: (message: string) => void;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

function buildLiveWsUrl(county: string, state: string, sessionId: string): string {
  const params = new URLSearchParams({
    county,
    state,
    session_id: sessionId,
  });
  if (API_BASE && /^https?:\/\//i.test(API_BASE)) {
    const wsBase = API_BASE.replace(/^http/i, "ws").replace(/\/$/, "");
    return `${wsBase}/api/live?${params.toString()}`;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/live?${params.toString()}`;
}

function floatTo16BitPCMBase64(float32Array: Float32Array): string {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64PCM16ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }
  return float32;
}

/** Strip Markdown tables, links, and formatting symbols so spoken synthesis sounds natural. */
function cleanTextForSpeech(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("|"))
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#~>-]/g, " ")
    .replace(/[🕰️🟢📊🧮🌊❓🗺️📏🚗✧]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
}

export class GeminiLiveSession {
  private callbacks: GeminiLiveCallbacks;
  private county: string;
  private stateCode: string;
  private sessionId: string;

  private ws: WebSocket | null = null;
  private mode: "ws" | "browser" | null = null;
  private status: LiveVoiceStatus = "idle";
  private muted = false;
  private active = false;

  // Audio capture & playback
  private mediaStream: MediaStream | null = null;
  private captureCtx: AudioContext | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  private playbackCtx: AudioContext | null = null;
  private nextPlayTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];

  // Transcript accumulators for current turn
  private currentUserTranscript = "";
  private currentAgentTranscript = "";

  // Browser fallback speech recognition
  private recognition: any = null;
  private browserProcessingTurn = false;

  constructor(
    county: string,
    stateCode: string,
    sessionId: string,
    callbacks: GeminiLiveCallbacks
  ) {
    this.county = county;
    this.stateCode = stateCode;
    this.sessionId = sessionId;
    this.callbacks = callbacks;
  }

  public isActive(): boolean {
    return this.active;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public getMode(): "ws" | "browser" | null {
    return this.mode;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.mediaStream) {
      for (const track of this.mediaStream.getAudioTracks()) {
        track.enabled = !muted;
      }
    }
    if (muted) {
      this.callbacks.onVolume(0);
    }
  }

  public updateContext(county: string, stateCode: string, sessionId: string): void {
    this.county = county;
    this.stateCode = stateCode;
    this.sessionId = sessionId;
  }

  private setStatus(status: LiveVoiceStatus, detail?: string): void {
    this.status = status;
    this.callbacks.onStatusChange(status, detail);
  }

  public async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.muted = false;
    this.currentUserTranscript = "";
    this.currentAgentTranscript = "";
    this.setStatus("connecting", "Starting microphone & Gemini Live…");

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      this.active = false;
      const msg =
        err instanceof Error
          ? `Microphone access denied (${err.message})`
          : "Microphone access denied.";
      this.setStatus("error", msg);
      this.callbacks.onError(msg);
      return;
    }

    // Attempt Gemini Live WebSocket first, with automatic fallback to Browser Live Voice Bridge
    const wsConnected = await this.tryConnectWebSocket();
    if (!this.active) return;

    if (wsConnected) {
      this.mode = "ws";
      this.startMicCapture(true);
      this.setStatus("listening", "Gemini Live connected — speak anytime");
    } else {
      this.mode = "browser";
      this.startMicCapture(false);
      this.startBrowserSpeechRecognition();
      this.setStatus("listening", "Live voice active — speak anytime");
    }
  }

  private tryConnectWebSocket(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };

      const timeoutId = window.setTimeout(() => {
        finish(false);
      }, 12000);

      try {
        const url = buildLiveWsUrl(this.county, this.stateCode, this.sessionId);
        const ws = new WebSocket(url);
        this.ws = ws;

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "ready") {
              window.clearTimeout(timeoutId);
              finish(true);
              return;
            }
            if (msg.type === "error" && !settled) {
              window.clearTimeout(timeoutId);
              finish(false);
              return;
            }
            this.handleWsMessage(msg);
          } catch {
            // ignore malformed frame
          }
        };

        ws.onerror = () => {
          window.clearTimeout(timeoutId);
          finish(false);
        };

        ws.onclose = () => {
          window.clearTimeout(timeoutId);
          if (!settled) {
            finish(false);
          } else if (this.active && this.mode === "ws") {
            // Switch seamlessly to browser voice bridge if WS drops mid-session
            this.mode = "browser";
            this.startBrowserSpeechRecognition();
            this.setStatus("listening", "Live voice active — speak anytime");
          }
        };
      } catch {
        window.clearTimeout(timeoutId);
        finish(false);
      }
    });
  }

  private handleWsMessage(msg: any): void {
    if (!this.active) return;

    switch (msg.type) {
      case "input_transcript": {
        const chunk = String(msg.text || "");
        if (chunk) {
          // If starting a new user utterance while agent was speaking, stop playback
          if (this.status === "speaking") {
            this.stopAudioPlayback();
          }
          this.currentUserTranscript += chunk;
          this.callbacks.onInputTranscript(
            this.currentUserTranscript.trim(),
            Boolean(msg.finished)
          );
        }
        break;
      }

      case "output_transcript": {
        const chunk = String(msg.text || "");
        if (chunk) {
          this.currentAgentTranscript += chunk;
          this.callbacks.onOutputTranscript(
            this.currentAgentTranscript.trim(),
            Boolean(msg.finished)
          );
        }
        break;
      }

      case "audio": {
        if (msg.data) {
          this.setStatus("speaking", "Gemini Live speaking…");
          this.enqueueAudioPCM24k(String(msg.data));
        }
        break;
      }

      case "step": {
        this.setStatus("thinking", `Checking ${msg.tool || "records"}…`);
        if (msg.tool) {
          this.callbacks.onStep({ type: "step", tool: String(msg.tool) });
        }
        break;
      }

      case "step_done": {
        if (msg.tool) {
          this.callbacks.onStep({ type: "step_done", tool: String(msg.tool) });
        }
        break;
      }

      case "interrupted": {
        this.stopAudioPlayback();
        this.setStatus("listening", "Listening…");
        break;
      }

      case "turn_complete": {
        const userText = this.currentUserTranscript.trim();
        const agentText = this.currentAgentTranscript.trim();
        if (userText || agentText) {
          this.callbacks.onTurnComplete({
            userText,
            agentText,
            tools_called: Array.isArray(msg.tools_called) ? msg.tools_called : undefined,
            elapsed_seconds:
              typeof msg.elapsed_seconds === "number" ? msg.elapsed_seconds : undefined,
            grounding_chunks: Array.isArray(msg.grounding_chunks)
              ? msg.grounding_chunks
              : undefined,
            recommended_actions: Array.isArray(msg.recommended_actions)
              ? msg.recommended_actions
              : undefined,
            agent_outputs: Array.isArray(msg.agent_outputs)
              ? msg.agent_outputs
              : undefined,
          });
        }
        this.currentUserTranscript = "";
        this.currentAgentTranscript = "";
        if (this.activeSources.length === 0) {
          this.setStatus("listening", "Listening — speak anytime");
        }
        break;
      }

      case "error": {
        if (msg.message) {
          this.callbacks.onError(String(msg.message));
        }
        break;
      }
    }
  }

  private startMicCapture(streamToWs: boolean): void {
    if (!this.mediaStream) return;

    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    this.captureCtx = new AudioCtx({ sampleRate: 16000 });
    this.sourceNode = this.captureCtx.createMediaStreamSource(this.mediaStream);
    this.processorNode = this.captureCtx.createScriptProcessor(4096, 1, 1);

    this.processorNode.onaudioprocess = (event) => {
      if (!this.active || this.muted) {
        this.callbacks.onVolume(0);
        return;
      }
      const inputData = event.inputBuffer.getChannelData(0);

      // Compute RMS volume level (0.0 to 1.0) for the live voice visualizer
      let sumSquares = 0;
      for (let i = 0; i < inputData.length; i++) {
        sumSquares += inputData[i] * inputData[i];
      }
      const rms = Math.sqrt(sumSquares / inputData.length);
      const normalized = Math.min(1, rms * 6.5);
      this.callbacks.onVolume(normalized);

      if (
        streamToWs &&
        this.mode === "ws" &&
        this.ws &&
        this.ws.readyState === WebSocket.OPEN
      ) {
        const b64 = floatTo16BitPCMBase64(inputData);
        this.ws.send(JSON.stringify({ type: "audio", data: b64 }));
      }
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.captureCtx.destination);
  }

  private enqueueAudioPCM24k(b64Data: string): void {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!this.playbackCtx) {
      this.playbackCtx = new AudioCtx({ sampleRate: 24000 });
    }
    if (this.playbackCtx.state === "suspended") {
      this.playbackCtx.resume().catch(() => {});
    }

    const float32 = base64PCM16ToFloat32(b64Data);
    if (float32.length === 0) return;

    const audioBuffer = this.playbackCtx.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);

    const source = this.playbackCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.playbackCtx.destination);

    const now = this.playbackCtx.currentTime;
    if (this.nextPlayTime < now) {
      this.nextPlayTime = now + 0.02;
    }
    source.start(this.nextPlayTime);
    this.nextPlayTime += audioBuffer.duration;
    this.activeSources.push(source);

    source.onended = () => {
      this.activeSources = this.activeSources.filter((s) => s !== source);
      if (this.activeSources.length === 0 && this.active && this.status === "speaking") {
        this.setStatus("listening", "Listening — speak anytime");
      }
    };
  }

  public stopAudioPlayback(): void {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        // ignore
      }
    }
    this.activeSources = [];
    this.nextPlayTime = 0;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  /** Send a text or spoken prompt directly through the active session and speak the response. */
  public async sendPrompt(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    this.stopAudioPlayback();

    if (this.active && this.mode === "ws" && this.ws?.readyState === WebSocket.OPEN) {
      this.currentUserTranscript = trimmed;
      this.currentAgentTranscript = "";
      this.callbacks.onInputTranscript(trimmed, true);
      this.setStatus("thinking", "Gemini Live is thinking…");
      this.ws.send(JSON.stringify({ type: "text", text: trimmed }));
      return;
    }

    await this.runBrowserVoiceTurn(trimmed);
  }

  private startBrowserSpeechRecognition(): void {
    const SpeechRec =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) {
      return;
    }

    const recognition = new SpeechRec();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    this.recognition = recognition;

    recognition.onresult = (event: any) => {
      if (!this.active || this.muted) return;

      let interim = "";
      let finalChunk = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          finalChunk += res[0].transcript;
        } else {
          interim += res[0].transcript;
        }
      }

      if (interim.trim()) {
        if (this.status === "speaking") {
          this.stopAudioPlayback();
        }
        this.callbacks.onInputTranscript(interim.trim(), false);
      }

      if (finalChunk.trim() && !this.browserProcessingTurn) {
        const spokenText = finalChunk.trim();
        this.callbacks.onInputTranscript(spokenText, true);
        void this.runBrowserVoiceTurn(spokenText);
      }
    };

    recognition.onerror = () => {
      // Automatically recover unless stopped
    };

    recognition.onend = () => {
      if (this.active && this.mode === "browser") {
        try {
          recognition.start();
        } catch {
          // ignore if already started
        }
      }
    };

    try {
      recognition.start();
    } catch {
      // ignore
    }
  }

  private async runBrowserVoiceTurn(userText: string): Promise<void> {
    this.browserProcessingTurn = true;
    this.setStatus("thinking", "Working on your spoken question…");

    try {
      const res = await streamAgentMessage(
        userText,
        this.stateCode,
        this.county,
        this.sessionId,
        (p) => {
          this.callbacks.onStep(p);
        }
      );

      if (!this.active) {
        this.callbacks.onTurnComplete({
          userText,
          agentText: res.reply,
          tools_called: res.tools_called,
          elapsed_seconds: res.elapsed_seconds,
          grounding_chunks: res.grounding_chunks,
          recommended_actions: res.recommended_actions,
          agent_outputs: res.agent_outputs,
        });
        return;
      }

      this.callbacks.onOutputTranscript(res.reply, true);
      this.callbacks.onTurnComplete({
        userText,
        agentText: res.reply,
        tools_called: res.tools_called,
        elapsed_seconds: res.elapsed_seconds,
        grounding_chunks: res.grounding_chunks,
        recommended_actions: res.recommended_actions,
        agent_outputs: res.agent_outputs,
      });

      this.speakWithBrowserSynthesis(res.reply);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.callbacks.onError(msg);
      if (this.active) {
        this.setStatus("listening", "Listening — speak anytime");
      }
    } finally {
      this.browserProcessingTurn = false;
    }
  }

  private speakWithBrowserSynthesis(markdownReply: string): void {
    if (!("speechSynthesis" in window) || !this.active) {
      if (this.active) {
        this.setStatus("listening", "Listening — speak anytime");
      }
      return;
    }

    window.speechSynthesis.cancel();
    const cleanSpeech = cleanTextForSpeech(markdownReply);
    if (!cleanSpeech) {
      this.setStatus("listening", "Listening — speak anytime");
      return;
    }

    const utterance = new SpeechSynthesisUtterance(cleanSpeech);
    utterance.rate = 1.03;
    utterance.onstart = () => {
      if (this.active) {
        this.setStatus("speaking", "Speaking response…");
      }
    };
    utterance.onend = () => {
      if (this.active) {
        this.setStatus("listening", "Listening — speak anytime");
      }
    };
    utterance.onerror = () => {
      if (this.active) {
        this.setStatus("listening", "Listening — speak anytime");
      }
    };
    window.speechSynthesis.speak(utterance);
  }

  public stop(): void {
    this.active = false;
    this.muted = false;
    this.mode = null;
    this.currentUserTranscript = "";
    this.currentAgentTranscript = "";

    this.stopAudioPlayback();

    if (this.recognition) {
      try {
        this.recognition.onend = null;
        this.recognition.stop();
      } catch {
        // ignore
      }
      this.recognition = null;
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }

    if (this.processorNode) {
      try {
        this.processorNode.disconnect();
      } catch {
        // ignore
      }
      this.processorNode = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // ignore
      }
      this.sourceNode = null;
    }

    if (this.captureCtx) {
      try {
        this.captureCtx.close();
      } catch {
        // ignore
      }
      this.captureCtx = null;
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    this.callbacks.onVolume(0);
    this.setStatus("idle");
  }
}
