/**
 * NativeVoiceService — Cross-platform voice with dual STT strategy:
 *
 *   Strategy A (Safari browser only): Web Speech API (SpeechRecognition)
 *   Strategy B (Everything else): MediaRecorder -> server-side Gemini STT
 *
 * Both strategies share the same TTS pipeline:
 *   Server ElevenLabs TTS -> <audio> element / AudioContext / browser speechSynthesis
 *
 * KEY DESIGN (v3 — iOS-proof):
 *   - MediaRecorder pipeline is COMPLETELY INDEPENDENT of AudioContext.
 *   - Recording uses simple timer-based 4-second chunks. No silence detection.
 *   - After every TTS playback, a FRESH MediaStream is acquired via getUserMedia().
 *   - AudioContext is ONLY used for cosmetic volume bars in the UI.
 *   - Explicit state machine prevents stuck states: idle → recording → transcribing → speaking → idle
 */

import { apiUrl } from "./api-base";

export interface NativeVoiceCallbacks {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: string) => void;
  onVolumeChange?: (volume: number) => void;
  onStatusChange?: (status: string) => void;
  /** Called when user speech is transcribed. Return the agent's response text. */
  onUserTranscription?: (text: string) => Promise<string>;
}

/** Which STT strategy is in use */
type SttMode = "speech-recognition" | "media-recorder";

/** Recording pipeline state machine */
type PipelineState = "idle" | "recording" | "transcribing" | "speaking";

/**
 * Detect if we're in a PWA standalone context (homescreen app).
 */
function isStandalonePWA(): boolean {
  if ((navigator as any).standalone === true) return true;
  if (window.matchMedia?.("(display-mode: standalone)")?.matches) return true;
  if (window.matchMedia?.("(display-mode: fullscreen)")?.matches) return true;
  return false;
}

export class NativeVoiceService {
  // -- Shared state --
  private callbacks: NativeVoiceCallbacks = {};
  private _isConnected = false;
  private shouldRestart = false;
  private greetingDone = false;

  // -- Pipeline state machine --
  private pipelineState: PipelineState = "idle";

  // -- Audio resources --
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null; // ONLY for volume UI
  private playbackContext: AudioContext | null = null;
  private volumeAnalyser: AnalyserNode | null = null;
  private volumeInterval: number | null = null;

  // -- STT mode --
  private sttMode: SttMode = "speech-recognition";

  // Strategy A: Web Speech API
  private recognition: any = null;

  // Strategy B: MediaRecorder + server STT
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private chunkTimer: number | null = null;
  private supportedMimeType: string = "audio/mp4";

  // Safety
  private pipelineSafetyTimer: number | null = null;

  // Volume tracking for silence detection
  private peakVolumeDuringChunk = 0;
  private consecutiveSilentChunks = 0;
  private static readonly SILENCE_THRESHOLD = 0.005; // very low — only skip truly silent chunks
  private static readonly MAX_SILENT_SKIPS = 2; // after 2 silent skips, force STT anyway

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(callbacks: NativeVoiceCallbacks): Promise<void> {
    this.callbacks = callbacks;
    callbacks.onStatusChange?.("Connecting...");

    // Detect STT strategy
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    const isPWA = isStandalonePWA();

    if (isPWA) {
      this.sttMode = "media-recorder";
      console.log("[native-voice] PWA standalone detected — forcing MediaRecorder mode");
    } else if (SpeechRecognition) {
      this.sttMode = "speech-recognition";
    } else {
      this.sttMode = "media-recorder";
    }
    console.log("[native-voice] STT mode:", this.sttMode, "isPWA:", isPWA);

    try {
      // Request microphone
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Set up volume monitoring (cosmetic only — recording does NOT depend on this)
      this.setupVolumeMonitor(this.mediaStream);

      // Pre-warm playback AudioContext for iOS
      this.playbackContext = new AudioContext();
      await this.playbackContext.resume();

      // Play silent buffer to unlock iOS audio
      try {
        const silentBuffer = this.playbackContext.createBuffer(1, 1, 22050);
        const silentSource = this.playbackContext.createBufferSource();
        silentSource.buffer = silentBuffer;
        silentSource.connect(this.playbackContext.destination);
        silentSource.start(0);
      } catch (e) {
        console.warn("[native-voice] Silent buffer play failed:", e);
      }

      // Pre-warm browser speechSynthesis (fallback TTS)
      if ("speechSynthesis" in window) {
        const warmup = new SpeechSynthesisUtterance("");
        warmup.volume = 0;
        window.speechSynthesis.speak(warmup);
      }

      // Detect supported MIME type for MediaRecorder
      if (this.sttMode === "media-recorder") {
        this.supportedMimeType = this.getSupportedMimeType();
        console.log("[native-voice] MediaRecorder MIME:", this.supportedMimeType);
      }

      // For speech-recognition mode, start immediately.
      // For media-recorder mode, wait until after greeting (sendGreeting).
      this.shouldRestart = true;
      if (this.sttMode === "speech-recognition") {
        this.setupRecognition();
        try {
          this.recognition.start();
        } catch (e) {
          console.warn("[native-voice] Initial recognition.start() failed:", e);
        }
      }

      this._isConnected = true;
      callbacks.onOpen?.();
      callbacks.onStatusChange?.("Connected");
    } catch (err: any) {
      console.error("[native-voice] Failed to connect:", err);
      callbacks.onError?.(err.message || "Connection failed");
      callbacks.onStatusChange?.("Failed to connect");
      throw err;
    }
  }

