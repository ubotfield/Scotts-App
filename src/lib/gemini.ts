import { GoogleGenAI, Modality, Type } from "@google/genai";
import type { FunctionCall, LiveServerMessage } from "@google/genai";

/**
 * GeminiLiveService — bidirectional voice with Agentforce relay via function calling.
 *
 * Architecture:
 *   User speaks → Gemini Live (STT) → detects user intent → calls sendToAgent function
 *   → client intercepts → /api/agent/message → Agentforce response
 *   → function result returned to Gemini → Gemini speaks it (TTS)
 *
 * Gemini handles ONLY voice I/O. Agentforce handles ALL ordering/loyalty logic.
 */

export interface GeminiCallbacks {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: string) => void;
  onVolumeChange?: (volume: number) => void;
  onStatusChange?: (status: string) => void;
  onMessage?: (message: LiveServerMessage) => void;
  /** Called when Gemini wants to invoke a function (sendToAgent). Return the agent's response. */
  onFunctionCall?: (name: string, args: Record<string, unknown>) => Promise<string>;
}

// The one tool Gemini knows about — routes all user speech to Agentforce
const SEND_TO_AGENT_TOOL = {
  functionDeclarations: [
    {
      name: "sendToAgent",
      description:
        "Send the user's message to the restaurant ordering agent and get a response. " +
        "Call this function for EVERY user utterance — you do not answer questions yourself.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          userMessage: {
            type: Type.STRING,
            description: "The user's spoken message to send to the agent",
          },
        },
        required: ["userMessage"],
      },
    },
  ],
};

const SYSTEM_INSTRUCTION =
  `You are a voice relay for Scott's Fresh Kitchens restaurant. Your ONLY job is:
1. Listen to what the customer says
2. Call the sendToAgent function with their exact words
3. When you get the function response, speak it out loud naturally and warmly

CRITICAL RULES:
- NEVER answer questions yourself — ALWAYS call sendToAgent for every user message
- NEVER make up menu items, prices, or order details
- When speaking the agent's response, be natural, warm, and conversational
- Do not add extra commentary beyond what the agent says
- If the user says hello or any greeting, call sendToAgent with their greeting
- Start by calling sendToAgent with "Hello" to get the initial greeting`;

export class GeminiLiveService {
  private ai: GoogleGenAI;
  private session: any = null;
  private callbacks: GeminiCallbacks = {};
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private audioWorklet: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private volumeAnalyser: AnalyserNode | null = null;
  private volumeInterval: number | null = null;
  private playbackQueue: Float32Array[] = [];
  private isPlaying = false;

  constructor() {
    const apiKey =
      (typeof process !== "undefined" && process.env?.GEMINI_API_KEY) ||
      (import.meta as any).env?.VITE_GEMINI_API_KEY ||
      "";
    if (!apiKey) {
      console.warn("[gemini] No GEMINI_API_KEY found — voice will be unavailable");
    }
    this.ai = new GoogleGenAI({ apiKey });
  }

