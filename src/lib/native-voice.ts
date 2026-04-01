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

// ═══════════════════════════════════════════════════════════════
// DEBUG LOG — visible on-screen overlay for iOS PWA diagnosis.
// Shows last 12 log lines directly on the page.
// Remove this after debugging is complete.
// ═══════════════════════════════════════════════════════════════
const DEBUG_LOG: string[] = [];
function dbg(msg: string): void {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const line = `${ts} ${msg}`;
  console.log(`[dbg] ${msg}`);
  DEBUG_LOG.push(line);
  if (DEBUG_LOG.length > 12) DEBUG_LOG.shift();

  // Render to on-screen overlay
  let el = document.getElementById("voice-debug-log");
  if (!el) {
    el = document.createElement("div");
    el.id = "voice-debug-log";
    el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:rgba(0,0,0,0.85);color:#0f0;font:10px/1.3 monospace;padding:6px 8px;max-height:35vh;overflow-y:auto;pointer-events:none;white-space:pre-wrap;";
    document.body.appendChild(el);
  }
  el.textContent = DEBUG_LOG.join("\n");
  el.scrollTop = el.scrollHeight;
}

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

  // -- Pre-unlocked audio resources (from unlockAudio tap gate) --
  private preUnlockedStream: MediaStream | null = null;
  private preUnlockedContext: AudioContext | null = null;

  // -- Visibility state listener --
  private visibilityHandler: (() => void) | null = null;

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

  // Volume tracking (cosmetic — for UI volume bars only)
  private peakVolumeDuringChunk = 0;

  get isConnected(): boolean {
    return this._isConnected;
  }

  // ===================================================================
  // PHASE 1: unlockAudio() — MUST be called synchronously from user tap
  // BEFORE any async work (agent.start, connect, etc.).
  // This grabs the mic and unlocks AudioContext in the direct gesture context.
  // ===================================================================

  /**
   * Call this SYNCHRONOUSLY from the user's tap/click handler,
   * BEFORE any awaits. This ensures getUserMedia and AudioContext
   * are opened in the direct user gesture context, which iOS requires.
   *
   * Usage in VoiceAssistant.tsx:
   *   const native = new NativeVoiceService();
   *   native.unlockAudio();   // <-- sync, in tap context
   *   await agent.start();    // <-- async work
   *   await native.connect(callbacks);  // reuses pre-unlocked resources
   */
  /**
   * Promise that resolves when the pre-unlocked mic stream is ready.
   * connect() awaits this to avoid the race condition.
   */
  private micUnlockPromise: Promise<MediaStream | null> | null = null;

  unlockAudio(): void {
    dbg("unlockAudio() called — tap gate");
    dbg(`protocol: ${window.location.protocol} host: ${window.location.hostname}`);

    // PHASE 5: HTTPS protocol check
    if (typeof window !== "undefined" && window.location.protocol !== "https:" && window.location.hostname !== "localhost") {
      dbg("⚠️ NOT HTTPS — getUserMedia will fail!");
    }

    // 1. Grab mic immediately — store the Promise so connect() can await it
    this.micUnlockPromise = navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    }).then((stream) => {
      dbg(`unlockAudio: mic OK tracks=${stream.getAudioTracks().length} state=${stream.getAudioTracks()[0]?.readyState}`);
      this.preUnlockedStream = stream;
      return stream;
    }).catch((err) => {
      dbg(`unlockAudio: mic FAILED ${err?.name}: ${err?.message}`);
      return null;
    });

    // 2. Create and unlock AudioContext in gesture context
    try {
      this.preUnlockedContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.preUnlockedContext.resume().then(() => {
        dbg(`unlockAudio: AudioCtx state=${this.preUnlockedContext?.state}`);
      }).catch((e) =>
        dbg(`unlockAudio: AudioCtx resume fail: ${e?.message}`)
      );

      // Play a silent buffer to fully unlock iOS audio output
      const silentBuffer = this.preUnlockedContext.createBuffer(1, 1, 22050);
      const silentSource = this.preUnlockedContext.createBufferSource();
      silentSource.buffer = silentBuffer;
      silentSource.connect(this.preUnlockedContext.destination);
      silentSource.start(0);
      dbg("unlockAudio: silent buffer played");
    } catch (err: any) {
      dbg(`unlockAudio: AudioCtx create fail: ${err?.message}`);
    }

    // 3. Pre-warm browser speechSynthesis in gesture context
    if ("speechSynthesis" in window) {
      try {
        const warmup = new SpeechSynthesisUtterance("");
        warmup.volume = 0;
        window.speechSynthesis.speak(warmup);
      } catch { /* ignore */ }
    }
  }

  async connect(callbacks: NativeVoiceCallbacks): Promise<void> {
    this.callbacks = callbacks;
    callbacks.onStatusChange?.("Connecting...");
    dbg("connect() called");

    // Detect STT strategy
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    const isPWA = isStandalonePWA();

    if (isPWA) {
      this.sttMode = "media-recorder";
    } else if (SpeechRecognition) {
      this.sttMode = "speech-recognition";
    } else {
      this.sttMode = "media-recorder";
    }
    dbg(`STT mode: ${this.sttMode} isPWA: ${isPWA}`);

    try {
      // AWAIT the mic unlock promise from unlockAudio() if it's still pending.
      // This fixes the race condition where connect() runs before the mic promise resolves.
      if (this.micUnlockPromise) {
        dbg("Awaiting micUnlockPromise...");
        const stream = await this.micUnlockPromise;
        this.micUnlockPromise = null;
        if (stream) {
          this.preUnlockedStream = stream;
          dbg(`micUnlockPromise resolved: tracks=${stream.getAudioTracks().length} state=${stream.getAudioTracks()[0]?.readyState}`);
        } else {
          dbg("micUnlockPromise resolved with NULL (failed)");
        }
      }

      // Reuse pre-unlocked mic stream if available
      if (this.preUnlockedStream) {
        const tracks = this.preUnlockedStream.getAudioTracks();
        if (tracks.length > 0 && tracks[0].readyState === "live") {
          dbg("Reusing pre-unlocked mic stream ✓");
          this.mediaStream = this.preUnlockedStream;
          this.preUnlockedStream = null;
        } else {
          dbg(`Pre-unlocked stream dead (${tracks[0]?.readyState}), requesting fresh`);
          this.preUnlockedStream = null;
          this.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
          dbg("Fresh mic stream acquired");
        }
      } else {
        dbg("No pre-unlocked stream, requesting mic now...");
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        dbg(`Mic acquired: tracks=${this.mediaStream.getAudioTracks().length}`);
      }

      // Set up volume monitoring (cosmetic only)
      this.setupVolumeMonitor(this.mediaStream);

      // Reuse pre-unlocked AudioContext for playback if available
      if (this.preUnlockedContext && this.preUnlockedContext.state !== "closed") {
        dbg(`Reusing pre-unlocked AudioCtx (state=${this.preUnlockedContext.state})`);
        this.playbackContext = this.preUnlockedContext;
        this.preUnlockedContext = null;
        if (this.playbackContext.state === "suspended") {
          await this.playbackContext.resume();
        }
      } else {
        this.preUnlockedContext = null;
        this.playbackContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        await this.playbackContext.resume();
        dbg(`New playback AudioCtx state=${this.playbackContext.state}`);
      }

      // Detect supported MIME type for MediaRecorder
      if (this.sttMode === "media-recorder") {
        this.supportedMimeType = this.getSupportedMimeType();
        dbg(`MediaRecorder MIME: ${this.supportedMimeType}`);
      }

      // Set up visibility change listener
      this.setupVisibilityListener();

      // For speech-recognition mode, start immediately.
      // For media-recorder mode, wait until after greeting (sendGreeting).
      this.shouldRestart = true;
      if (this.sttMode === "speech-recognition") {
        this.setupRecognition();
        try {
          this.recognition.start();
          dbg("SpeechRecognition started");
        } catch (e: any) {
          dbg(`recognition.start() failed: ${e?.message}`);
        }
      }

      this._isConnected = true;
      dbg("connect() done — calling onOpen");
      callbacks.onOpen?.();
      callbacks.onStatusChange?.("Connected");
    } catch (err: any) {
      dbg(`connect() FAILED: ${err?.name}: ${err?.message}`);
      callbacks.onError?.(err.message || "Connection failed");
      callbacks.onStatusChange?.("Failed to connect");
      throw err;
    }
  }

  // ===================================================================
  // PHASE 3: Visibility change listener — re-init audio when app resumes
  // ===================================================================

  /**
   * When an iOS PWA goes to background and comes back, AudioContext gets
   * suspended and MediaStream tracks may die. This listener detects resume
   * and re-initializes everything.
   */
  private setupVisibilityListener(): void {
    // Remove old listener if any
    this.removeVisibilityListener();

    this.visibilityHandler = () => {
      if (document.visibilityState === "visible" && this._isConnected) {
        console.log("[native-voice] App resumed from background — checking audio health");

        // Resume AudioContext (for volume monitor)
        if (this.audioContext && this.audioContext.state === "suspended") {
          console.log("[native-voice] Resuming volume AudioContext after background");
          this.audioContext.resume().catch((e) =>
            console.warn("[native-voice] Volume AudioContext resume failed:", e)
          );
        }

        // Resume playback AudioContext
        if (this.playbackContext && this.playbackContext.state === "suspended") {
          console.log("[native-voice] Resuming playback AudioContext after background");
          this.playbackContext.resume().catch((e) =>
            console.warn("[native-voice] Playback AudioContext resume failed:", e)
          );
        }

        // Check if mic stream is still alive — if dead, try to get a fresh one
        const tracks = this.mediaStream?.getAudioTracks();
        if (!tracks || tracks.length === 0 || tracks[0].readyState !== "live") {
          console.warn("[native-voice] Mic stream died during background — refreshing");
          this.refreshMicStream().then(() => {
            // Restart recording if we were idle
            if (this.pipelineState === "idle" && this.shouldRestart && this.sttMode === "media-recorder") {
              this.startRecordingChunk();
            }
          }).catch((err) => {
            console.error("[native-voice] Mic refresh after background failed:", err);
            this.callbacks.onStatusChange?.("Mic lost — tap Stop and retry");
          });
        } else {
          console.log("[native-voice] Mic stream still alive after background");
          // Restart recording if it was stopped by going to background
          if (this.pipelineState === "idle" && this.shouldRestart && this.sttMode === "media-recorder") {
            this.startRecordingChunk();
          }
        }
      }
    };

    document.addEventListener("visibilitychange", this.visibilityHandler);
    console.log("[native-voice] Visibility change listener registered");
  }

  private removeVisibilityListener(): void {
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
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
    dbg(`startRecordingChunk: conn=${this._isConnected} restart=${this.shouldRestart} pipe=${this.pipelineState}`);

    if (!this._isConnected || !this.shouldRestart) {
      dbg("⚠️ Not starting chunk — disconnected or stopped");
      return;
    }
    if (this.pipelineState !== "idle") {
      dbg(`⚠️ Not starting chunk — pipeline=${this.pipelineState}`);
      return;
    }

    // Verify media stream is alive
    if (!this.mediaStream) {
      dbg("⚠️ No media stream — refreshing...");
      this.refreshMicStream().then(() => {
        if (this.mediaStream && this._isConnected && this.shouldRestart && this.pipelineState === "idle") {
          this.startRecordingChunk();
        } else {
          this.callbacks.onStatusChange?.("Mic error — tap to retry");
          dbg("⚠️ Mic refresh failed to produce usable stream");
        }
      }).catch(() => {
        this.callbacks.onStatusChange?.("Mic error — tap to retry");
        dbg("⚠️ refreshMicStream threw");
      });
      return;
    }
    const tracks = this.mediaStream.getAudioTracks();
    if (tracks.length === 0 || tracks[0].readyState !== "live") {
      dbg(`⚠️ Tracks not live: ${tracks[0]?.readyState} — refreshing...`);
      this.refreshMicStream().then(() => {
        if (this.mediaStream && this._isConnected && this.shouldRestart && this.pipelineState === "idle") {
          this.startRecordingChunk();
        } else {
          this.callbacks.onStatusChange?.("Mic error — tap to retry");
        }
      }).catch(() => {
        this.callbacks.onStatusChange?.("Mic error — tap to retry");
      });
      return;
    }

    // PHASE 4: Check mic permission (non-blocking)
    this.checkMicPermission();

    this.pipelineState = "recording";
    this.callbacks.onStatusChange?.("Listening...");
    this.recordedChunks = [];

    dbg(`Recording ${NativeVoiceService.CHUNK_DURATION_MS}ms chunk...`);

    try {
      const options: MediaRecorderOptions = this.supportedMimeType
        ? { mimeType: this.supportedMimeType, audioBitsPerSecond: 64000 }
        : { audioBitsPerSecond: 64000 };

      this.mediaRecorder = new MediaRecorder(this.mediaStream, options);
      dbg(`MediaRecorder created OK, mimeType=${this.mediaRecorder.mimeType}`);
    } catch (err: any) {
      dbg(`MediaRecorder MIME fail: ${err?.message}, trying default`);
      try {
        this.mediaRecorder = new MediaRecorder(this.mediaStream);
        this.supportedMimeType = this.mediaRecorder.mimeType || "audio/mp4";
        dbg(`MediaRecorder fallback OK, mimeType=${this.mediaRecorder.mimeType}`);
      } catch (err2: any) {
        dbg(`⚠️ MediaRecorder TOTALLY FAILED: ${err2?.message}`);
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
      const chunkCount = this.recordedChunks.length;
      this.clearChunkTimer();

      if (chunkCount > 0 && this.pipelineState === "recording") {
        const actualMime = this.mediaRecorder?.mimeType || this.supportedMimeType;
        const blob = new Blob(this.recordedChunks, { type: actualMime });
        this.recordedChunks = [];

        if (blob.size > NativeVoiceService.MIN_AUDIO_SIZE) {
          dbg(`Chunk done: ${Math.round(blob.size / 1024)}KB → STT`);
          this.pipelineState = "transcribing";
          this.transcribeAndRoute(blob, actualMime);
        } else {
          dbg(`Chunk too small (${blob.size}B), skip → next`);
          this.pipelineState = "idle";
          this.scheduleNextChunk();
        }
      } else {
        dbg(`Recorder stopped: ${chunkCount} chunks, pipe=${this.pipelineState}`);
        this.recordedChunks = [];
        if (this.pipelineState === "recording") {
          this.pipelineState = "idle";
          this.scheduleNextChunk();
        }
      }
    };

    this.mediaRecorder.onerror = (event: any) => {
      dbg(`⚠️ MediaRecorder error: ${event.error?.name || event.error || "unknown"}`);
      console.error("[native-voice] MediaRecorder error:", event.error || event);
      this.clearChunkTimer();
      this.pipelineState = "idle";
      this.scheduleNextChunk();
    };

    // Start recording with timeslice (collects data every 250ms)
    try {
      this.mediaRecorder.start(250);
      dbg(`MediaRecorder.start(250) OK, state=${this.mediaRecorder.state}`);
    } catch (startErr: any) {
      dbg(`⚠️ MediaRecorder.start FAILED: ${startErr?.message}`);
      this.pipelineState = "idle";
      this.scheduleNextChunk();
      return;
    }

    // Timer to stop recording after CHUNK_DURATION_MS
    this.chunkTimer = window.setTimeout(() => {
      this.chunkTimer = null;
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        dbg("Chunk timer fired → stopping recorder");
        try {
          this.mediaRecorder.stop();
        } catch (e: any) {
          dbg(`⚠️ recorder.stop() error: ${e?.message}`);
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
    dbg(`transcribeAndRoute: ${Math.round(blob.size / 1024)}KB ${mimeType}`);

    // Safety timeout
    this.clearPipelineSafety();
    this.pipelineSafetyTimer = window.setTimeout(() => {
      dbg("⚠️ Pipeline stuck 45s — force reset");
      this.pipelineState = "idle";
      if (this._isConnected) {
        this.callbacks.onStatusChange?.("Listening...");
        this.scheduleNextChunk();
      }
    }, 45000);

    try {
      const base64 = await this.blobToBase64(blob);
      dbg(`Sending ${Math.round(blob.size / 1024)}KB to /api/stt`);
      const sttStart = Date.now();

      const res = await fetch(apiUrl("/api/stt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: base64,
          mimeType: mimeType.split(";")[0],
        }),
      });

      const sttMs = Date.now() - sttStart;
      dbg(`STT response: ${res.status} in ${sttMs}ms`);

      if (!res.ok) {
        let errDetail = "";
        try {
          const errData = await res.json();
          errDetail = JSON.stringify(errData).substring(0, 200);
        } catch { errDetail = "no body"; }
        dbg(`⚠️ STT failed ${res.status}: ${errDetail}`);
        this.pipelineState = "idle";
        this.scheduleNextChunk();
        return;
      }

      const data = await res.json();
      const text = data.text?.trim();

      if (text && text.length > 0) {
        dbg(`STT text: "${text.substring(0, 50)}"`);
        this.callbacks.onStatusChange?.("Processing...");
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
    dbg(`sendGreeting called, text=${greetingResponse ? greetingResponse.substring(0, 40) + "..." : "(empty)"}`);

    if (!greetingResponse) {
      this.greetingDone = true;
      if (this.sttMode === "media-recorder") {
        dbg("Empty greeting — starting recording immediately");
        this.startRecordingChunk();
      }
      return;
    }

    this.callbacks.onStatusChange?.("Speaking...");
    this.pipelineState = "speaking";

    if (this.sttMode === "speech-recognition") {
      this.pauseListening();
    }

    dbg("Speaking greeting via TTS...");
    await this.speakText(greetingResponse);
    dbg("Greeting TTS done");

    await new Promise(r => setTimeout(r, 300));

    this.greetingDone = true;
    this.pipelineState = "idle";

    if (this.sttMode === "speech-recognition") {
      await this.resumeListening();
    } else {
      dbg("Refreshing mic stream after greeting...");
      await this.refreshMicStream();

      this.callbacks.onStatusChange?.("Listening...");
      dbg(`Post-greeting: connected=${this._isConnected} shouldRestart=${this.shouldRestart} pipeline=${this.pipelineState}`);
      if (this._isConnected && this.shouldRestart) {
        dbg("Starting first recording chunk after greeting");
        this.startRecordingChunk();
      } else {
        dbg("⚠️ NOT starting recording — conditions not met!");
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

    // PHASE 2: Ensure playback AudioContext is alive and running before any TTS attempt.
    // iOS suspends AudioContext when app backgrounds or after prolonged inactivity.
    await this.ensurePlaybackContext();

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

            // Try 2: AudioContext (resume again just in case)
            await this.ensurePlaybackContext();
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

  /**
   * PHASE 2: Ensure the playback AudioContext exists and is in "running" state.
   * iOS suspends AudioContext on background, page visibility changes, or after TTS.
   */
  private async ensurePlaybackContext(): Promise<void> {
    try {
      if (!this.playbackContext || this.playbackContext.state === "closed") {
        console.log("[native-voice] Creating fresh playback AudioContext");
        this.playbackContext = new AudioContext();
      }
      if (this.playbackContext.state === "suspended") {
        console.log("[native-voice] Resuming suspended playback AudioContext");
        await this.playbackContext.resume();
      }
    } catch (err) {
      console.warn("[native-voice] ensurePlaybackContext failed:", err);
      // Try creating a brand new one
      try {
        this.playbackContext = new AudioContext();
        await this.playbackContext.resume();
      } catch (e) {
        console.error("[native-voice] Cannot create AudioContext at all:", e);
      }
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
  // PHASE 4: Mic permission check (non-blocking diagnostic)
  // ===================================================================

  /**
   * Check microphone permission status via Permissions API.
   * Non-blocking — just logs the current state for diagnostics.
   * Helps identify when iOS has revoked mic permission silently.
   */
  private checkMicPermission(): void {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: "microphone" as PermissionName }).then((result) => {
          console.log("[native-voice] Mic permission status:", result.state);
          if (result.state === "denied") {
            console.error("[native-voice] ⚠️ Mic permission DENIED — recording will fail");
            this.callbacks.onStatusChange?.("Mic permission denied");
            this.callbacks.onError?.("Microphone permission denied. Please allow microphone access in Settings.");
          }
        }).catch((e) => {
          // Permissions API not available for microphone on this browser — that's OK
          console.log("[native-voice] Permissions API not available for mic:", e.message);
        });
      }
    } catch {
      // Ignore — Permissions API may not exist
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

    // Remove visibility listener
    this.removeVisibilityListener();

    // Clean up pre-unlocked resources if they weren't consumed
    if (this.preUnlockedStream) {
      this.preUnlockedStream.getTracks().forEach(t => t.stop());
      this.preUnlockedStream = null;
    }
    try { this.preUnlockedContext?.close(); } catch { /* ignore */ }
    this.preUnlockedContext = null;

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