  // ===================================================================
  // Strategy A: Web Speech API (SpeechRecognition)
  // ===================================================================

  private restartRecognition(): void {
    if (this.sttMode !== "speech-recognition") {
      this.startRecordingChunk();
      return;
    }

    setTimeout(() => {
      if (!this.shouldRestart || !this._isConnected) return;

      try {
        if (this.recognition) {
          this.recognition.start();
          return;
        }
      } catch (err) {
        console.warn("[native-voice] recognition.start() failed, recreating:", err);
      }

      try {
        this.setupRecognition();
        this.recognition?.start();
      } catch (err2) {
        console.error("[native-voice] Failed to recreate recognition:", err2);
        setTimeout(() => {
          if (!this.shouldRestart || !this._isConnected) return;
          try {
            this.setupRecognition();
            this.recognition?.start();
          } catch (err3) {
            console.error("[native-voice] Final recognition attempt failed:", err3);
            this.callbacks.onStatusChange?.("Tap mic to retry");
          }
        }, 1000);
      }
    }, 300);
  }

  private setupRecognition(): void {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) return;

    try { this.recognition?.stop(); } catch { /* ignore */ }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = false;
    this.recognition.lang = "en-US";
    this.recognition.maxAlternatives = 1;

    this.recognition.onstart = () => {
      console.log("[native-voice] Recognition started");
      if (this.shouldRestart) {
        this.callbacks.onStatusChange?.("Listening...");
      }
    };

    this.recognition.onresult = (event: any) => {
      const last = event.results[event.results.length - 1];
      if (last.isFinal) {
        const text = last[0].transcript.trim();
        if (text) {
          console.log("[native-voice] User said:", text);
          this.routeToAgent(text);
        }
      }
    };

    this.recognition.onerror = (event: any) => {
      console.error("[native-voice] Recognition error:", event.error);
      if (event.error === "no-speech" || event.error === "aborted") {
        if (this.shouldRestart && this._isConnected) {
          this.restartRecognition();
        }
        return;
      }
      this.callbacks.onError?.(event.error);
    };

