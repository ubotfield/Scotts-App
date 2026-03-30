import { GoogleGenAI, Modality } from "@google/genai";
import type { LiveServerMessage } from "@google/genai";

/**
 * GeminiLiveService — bidirectional voice with Agentforce relay.
 *
 * Architecture:
 *   User speaks → Gemini Live (captures audio, provides inputTranscription)
 *   → Client intercepts transcription → /api/agent/message → Agentforce response
 *   → Client sends response text to Gemini via sendClientContent
 *   → Gemini speaks it (TTS with Zephyr voice)
 *
 * KEY INSIGHT: Gemini Live in audio-only mode CANNOT do function calling.
 * So we use inputTranscription events to get the user's speech as text,
 * route to Agentforce ourselves, and feed back the response for Gemini to speak.
 */

export interface GeminiCallbacks {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: string) => void;
  onVolumeChange?: (volume: number) => void;
  onStatusChange?: (status: string) => void;
  /** Called when user speech is transcribed. Return the agent's response text for Gemini to speak. */
  onUserTranscription?: (text: string) => Promise<string>;
}

const SYSTEM_INSTRUCTION =
  `You are a text-to-speech relay for Scott's Fresh Kitchens restaurant.

CRITICAL: Do NOT respond to audio input from the user. IGNORE everything the user says via microphone.
You must ONLY speak when you receive a text message that starts with "Please say this to the customer:".
When you receive such a message, speak ONLY the quoted text naturally and warmly. Do not repeat what the user said. Do not acknowledge the user. Do not add any commentary.

If you hear the user speak, do NOTHING. Stay completely silent. Wait for a text relay message.`;

export class GeminiLiveService {
  private ai: GoogleGenAI;
  private session: any = null;
  private callbacks: GeminiCallbacks = {};
  private audioContext: AudioContext | null = null;
  private micAudioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private volumeAnalyser: AnalyserNode | null = null;
  private volumeInterval: number | null = null;
  private playbackQueue: Float32Array[] = [];
  private isPlaying = false;
  private isProcessing = false; // prevent overlapping agent calls
  private pendingTranscript = ""; // accumulate partial transcriptions

  constructor() {
    const apiKey =
      (typeof process !== "undefined" && process.env?.GEMINI_API_KEY) ||
      (import.meta as any).env?.VITE_GEMINI_API_KEY ||
      "";
    console.log("[gemini] API key present:", !!apiKey, "length:", apiKey?.length || 0);
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
          // Enable input transcription so we can intercept user speech
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            console.log("[gemini] Connected");
            callbacks.onStatusChange?.("Connected");
            callbacks.onOpen?.();
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

  /**
   * Send initial greeting through the agent and have Gemini speak it.
   * Call this after connect() resolves and the session is ready.
   */
  async sendGreeting(greetingResponse: string): Promise<void> {
    if (!this.session || !greetingResponse) return;
    console.log("[gemini] Speaking greeting:", greetingResponse.substring(0, 80));
    this.callbacks.onStatusChange?.("Speaking...");
    this.session.sendClientContent({
      turns: [
        {
          role: "user",
          parts: [{ text: `Please say this to the customer: "${greetingResponse}"` }],
        },
      ],
      turnComplete: true,
    });
  }

  private handleServerMessage(message: LiveServerMessage): void {
    const raw = message as any;

    // Handle input transcription — this is the user's speech as text
    if (raw.serverContent?.inputTranscription?.text) {
      const transcript = raw.serverContent.inputTranscription.text.trim();
      if (transcript) {
        console.log("[gemini] User said:", transcript);
        // Route to Agentforce
        this.routeToAgent(transcript);
      }
      return; // Don't process further for transcription messages
    }

    // Handle audio output (Gemini speaking)
    if (raw.serverContent?.modelTurn?.parts) {
      for (const part of raw.serverContent.modelTurn.parts) {
        if (part.inlineData?.data) {
          this.playAudioChunk(part.inlineData.data);
        }
      }
    }

    // Handle turn complete — Gemini finished speaking
    if (raw.serverContent?.turnComplete) {
      console.log("[gemini] Turn complete");
      this.callbacks.onStatusChange?.("Listening...");
    }

    // Handle output transcription (what Gemini said — for debugging)
    if (raw.serverContent?.outputTranscription?.text) {
      console.log("[gemini] Gemini said:", raw.serverContent.outputTranscription.text);
    }
  }

  /**
   * Take user's transcribed speech, send to Agentforce, feed response back to Gemini to speak.
   */
  private async routeToAgent(userText: string): Promise<void> {
    if (this.isProcessing) {
      console.log("[gemini] Already processing, queuing:", userText);
      this.pendingTranscript = userText; // keep latest
      return;
    }

    this.isProcessing = true;
    this.callbacks.onStatusChange?.("Processing...");

    try {
      if (this.callbacks.onUserTranscription) {
        const agentResponse = await this.callbacks.onUserTranscription(userText);
        console.log("[gemini] Agent response:", agentResponse.substring(0, 100));

        // Feed the agent response to Gemini to speak aloud
        if (this.session && agentResponse) {
          this.callbacks.onStatusChange?.("Speaking...");
          this.session.sendClientContent({
            turns: [
              {
                role: "user",
                parts: [{ text: `Please say this to the customer: "${agentResponse}"` }],
              },
            ],
            turnComplete: true,
          });
        }
      }
    } catch (err: any) {
      console.error("[gemini] Agent routing error:", err);
      // Speak an error message
      if (this.session) {
        this.session.sendClientContent({
          turns: [
            {
              role: "user",
              parts: [{ text: 'Please say: "I\'m sorry, I had trouble with that. Could you say it again?"' }],
            },
          ],
          turnComplete: true,
        });
      }
    } finally {
      this.isProcessing = false;

      // Process any queued transcript
      if (this.pendingTranscript) {
        const queued = this.pendingTranscript;
        this.pendingTranscript = "";
        this.routeToAgent(queued);
      }
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

      this.micAudioContext = new AudioContext({ sampleRate: 16000 });
      this.sourceNode = this.micAudioContext.createMediaStreamSource(this.mediaStream);

      // Volume analyser for UI visualization
      this.volumeAnalyser = this.micAudioContext.createAnalyser();
      this.volumeAnalyser.fftSize = 256;
      this.sourceNode.connect(this.volumeAnalyser);
      this.startVolumeMonitor();

      // Use ScriptProcessor for PCM capture
      const processor = this.micAudioContext.createScriptProcessor(4096, 1, 1);
      this.sourceNode.connect(processor);
      processor.connect(this.micAudioContext.destination);

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

    // Close audio contexts
    this.micAudioContext?.close();
    this.micAudioContext = null;
    this.audioContext?.close();
    this.audioContext = null;

    // Clear playback queue
    this.playbackQueue = [];
    this.isPlaying = false;
    this.isProcessing = false;
    this.pendingTranscript = "";

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