  async connect(callbacks: GeminiCallbacks): Promise<void> {
    this.callbacks = callbacks;
    callbacks.onStatusChange?.("Connecting...");

    try {
      // Set up audio context for playback
      this.audioContext = new AudioContext({ sampleRate: 24000 });

      this.session = await this.ai.live.connect({
        model: "gemini-2.0-flash-live-preview-04-09",
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Zephyr" },
            },
          },
          tools: [SEND_TO_AGENT_TOOL],
        },
        callbacks: {
          onopen: () => {
            console.log("[gemini] Connected");
            callbacks.onStatusChange?.("Connected");
            callbacks.onOpen?.();
            // Start capturing mic audio
            this.startMicCapture();
          },
          onmessage: (message: LiveServerMessage) => {
            this.handleServerMessage(message);
          },
          onclose: () => {
            console.log("[gemini] Connection closed");
            callbacks.onClose?.();
          },
          onerror: (error: any) => {
            console.error("[gemini] Error:", error);
            const errorMsg = error?.message || String(error);
            callbacks.onStatusChange?.(errorMsg);
            callbacks.onError?.(errorMsg);
          },
        },
      });
    } catch (err: any) {
      console.error("[gemini] Connection failed:", err);
      callbacks.onStatusChange?.("Failed to connect");
      callbacks.onError?.(err.message || "Connection failed");
      throw err;
    }
  }

  private handleServerMessage(message: LiveServerMessage): void {
    // Handle audio output (TTS)
    if (message.serverContent?.modelTurn?.parts) {
      for (const part of message.serverContent.modelTurn.parts) {
        if (part.inlineData?.data) {
          this.playAudioChunk(part.inlineData.data);
        }
      }
    }

    // Handle turn complete
    if (message.serverContent?.turnComplete) {
      this.callbacks.onStatusChange?.("Listening...");
    }

    // Handle function calls from Gemini
    if (message.toolCall?.functionCalls) {
      this.handleFunctionCalls(message.toolCall.functionCalls);
    }

    // Pass through for external handling
    this.callbacks.onMessage?.(message);
  }

  private async handleFunctionCalls(functionCalls: FunctionCall[]): Promise<void> {
    const responses: Array<{ id: string; name: string; response: Record<string, unknown> }> = [];

    for (const call of functionCalls) {
      if (call.name === "sendToAgent" && this.callbacks.onFunctionCall) {
        this.callbacks.onStatusChange?.("Processing...");
        try {
          const agentResponse = await this.callbacks.onFunctionCall(
            call.name,
            (call.args as Record<string, unknown>) || {}
          );
          responses.push({
            id: call.id || "",
            name: call.name,
            response: { output: agentResponse },
          });
        } catch (err: any) {
          console.error("[gemini] Function call error:", err);
          responses.push({
            id: call.id || "",
            name: call.name || "sendToAgent",
            response: {
              error: err.message || "Failed to reach the restaurant agent",
            },
          });
        }
      }
    }

    // Send function responses back to Gemini so it can speak them
    if (responses.length > 0 && this.session) {
      this.callbacks.onStatusChange?.("Speaking...");
      this.session.sendToolResponse({
        functionResponses: responses,
      });
    }
  }

  // ─── Audio Capture (Mic → Gemini) ────────────────────────────

  private async startMicCapture(): Promise<void> {
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

      const ctx = new AudioContext({ sampleRate: 16000 });
      this.sourceNode = ctx.createMediaStreamSource(this.mediaStream);

      // Volume analyser for UI visualization
      this.volumeAnalyser = ctx.createAnalyser();
      this.volumeAnalyser.fftSize = 256;
      this.sourceNode.connect(this.volumeAnalyser);
      this.startVolumeMonitor();

      // Use ScriptProcessor for PCM capture (AudioWorklet needs separate file)
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      this.sourceNode.connect(processor);
      processor.connect(ctx.destination);

      processor.onaudioprocess = (event) => {
        if (!this.session) return;
        const inputData = event.inputBuffer.getChannelData(0);

        // Convert float32 to int16 PCM
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Convert to base64
        const bytes = new Uint8Array(pcm16.buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        // Send audio to Gemini
        this.session.sendRealtimeInput({
          audio: {
            data: base64,
            mimeType: "audio/pcm;rate=16000",
          },
        });
      };

      this.callbacks.onStatusChange?.("Listening...");
    } catch (err: any) {
      console.error("[gemini] Mic capture failed:", err);
      this.callbacks.onStatusChange?.("Microphone access denied");
      this.callbacks.onError?.(err.message || "Microphone access failed");
    }
  }

  private startVolumeMonitor(): void {
    if (!this.volumeAnalyser) return;
    const dataArray = new Uint8Array(this.volumeAnalyser.frequencyBinCount);

    const check = () => {
      if (!this.volumeAnalyser) return;
      this.volumeAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const average = sum / dataArray.length / 255;
      this.callbacks.onVolumeChange?.(average);
      this.volumeInterval = requestAnimationFrame(check) as unknown as number;
    };
    check();
  }

  // ─── Audio Playback (Gemini → Speaker) ───────────────────────

  private playAudioChunk(base64Data: string): void {
    if (!this.audioContext) return;

    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 0x7fff;

    this.playbackQueue.push(float32);
    if (!this.isPlaying) {
      this.drainPlaybackQueue();
    }
  }

  private drainPlaybackQueue(): void {
    if (!this.audioContext || this.playbackQueue.length === 0) {
      this.isPlaying = false;
      return;
    }
    this.isPlaying = true;

    const float32 = this.playbackQueue.shift()!;
    const buffer = this.audioContext.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    source.onended = () => this.drainPlaybackQueue();
    source.start();
  }

  // ─── Disconnect ──────────────────────────────────────────────

  disconnect(): void {
    // Stop volume monitor
    if (this.volumeInterval) {
      cancelAnimationFrame(this.volumeInterval);
      this.volumeInterval = null;
    }

    // Stop mic
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    this.sourceNode = null;
    this.volumeAnalyser = null;

    // Close audio context
    this.audioContext?.close();
    this.audioContext = null;

    // Clear playback queue
    this.playbackQueue = [];
    this.isPlaying = false;

    // Close Gemini session
    if (this.session) {
      try {
        this.session.close();
      } catch {
        // Ignore close errors
      }
      this.session = null;
    }
  }

  get isConnected(): boolean {
    return this.session !== null;
  }
}