    this.recognition.onend = () => {
      console.log("[native-voice] Recognition ended, shouldRestart:", this.shouldRestart);
      if (this.shouldRestart && this._isConnected) {
        this.restartRecognition();
      }
    };
  }

  // ===================================================================
  // Strategy B: MediaRecorder -> Server-side STT
  // COMPLETELY INDEPENDENT OF AudioContext.
  // Uses simple timer-based 4-second recording chunks.
  // ===================================================================

  private static readonly CHUNK_DURATION_MS = 6000;
  private static readonly MIN_AUDIO_SIZE = 2000; // bytes — skip tiny recordings

  /**
   * Start a single recording chunk. Records for CHUNK_DURATION_MS,
   * then stops and sends to STT. Creates a fresh MediaRecorder each time.
   */
  private startRecordingChunk(): void {
    if (!this._isConnected || !this.shouldRestart) {
      console.log("[native-voice] Not starting chunk: connected:", this._isConnected, "shouldRestart:", this.shouldRestart);
      return;
    }
    if (this.pipelineState !== "idle") {
      console.log("[native-voice] Not starting chunk: pipeline state is", this.pipelineState);
      return;
    }

    // Verify media stream is alive
    if (!this.mediaStream) {
      console.warn("[native-voice] No media stream, cannot record");
      this.callbacks.onStatusChange?.("Mic error — tap to retry");
      return;
    }
    const tracks = this.mediaStream.getAudioTracks();
    if (tracks.length === 0 || tracks[0].readyState !== "live") {
      console.warn("[native-voice] Media stream tracks not live:", tracks[0]?.readyState);
      this.callbacks.onStatusChange?.("Mic error — tap to retry");
      return;
    }

    this.pipelineState = "recording";
    this.callbacks.onStatusChange?.("Listening...");
    this.recordedChunks = [];
    this.peakVolumeDuringChunk = 0; // Reset volume tracking for this chunk

    console.log("[native-voice] Starting recording chunk (", NativeVoiceService.CHUNK_DURATION_MS, "ms)");

    try {
      const options: MediaRecorderOptions = this.supportedMimeType
        ? { mimeType: this.supportedMimeType, audioBitsPerSecond: 64000 }
        : { audioBitsPerSecond: 64000 };

      this.mediaRecorder = new MediaRecorder(this.mediaStream, options);
    } catch (err) {
      console.warn("[native-voice] MediaRecorder with MIME failed, trying default:", err);
      try {
        this.mediaRecorder = new MediaRecorder(this.mediaStream);
        this.supportedMimeType = this.mediaRecorder.mimeType || "audio/mp4";
      } catch (err2) {
        console.error("[native-voice] MediaRecorder completely failed:", err2);
        this.pipelineState = "idle";
        this.callbacks.onStatusChange?.("Voice not available");
        this.callbacks.onError?.("Cannot record audio on this device");
        return;
      }
    }

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.recordedChunks.push(event.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      console.log("[native-voice] MediaRecorder stopped, chunks:", this.recordedChunks.length, "peakVol:", this.peakVolumeDuringChunk.toFixed(3));
      this.clearChunkTimer();

      if (this.recordedChunks.length > 0 && this.pipelineState === "recording") {
        const actualMime = this.mediaRecorder?.mimeType || this.supportedMimeType;
        const blob = new Blob(this.recordedChunks, { type: actualMime });
        this.recordedChunks = [];

        // Skip STT if chunk was truly silent AND we haven't skipped too many in a row
        const isSilent = this.peakVolumeDuringChunk < NativeVoiceService.SILENCE_THRESHOLD;
        const tooManySilentSkips = this.consecutiveSilentChunks >= NativeVoiceService.MAX_SILENT_SKIPS;

        if (isSilent && !tooManySilentSkips) {
          this.consecutiveSilentChunks++;
          console.log("[native-voice] Silent chunk (peak:", this.peakVolumeDuringChunk.toFixed(4), "), skip #" + this.consecutiveSilentChunks);
          this.pipelineState = "idle";
          this.scheduleNextChunk();
        } else if (blob.size > NativeVoiceService.MIN_AUDIO_SIZE) {
          // Reset silent counter — we're sending this chunk
          this.consecutiveSilentChunks = 0;
          console.log("[native-voice] Sending", Math.round(blob.size / 1024), "KB for transcription");
          this.pipelineState = "transcribing";
          this.transcribeAndRoute(blob, actualMime);
        } else {
          console.log("[native-voice] Audio too short (", blob.size, "bytes), restarting");
          this.pipelineState = "idle";
          this.scheduleNextChunk();
        }
      } else {
        this.recordedChunks = [];
        if (this.pipelineState === "recording") {
          this.pipelineState = "idle";
          this.scheduleNextChunk();
        }
      }
    };

    this.mediaRecorder.onerror = (event: any) => {
      console.error("[native-voice] MediaRecorder error:", event.error || event);
      this.clearChunkTimer();
      this.pipelineState = "idle";
      this.scheduleNextChunk();
    };

    // Start recording with timeslice (collects data every 250ms)
    this.mediaRecorder.start(250);

    // Timer to stop recording after CHUNK_DURATION_MS
    this.chunkTimer = window.setTimeout(() => {
      this.chunkTimer = null;
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        console.log("[native-voice] Chunk timer fired, stopping recorder");
        try {
          this.mediaRecorder.stop();
        } catch (e) {
          console.warn("[native-voice] Stop error:", e);
          this.pipelineState = "idle";
          this.scheduleNextChunk();
        }
      }
    }, NativeVoiceService.CHUNK_DURATION_MS);
  }

  private clearChunkTimer(): void {
    if (this.chunkTimer !== null) {
      clearTimeout(this.chunkTimer);
      this.chunkTimer = null;
    }
  }

  /** Schedule the next recording chunk after a short delay */
  private scheduleNextChunk(): void {
    if (!this.shouldRestart || !this._isConnected) return;
    setTimeout(() => {
      if (this.shouldRestart && this._isConnected && this.pipelineState === "idle") {
        this.startRecordingChunk();
      }
    }, 300);
  }

  /**
   * Transcribe audio and route to agent if speech detected.
   * On completion (or failure), restart the recording pipeline.
   */
  private async transcribeAndRoute(blob: Blob, mimeType: string): Promise<void> {
    // Safety timeout: if transcription + agent + TTS takes > 45s, force reset
    this.clearPipelineSafety();
    this.pipelineSafetyTimer = window.setTimeout(() => {
      console.error("[native-voice] ⚠️ Pipeline stuck for 45s — force resetting");
      this.pipelineState = "idle";
      if (this._isConnected) {
        this.callbacks.onStatusChange?.("Listening...");
        this.scheduleNextChunk();
      }
    }, 45000);

    try {
      // Don't show "Processing..." yet — keep "Listening..." until we confirm speech was detected.
      // This prevents the visible Listening ↔ Processing loop on silent chunks.

      // Convert blob to base64
      const base64 = await this.blobToBase64(blob);

      console.log("[native-voice] Sending audio for STT:", Math.round(blob.size / 1024), "KB");
      const sttStart = Date.now();

      const res = await fetch(apiUrl("/api/stt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: base64,
          mimeType: mimeType.split(";")[0],
        }),
      });

      console.log("[native-voice] STT response in", Date.now() - sttStart, "ms, status:", res.status);

      if (!res.ok) {
        console.error("[native-voice] STT request failed:", res.status);
        this.pipelineState = "idle";
        this.scheduleNextChunk();
        return;
      }

      const data = await res.json();
      const text = data.text?.trim();

      if (text && text.length > 0) {
        console.log("[native-voice] STT result:", text);
        this.callbacks.onStatusChange?.("Processing..."); // NOW show Processing — we have actual speech
        await this.routeToAgent(text);
      } else {
        console.log("[native-voice] No speech detected, restarting");
        this.pipelineState = "idle";
        this.scheduleNextChunk();
      }
    } catch (err) {
      console.error("[native-voice] Transcription error:", err);
      this.pipelineState = "idle";
      this.scheduleNextChunk();
    } finally {
      this.clearPipelineSafety();
    }
  }

  private clearPipelineSafety(): void {
    if (this.pipelineSafetyTimer !== null) {
      clearTimeout(this.pipelineSafetyTimer);
      this.pipelineSafetyTimer = null;
    }
  }

  private getSupportedMimeType(): string {
    const types = [
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
    ];
    for (const type of types) {
      try {
        if (MediaRecorder.isTypeSupported(type)) return type;
      } catch { /* ignore */ }
    }
    return "";
  }

  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(",")[1] || "";
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ===================================================================
  // Shared: Greeting, Agent routing, TTS
  // ===================================================================

  async sendGreeting(greetingResponse: string): Promise<void> {
    if (!greetingResponse) {
      this.greetingDone = true;
      if (this.sttMode === "media-recorder") {
        this.startRecordingChunk();
      }
      return;
    }

    console.log("[native-voice] Speaking greeting:", greetingResponse.substring(0, 80));
    this.callbacks.onStatusChange?.("Speaking...");
    this.pipelineState = "speaking";

    // For speech-recognition mode, pause while speaking
    if (this.sttMode === "speech-recognition") {
      this.pauseListening();
    }

    await this.speakText(greetingResponse);

    // Small delay before starting/resuming listening
    await new Promise(r => setTimeout(r, 300));

    this.greetingDone = true;
    this.pipelineState = "idle";

    if (this.sttMode === "speech-recognition") {
      await this.resumeListening();
    } else {
      // CRITICAL: Get a FRESH mic stream after TTS playback.
      // iOS corrupts the audio session after playback.
      await this.refreshMicStream();

      this.callbacks.onStatusChange?.("Listening...");
      if (this._isConnected && this.shouldRestart) {
        this.startRecordingChunk();
      }
    }
  }

  private pauseListening(): void {
    console.log("[native-voice] Pausing listening (mode:", this.sttMode + ")");
    this.shouldRestart = false;

    if (this.sttMode === "speech-recognition") {
      try { this.recognition?.stop(); } catch { /* ignore */ }
    } else {
      // Stop any active recording
      this.clearChunkTimer();
      try {
        if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
          this.mediaRecorder.stop();
        }
      } catch { /* ignore */ }
    }
  }

  private async resumeListening(): Promise<void> {
    console.log("[native-voice] Resuming listening (mode:", this.sttMode + ")");
    this.shouldRestart = true;
    if (!this._isConnected) return;

    this.callbacks.onStatusChange?.("Listening...");

    if (this.sttMode === "speech-recognition") {
      this.restartRecognition();
    } else {
      // Get fresh mic stream after TTS
      try {
        await this.refreshMicStream();
      } catch (err) {
        console.warn("[native-voice] refreshMicStream error (non-fatal):", err);
      }

      this.pipelineState = "idle";
      this.scheduleNextChunk();
    }
  }

  /**
   * Get a FRESH MediaStream via getUserMedia.
   * iOS corrupts the existing stream after TTS audio playback.
   * Also rebuilds the volume monitor (cosmetic only).
   */
  private async refreshMicStream(): Promise<void> {
    console.log("[native-voice] Refreshing mic stream...");

    try {
      const newStream = await Promise.race([
        navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("getUserMedia timeout (3s)")), 3000)
        ),
      ]);

      // Stop old tracks AFTER getting new stream
      this.mediaStream?.getTracks().forEach(t => t.stop());
      this.mediaStream = newStream;

      // Rebuild volume monitor (cosmetic — recording doesn't depend on this)
      this.setupVolumeMonitor(newStream);

      console.log("[native-voice] Mic stream refreshed OK");
    } catch (err) {
      console.warn("[native-voice] refreshMicStream failed, keeping old stream:", err);
      // Don't fail — try to keep recording with old stream
    }

    // Clean up playback context so it doesn't interfere
    try {
      if (this.playbackContext && this.playbackContext.state !== "closed") {
        await this.playbackContext.close();
      }
    } catch { /* ignore */ }
    this.playbackContext = null;
  }

  private async routeToAgent(userText: string): Promise<void> {
    if (this.pipelineState === "speaking") {
      console.log("[native-voice] Already speaking, skipping:", userText);
      return;
    }

    this.pipelineState = "speaking";
    this.callbacks.onStatusChange?.("Processing...");

    try {
      if (this.callbacks.onUserTranscription) {
        if (!this._isConnected) {
          console.log("[native-voice] Disconnected before agent call, aborting");
          return;
        }

        console.log("[native-voice] Sending to agent:", userText);
        const agentResponse = await this.callbacks.onUserTranscription(userText);
        console.log("[native-voice] Agent response:", agentResponse?.substring(0, 100));

        if (!this._isConnected) {
          console.log("[native-voice] Disconnected during agent call, skipping TTS");
          return;
        }

        if (agentResponse) {
          this.callbacks.onStatusChange?.("Speaking...");
          this.pauseListening();

          try {
            if (this._isConnected) {
              await this.speakText(agentResponse);
            }
          } catch (speakErr) {
            console.error("[native-voice] speakText failed:", speakErr);
          }

          if (!this._isConnected) return;

          await new Promise(r => setTimeout(r, 300));
          this.shouldRestart = true;
          await this.resumeListening();
        } else {
          console.warn("[native-voice] Empty agent response");
          this.pipelineState = "idle";
          if (this._isConnected) {
            this.callbacks.onStatusChange?.("Listening...");
            this.scheduleNextChunk();
          }
        }
      }
    } catch (err: any) {
      console.error("[native-voice] Agent routing error:", err);
      if (!this._isConnected) return;

      this.pauseListening();
      try {
        if (this._isConnected) {
          await this.speakText("I'm sorry, I had trouble with that. Could you say it again?");
        }
      } catch (speakErr) {
        console.error("[native-voice] Error speech failed:", speakErr);
      }
      if (this._isConnected) {
        this.shouldRestart = true;
        await new Promise(r => setTimeout(r, 300));
        await this.resumeListening();
      }
    } finally {
      if (this.pipelineState === "speaking") {
        this.pipelineState = "idle";
      }
    }
  }

  // ===================================================================
  // TTS: ElevenLabs server TTS with triple-fallback playback
  // ===================================================================

  private async speakText(text: string): Promise<void> {
    const MAX_CLIENT_RETRIES = 2;

    for (let attempt = 1; attempt <= MAX_CLIENT_RETRIES; attempt++) {
      if (!this._isConnected) return;

      try {
        console.log(`[native-voice] Fetching TTS (attempt ${attempt}/${MAX_CLIENT_RETRIES}):`, text.substring(0, 60));
        const res = await fetch(apiUrl("/api/tts"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });

        if (res.ok) {
          const contentType = res.headers.get("content-type") || "audio/mpeg";
          const audioData = await res.arrayBuffer();
          console.log("[native-voice] TTS response:", audioData.byteLength, "bytes,", contentType);

          if (audioData.byteLength > 0) {
            // Try 1: <audio> element (most reliable on iOS)
            try {
              await this.playAudioViaElement(audioData, contentType);
              console.log("[native-voice] <audio> element playback succeeded");
              return;
            } catch (e) {
              console.warn("[native-voice] <audio> element failed, trying AudioContext:", e);
            }

            // Try 2: AudioContext
            try {
              await this.playAudioBuffer(audioData);
              console.log("[native-voice] AudioContext playback succeeded");
              return;
            } catch (e) {
              console.warn("[native-voice] AudioContext failed:", e);
            }

            break; // Audio data OK but playback failed — try browser TTS
          }
        } else {
          console.warn(`[native-voice] Server TTS HTTP ${res.status} (attempt ${attempt})`);
          if (attempt < MAX_CLIENT_RETRIES) {
            await new Promise(r => setTimeout(r, 300));
            continue;
          }
        }
      } catch (err) {
        console.warn(`[native-voice] Server TTS error (attempt ${attempt}):`, err);
        if (attempt < MAX_CLIENT_RETRIES) {
          await new Promise(r => setTimeout(r, 300));
          continue;
        }
      }
    }

    // Final fallback: browser speechSynthesis
    if (!this._isConnected) return;
    console.log("[native-voice] Server TTS failed, falling back to browser speechSynthesis");
    try {
      await this.speakWithBrowserTTS(text);
    } catch (err) {
      console.error("[native-voice] All TTS methods failed:", err);
    }
  }

  private speakWithBrowserTTS(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(iosKeepAlive);
        resolve();
      };

      window.speechSynthesis.cancel();

      const timeout = setTimeout(() => {
        console.warn("[native-voice] Browser TTS timed out after 5s");
        window.speechSynthesis.cancel();
        finish();
      }, 5000);

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
      utterance.lang = "en-US";
      utterance.onend = finish;
      utterance.onerror = () => finish();

      const iosKeepAlive = setInterval(() => {
        if (window.speechSynthesis.speaking) {
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        }
      }, 3000);

      window.speechSynthesis.speak(utterance);
    });
  }

  private playAudioViaElement(data: ArrayBuffer, mimeType: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const blob = new Blob([data], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);

        let settled = false;
        const finish = (success: boolean, reason?: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(safetyTimeout);
          URL.revokeObjectURL(url);
          if (success) resolve(); else reject(reason);
        };

        // Safety timeout: 15s max
        const safetyTimeout = setTimeout(() => {
          console.warn("[native-voice] <audio> playback timed out after 15s");
          try { audio.pause(); } catch { /* ignore */ }
          finish(true);
        }, 15000);

        audio.onended = () => finish(true);
        audio.onerror = (e) => finish(false, e);

        const playPromise = audio.play();
        if (playPromise) {
          playPromise.catch((err) => finish(false, err));
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  private async playAudioBuffer(data: ArrayBuffer): Promise<void> {
    if (!this.playbackContext || this.playbackContext.state === "closed") {
      this.playbackContext = new AudioContext();
    }
    if (this.playbackContext.state === "suspended") {
      await this.playbackContext.resume();
    }

    const audioBuffer = await this.playbackContext.decodeAudioData(data.slice(0));

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimeout);
        resolve();
      };

      const timeoutMs = Math.max(10000, (audioBuffer.duration + 5) * 1000);
      const safetyTimeout = setTimeout(() => {
        console.warn("[native-voice] AudioContext playback timed out after", timeoutMs, "ms");
        finish();
      }, timeoutMs);

      try {
        const source = this.playbackContext!.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.playbackContext!.destination);
        source.onended = () => finish();
        source.start();
      } catch (err) {
        clearTimeout(safetyTimeout);
        reject(err);
      }
    });
  }

  // ===================================================================
  // Volume monitoring (COSMETIC ONLY — recording does NOT depend on this)
  // ===================================================================

  /**
   * Set up volume monitoring with the given stream.
   * This is purely cosmetic — it drives the volume bars in the UI.
   * Recording works even if this completely fails.
   */
  private setupVolumeMonitor(stream: MediaStream): void {
    // Clean up old monitor
    this.stopVolumeMonitor();
    try {
      if (this.audioContext && this.audioContext.state !== "closed") {
        this.audioContext.close();
      }
    } catch { /* ignore */ }

    try {
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.volumeAnalyser = this.audioContext.createAnalyser();
      this.volumeAnalyser.fftSize = 256;
      source.connect(this.volumeAnalyser);

      const dataArray = new Uint8Array(this.volumeAnalyser.frequencyBinCount);
      this.volumeInterval = window.setInterval(() => {
        if (!this.volumeAnalyser) {
          this.stopVolumeMonitor();
          return;
        }
        this.volumeAnalyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const average = sum / dataArray.length / 255;
        this.callbacks.onVolumeChange?.(average);

        // Track peak volume during recording for silence detection
        if (this.pipelineState === "recording" && average > this.peakVolumeDuringChunk) {
          this.peakVolumeDuringChunk = average;
        }
      }, 150);
    } catch (err) {
      console.warn("[native-voice] Volume monitor setup failed (cosmetic only):", err);
      this.audioContext = null;
      this.volumeAnalyser = null;
    }
  }

  private stopVolumeMonitor(): void {
    if (this.volumeInterval !== null) {
      clearInterval(this.volumeInterval);
      this.volumeInterval = null;
    }
  }

  // ===================================================================
  // Disconnect
  // ===================================================================

  disconnect(): void {
    console.log("[native-voice] Disconnecting...");
    this.shouldRestart = false;
    this._isConnected = false;
    this.greetingDone = false;
    this.pipelineState = "idle";

    // Clear timers
    this.stopVolumeMonitor();
    this.clearChunkTimer();
    this.clearPipelineSafety();

    // Stop recognition (Strategy A)
    try { this.recognition?.stop(); } catch { /* ignore */ }
    this.recognition = null;

    // Stop MediaRecorder (Strategy B)
    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        this.mediaRecorder.stop();
      }
    } catch { /* ignore */ }
    this.mediaRecorder = null;
    this.recordedChunks = [];

    // Stop mic
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    this.volumeAnalyser = null;

    // Close audio contexts
    try { this.audioContext?.close(); } catch { /* ignore */ }
    this.audioContext = null;
    try { this.playbackContext?.close(); } catch { /* ignore */ }
    this.playbackContext = null;

    // Stop browser TTS
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    this.callbacks.onClose?.();
  }
}
