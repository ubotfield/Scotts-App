/**
 * NativeVoiceService — Cross-platform voice with dual STT strategy:
 *
 *   Strategy A (Safari browser only): Web Speech API (SpeechRecognition)
 *   Strategy B (Everything else): MediaRecorder -> server-side Gemini STT
 *
 * Both strategies share the same TTS pipeline:
 *   Server-side Gemini TTS -> AudioContext / <audio> element / browser speechSynthesis
 *
 * KEY FIXES (v2):
 *   1. Force MediaRecorder for Safari PWA (SpeechRecognition silently breaks after audio playback)
 *   2. Don't start MediaRecorder until after greeting completes (avoid recording during TTS)
 *   3. Fix isProcessing race in scheduleMediaRestart — explicit restart in routeToAgent finally
 *   4. Fix Promise deadlock in playAudioBuffer — no async executor
 *   5. Add 30s no-speech timeout for MediaRecorder
 *   6. Throttle volume monitor to ~7fps with setInterval instead of rAF
 *   7. Add 10s timeout to browser TTS fallback
 *   8. Add onerror to fallback MediaRecorder
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

/**
 * Detect if we're in a PWA standalone context (homescreen app).
 * SpeechRecognition exists in Safari PWA but silently breaks after audio playback
 * because iOS switches the audio session to "playback" mode.
 */
function isStandalonePWA(): boolean {
  // iOS Safari standalone (added to homescreen)
  if ((navigator as any).standalone === true) return true;
  // Chrome PWA / manifest-based standalone
  if (window.matchMedia?.("(display-mode: standalone)")?.matches) return true;
  if (window.matchMedia?.("(display-mode: fullscreen)")?.matches) return true;
  return false;
}

export class NativeVoiceService {
  // -- Shared state --
  private callbacks: NativeVoiceCallbacks = {};
  private isProcessing = false;
  private audioContext: AudioContext | null = null;
  private playbackContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private volumeAnalyser: AnalyserNode | null = null;
  private volumeInterval: number | null = null;
  private _isConnected = false;
  private shouldRestart = false;
  private greetingDone = false; // FIX 2: delay recording until greeting finishes

  // -- STT mode --
  private sttMode: SttMode = "speech-recognition";

  // Strategy A: Web Speech API
  private recognition: any = null;

  // Strategy B: MediaRecorder + server STT
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private isRecording = false;
  private silenceDetectionInterval: number | null = null;
  private supportedMimeType: string = "audio/mp4";

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(callbacks: NativeVoiceCallbacks): Promise<void> {
    this.callbacks = callbacks;
    callbacks.onStatusChange?.("Connecting...");

    // FIX 1: Detect STT strategy — force MediaRecorder for PWA standalone
    // SpeechRecognition exists in Safari PWA but silently fails after audio playback
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    const isPWA = isStandalonePWA();

    if (isPWA) {
      // Force MediaRecorder in ANY PWA/standalone context
      this.sttMode = "media-recorder";
      console.log("[native-voice] PWA standalone detected — forcing MediaRecorder mode");
    } else if (SpeechRecognition) {
      this.sttMode = "speech-recognition";
    } else {
      this.sttMode = "media-recorder";
    }
    console.log("[native-voice] STT mode:", this.sttMode, "isPWA:", isPWA);

    try {
      // Request microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Set up volume monitoring
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.volumeAnalyser = this.audioContext.createAnalyser();
      this.volumeAnalyser.fftSize = 256;
      source.connect(this.volumeAnalyser);
      this.startVolumeMonitor(); // FIX 6: now uses setInterval at ~7fps

      // Pre-warm playback AudioContext for iOS
      this.playbackContext = new AudioContext();
      await this.playbackContext.resume();
      console.log("[native-voice] Playback AudioContext state:", this.playbackContext.state);

      // Play silent buffer to unlock iOS audio
      try {
        const silentBuffer = this.playbackContext.createBuffer(1, 1, 22050);
        const silentSource = this.playbackContext.createBufferSource();
        silentSource.buffer = silentBuffer;
        silentSource.connect(this.playbackContext.destination);
        silentSource.start(0);
        console.log("[native-voice] Silent buffer played — iOS audio unlocked");
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

      // FIX 2: Do NOT start recording here — wait until after greeting.
      // For speech-recognition mode, we still start immediately since it
      // coexists better with audio playback on Safari browser (non-PWA).
      this.shouldRestart = true;
      if (this.sttMode === "speech-recognition") {
        this.setupRecognition();
        try {
          this.recognition.start();
        } catch (e) {
          console.warn("[native-voice] Initial recognition.start() failed:", e);
        }
      }
      // MediaRecorder will be started in sendGreeting() or after greeting callback

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
      this.restartMediaRecording();
      return;
    }

    setTimeout(() => {
      if (!this.shouldRestart || !this._isConnected) return;

      // Try 1: start existing instance
      try {
        if (this.recognition) {
          console.log("[native-voice] Restarting recognition...");
          this.recognition.start();
          return;
        }
      } catch (err) {
        console.warn("[native-voice] recognition.start() failed, recreating:", err);
      }

      // Try 2: recreate entirely (iOS WebKit often needs this after audio playback)
      try {
        this.setupRecognition();
        this.recognition?.start();
        console.log("[native-voice] Recognition recreated and started");
      } catch (err2) {
        console.error("[native-voice] Failed to recreate recognition:", err2);
        // Try 3: one more attempt after a longer delay
        setTimeout(() => {
          if (!this.shouldRestart || !this._isConnected) return;
          try {
            this.setupRecognition();
            this.recognition?.start();
            console.log("[native-voice] Recognition started on retry");
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
      console.log("[native-voice] Recognition result: isFinal:", last.isFinal, "text:", last[0]?.transcript?.substring(0, 50));
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
      this.callbacks.onStatusChange?.(`Error: ${event.error}`);
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
  // ===================================================================

  private startMediaRecording(): void {
    if (!this.mediaStream || !this._isConnected) {
      console.warn("[native-voice] Cannot start recording: no stream or not connected");
      return;
    }

    // Verify the media stream is still active
    const tracks = this.mediaStream.getAudioTracks();
    if (tracks.length === 0 || tracks[0].readyState !== "live") {
      console.warn("[native-voice] Media stream tracks not live (state:", tracks[0]?.readyState, "), cannot record");
      this.callbacks.onStatusChange?.("Mic error -- tap to retry");
      return;
    }

    console.log("[native-voice] Starting MediaRecorder, MIME:", this.supportedMimeType, "track:", tracks[0].readyState, "audioCtx:", this.audioContext?.state);

    try {
      this.recordedChunks = [];

      // Build MediaRecorder options
      const options: MediaRecorderOptions = this.supportedMimeType
        ? { mimeType: this.supportedMimeType, audioBitsPerSecond: 64000 }
        : { audioBitsPerSecond: 64000 };

      this.mediaRecorder = new MediaRecorder(this.mediaStream, options);

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        console.log("[native-voice] MediaRecorder stopped, chunks:", this.recordedChunks.length);
        this.isRecording = false;

        if (this.recordedChunks.length > 0) {
          const actualMime = this.mediaRecorder?.mimeType || this.supportedMimeType;
          const blob = new Blob(this.recordedChunks, { type: actualMime });
          this.recordedChunks = [];

          // Only transcribe if blob has meaningful audio (> 2KB)
          if (blob.size > 2000) {
            console.log("[native-voice] Sending", Math.round(blob.size / 1024), "KB for transcription");
            this.transcribeAudio(blob, actualMime);
          } else {
            console.log("[native-voice] Audio too short (" + blob.size + " bytes), restarting");
            this.scheduleMediaRestart();
          }
        } else {
          console.log("[native-voice] No recorded data, restarting");
          this.scheduleMediaRestart();
        }
      };

      // FIX 8: Always attach onerror
      this.mediaRecorder.onerror = (event: any) => {
        console.error("[native-voice] MediaRecorder error:", event.error || event);
        this.isRecording = false;
        this.scheduleMediaRestart();
      };

      // Start recording with timeslice of 250ms
      this.mediaRecorder.start(250);
      this.isRecording = true;
      this.callbacks.onStatusChange?.("Listening...");
      console.log("[native-voice] MediaRecorder started successfully");

      // Start silence detection
      this.startSilenceDetection();
    } catch (err: any) {
      console.error("[native-voice] MediaRecorder creation failed:", err);
      this.isRecording = false;

      // FIX 8: Try without options as last resort, with full error handling
      try {
        this.mediaRecorder = new MediaRecorder(this.mediaStream);
        this.supportedMimeType = this.mediaRecorder.mimeType || "audio/mp4";
        console.log("[native-voice] Retrying MediaRecorder with default MIME:", this.supportedMimeType);

        this.mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) this.recordedChunks.push(event.data);
        };

        this.mediaRecorder.onstop = () => {
          this.isRecording = false;
          if (this.recordedChunks.length > 0) {
            const actualMime = this.mediaRecorder?.mimeType || this.supportedMimeType;
            const blob = new Blob(this.recordedChunks, { type: actualMime });
            this.recordedChunks = [];
            if (blob.size > 2000) {
              this.transcribeAudio(blob, actualMime);
            } else {
              this.scheduleMediaRestart();
            }
          } else {
            this.scheduleMediaRestart();
          }
        };

        // FIX 8: onerror on fallback MediaRecorder
        this.mediaRecorder.onerror = (event: any) => {
          console.error("[native-voice] Fallback MediaRecorder error:", event.error || event);
          this.isRecording = false;
          this.scheduleMediaRestart();
        };

        this.mediaRecorder.start(250);
        this.isRecording = true;
        this.callbacks.onStatusChange?.("Listening...");
        this.startSilenceDetection();
      } catch (err2) {
        console.error("[native-voice] MediaRecorder completely failed:", err2);
        this.callbacks.onStatusChange?.("Voice not available");
        this.callbacks.onError?.("Cannot record audio on this device");
      }
    }
  }

  private getSupportedMimeType(): string {
    // On iOS, audio/mp4 is most reliable. audio/webm is NEVER supported on iOS.
    const types = [
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
    ];
    for (const type of types) {
      try {
        if (MediaRecorder.isTypeSupported(type)) {
          return type;
        }
      } catch {
        // isTypeSupported can throw in some browsers
      }
    }
    return ""; // Let MediaRecorder choose default
  }

  private startSilenceDetection(): void {
    if (!this.volumeAnalyser) return;

    // Stop any existing interval
    this.stopSilenceDetection();

    const dataArray = new Uint8Array(this.volumeAnalyser.frequencyBinCount);
    const SILENCE_THRESHOLD = 0.015;
    const SPEECH_THRESHOLD = 0.03;
    const SILENCE_DURATION = 1500;  // 1.5s of silence after speech
    const MAX_RECORDING = 15000;    // max 15s per chunk
    const NO_SPEECH_TIMEOUT = 30000; // FIX 5: 30s timeout when user never speaks

    let hasSpeech = false;
    let silenceSince: number | null = null;
    const recordingStart = Date.now();
    let logCounter = 0;

    this.silenceDetectionInterval = window.setInterval(() => {
      if (!this.volumeAnalyser || !this.isRecording) {
        this.stopSilenceDetection();
        return;
      }

      this.volumeAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const volume = sum / dataArray.length / 255;

      // Log volume every 2 seconds so we can diagnose silence issues
      logCounter++;
      if (logCounter % 20 === 0) {
        console.log("[native-voice] Silence check: vol=", volume.toFixed(4), "hasSpeech:", hasSpeech, "elapsed:", Math.round((Date.now() - recordingStart) / 1000) + "s", "audioCtx:", this.audioContext?.state);
      }

      if (volume > SPEECH_THRESHOLD) {
        hasSpeech = true;
        silenceSince = null;
      } else if (volume < SILENCE_THRESHOLD && hasSpeech) {
        if (!silenceSince) {
          silenceSince = Date.now();
        } else if (Date.now() - silenceSince > SILENCE_DURATION) {
          console.log("[native-voice] Silence detected after speech");
          this.stopSilenceDetection();
          this.stopMediaRecording();
          return;
        }
      }

      // Safety: max recording duration (only if speech was detected)
      if (Date.now() - recordingStart > MAX_RECORDING && hasSpeech) {
        console.log("[native-voice] Max recording duration reached");
        this.stopSilenceDetection();
        this.stopMediaRecording();
        return;
      }

      // FIX 5: No-speech timeout — restart if user hasn't spoken in 30s
      if (Date.now() - recordingStart > NO_SPEECH_TIMEOUT && !hasSpeech) {
        console.log("[native-voice] No speech for 30s, restarting recorder");
        this.stopSilenceDetection();
        this.stopMediaRecording();
      }
    }, 100);
  }

  private stopSilenceDetection(): void {
    if (this.silenceDetectionInterval !== null) {
      clearInterval(this.silenceDetectionInterval);
      this.silenceDetectionInterval = null;
    }
  }

  private stopMediaRecording(): void {
    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        this.mediaRecorder.stop();
      }
    } catch (err) {
      console.warn("[native-voice] MediaRecorder stop error:", err);
      this.isRecording = false;
    }
  }

  /** Schedule a MediaRecorder restart with a short delay.
   *  NOTE: Does NOT check isProcessing — that's handled by callers.
   */
  private scheduleMediaRestart(): void {
    if (!this.shouldRestart || !this._isConnected) return;
    setTimeout(() => {
      if (this.shouldRestart && this._isConnected && !this.isRecording) {
        this.startMediaRecording();
      }
    }, 300);
  }

  private restartMediaRecording(): void {
    this.scheduleMediaRestart();
  }

  private async transcribeAudio(blob: Blob, mimeType: string): Promise<void> {
    this.callbacks.onStatusChange?.("Processing...");

    try {
      // Convert blob to base64
      const base64 = await this.blobToBase64(blob);

      console.log("[native-voice] Sending audio for STT:", Math.round(blob.size / 1024), "KB");

      const res = await fetch(apiUrl("/api/stt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: base64,
          mimeType: mimeType.split(";")[0], // strip codecs param
        }),
      });

      if (!res.ok) {
        console.error("[native-voice] STT request failed:", res.status);
        this.scheduleMediaRestart();
        return;
      }

      const data = await res.json();
      const text = data.text?.trim();

      if (text && text.length > 0) {
        console.log("[native-voice] STT result:", text);
        await this.routeToAgent(text);
      } else {
        console.log("[native-voice] No speech detected in audio");
        this.scheduleMediaRestart();
      }
    } catch (err) {
      console.error("[native-voice] Transcription error:", err);
      this.scheduleMediaRestart();
    }
  }

  /** Convert Blob to base64 string using FileReader (most compatible) */
  private blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        // Strip the data URL prefix (e.g. "data:audio/mp4;base64,")
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
      // No greeting — start recording immediately for MediaRecorder mode
      this.greetingDone = true;
      if (this.sttMode === "media-recorder" && !this.isRecording) {
        this.startMediaRecording();
      }
      return;
    }

    console.log("[native-voice] Speaking greeting:", greetingResponse.substring(0, 80));
    this.callbacks.onStatusChange?.("Speaking...");

    // For speech-recognition mode, pause while speaking
    if (this.sttMode === "speech-recognition") {
      this.pauseListening();
    }
    // For media-recorder mode, recording hasn't started yet (FIX 2)

    await this.speakText(greetingResponse);

    // Small delay before starting/resuming listening
    await new Promise(r => setTimeout(r, 300));

    this.greetingDone = true;

    if (this.sttMode === "speech-recognition") {
      await this.resumeListening();
    } else {
      // FIX 2: NOW start MediaRecorder for the first time
      // Also refresh mic stream since iOS may have disrupted it during greeting TTS.
      // refreshMicStream creates a BRAND NEW AudioContext (critical for iOS Chrome).
      await this.refreshMicStream();

      // Clean up playback context so it doesn't interfere with monitoring
      try {
        if (this.playbackContext && this.playbackContext.state !== "closed") {
          await this.playbackContext.close();
        }
      } catch { /* ignore */ }
      this.playbackContext = null;

      this.callbacks.onStatusChange?.("Listening...");
      if (!this.isRecording && this._isConnected) {
        this.startMediaRecording();
      }
    }
  }

  private pauseListening(): void {
    console.log("[native-voice] Pausing listening (mode:", this.sttMode + ")");
    this.shouldRestart = false;

    if (this.sttMode === "speech-recognition") {
      try { this.recognition?.stop(); } catch { /* ignore */ }
    } else {
      this.stopSilenceDetection();
      this.stopMediaRecording();
    }
  }

  private async resumeListening(): Promise<void> {
    console.log("[native-voice] Resuming listening (mode:", this.sttMode + ")");
    this.shouldRestart = true;
    if (!this._isConnected) return;

    this.callbacks.onStatusChange?.("Listening...");

    if (this.sttMode === "speech-recognition") {
      // For Safari: recreate recognition fresh after audio playback
      this.restartRecognition();
    } else {
      // iOS: re-acquire mic stream + create fresh AudioContext after TTS playback.
      // CRITICAL: On iOS Chrome, the old AudioContext cannot resume after audio
      // playback. refreshMicStream now creates a completely new AudioContext.
      try {
        await this.refreshMicStream();
      } catch (err) {
        console.warn("[native-voice] refreshMicStream error (non-fatal):", err);
      }

      // Also ensure playback context is fresh for next TTS
      try {
        if (this.playbackContext && this.playbackContext.state !== "closed") {
          await this.playbackContext.close();
        }
      } catch { /* ignore */ }
      this.playbackContext = null;

      // Start a new recording session after short delay
      setTimeout(() => {
        if (this.shouldRestart && this._isConnected && !this.isRecording) {
          this.startMediaRecording();
        }
      }, 200);
    }
  }

  /**
   * Re-acquire mic stream and rebuild audio analyser after TTS playback.
   * iOS (especially Chrome) suspends the monitoring AudioContext and kills
   * mic input after switching the hardware audio session to "playback" mode.
   *
   * CRITICAL FIX: On iOS Chrome, the old AudioContext often cannot resume
   * after audio playback — it stays "suspended" even after .resume().
   * Solution: Close the old AudioContext entirely and create a fresh one.
   *
   * Has a 3s timeout so it can't hang if getUserMedia blocks on iOS.
   */
  private async refreshMicStream(): Promise<void> {
    // 1. Close the OLD monitoring AudioContext completely.
    //    On iOS Chrome, a suspended AudioContext after playback cannot be
    //    reliably resumed. A fresh context is the only reliable fix.
    try {
      if (this.audioContext && this.audioContext.state !== "closed") {
        console.log("[native-voice] Closing old AudioContext (state:", this.audioContext.state + ")");
        await this.audioContext.close();
      }
    } catch (err) {
      console.warn("[native-voice] Old AudioContext close error (non-fatal):", err);
    }
    this.audioContext = null;
    this.volumeAnalyser = null;

    // 2. Re-acquire microphone with a timeout
    // getUserMedia can hang on iOS if audio session is in a bad state
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

      // Stop old tracks AFTER successfully getting new stream
      this.mediaStream?.getTracks().forEach(t => t.stop());
      this.mediaStream = newStream;

      // 3. Create a BRAND NEW AudioContext and analyser with the fresh stream
      this.audioContext = new AudioContext();
      // Must resume explicitly — iOS requires it
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }
      const source = this.audioContext.createMediaStreamSource(newStream);
      this.volumeAnalyser = this.audioContext.createAnalyser();
      this.volumeAnalyser.fftSize = 256;
      source.connect(this.volumeAnalyser);

      // Restart volume monitor with new analyser
      this.stopVolumeMonitor();
      this.startVolumeMonitor();

      console.log("[native-voice] Mic stream refreshed OK — new AudioContext state:", this.audioContext.state);

      // 4. Diagnostic: check if we're actually getting audio data
      setTimeout(() => {
        if (this.volumeAnalyser) {
          const testData = new Uint8Array(this.volumeAnalyser.frequencyBinCount);
          this.volumeAnalyser.getByteFrequencyData(testData);
          let testSum = 0;
          for (let i = 0; i < testData.length; i++) testSum += testData[i];
          const testVol = testSum / testData.length / 255;
          console.log("[native-voice] Post-refresh audio check: vol=", testVol.toFixed(4), "audioCtx:", this.audioContext?.state);
          if (this.audioContext?.state === "suspended") {
            console.warn("[native-voice] ⚠️ AudioContext STILL suspended after refresh — trying resume again");
            this.audioContext.resume().catch(() => {});
          }
        }
      }, 500);
    } catch (err) {
      console.warn("[native-voice] refreshMicStream getUserMedia failed:", err);
      // Fallback: create AudioContext with existing stream if possible
      try {
        if (this.mediaStream) {
          this.audioContext = new AudioContext();
          if (this.audioContext.state === "suspended") {
            await this.audioContext.resume();
          }
          const source = this.audioContext.createMediaStreamSource(this.mediaStream);
          this.volumeAnalyser = this.audioContext.createAnalyser();
          this.volumeAnalyser.fftSize = 256;
          source.connect(this.volumeAnalyser);
          this.stopVolumeMonitor();
          this.startVolumeMonitor();
          console.log("[native-voice] Fallback: rebuilt AudioContext with existing stream");
        }
      } catch (fallbackErr) {
        console.error("[native-voice] Fallback AudioContext creation also failed:", fallbackErr);
      }
    }
  }

  private async routeToAgent(userText: string): Promise<void> {
    if (this.isProcessing) {
      console.log("[native-voice] Already processing, skipping:", userText);
      return;
    }

    this.isProcessing = true;
    this.callbacks.onStatusChange?.("Processing...");

    try {
      if (this.callbacks.onUserTranscription) {
        // Guard: check connection before sending to agent
        if (!this._isConnected) {
          console.log("[native-voice] Disconnected before agent call, aborting");
          return;
        }

        console.log("[native-voice] Sending to agent:", userText);
        const agentResponse = await this.callbacks.onUserTranscription(userText);
        console.log("[native-voice] Agent response:", agentResponse?.substring(0, 100));

        // Guard: check connection AGAIN after agent call (user may have clicked stop)
        if (!this._isConnected) {
          console.log("[native-voice] Disconnected during agent call, skipping TTS");
          return;
        }

        if (agentResponse) {
          this.callbacks.onStatusChange?.("Speaking...");
          this.pauseListening();
          console.log("[native-voice] About to speak agent response...");
          try {
            // Final guard before TTS
            if (this._isConnected) {
              await this.speakText(agentResponse);
            } else {
              console.log("[native-voice] Disconnected before TTS, skipping");
            }
          } catch (speakErr) {
            console.error("[native-voice] speakText failed:", speakErr);
          }

          // Guard: don't resume if disconnected
          if (!this._isConnected) {
            console.log("[native-voice] Disconnected after TTS, not resuming");
            return;
          }

          console.log("[native-voice] speakText done, waiting 300ms before resume...");
          await new Promise(r => setTimeout(r, 300));
          console.log("[native-voice] Calling resumeListening...");
          await this.resumeListening();
          console.log("[native-voice] resumeListening complete");
        } else {
          console.warn("[native-voice] Empty agent response");
          if (this._isConnected) {
            this.callbacks.onStatusChange?.("Listening...");
            this.scheduleMediaRestart();
          }
        }
      }
    } catch (err: any) {
      console.error("[native-voice] Agent routing error:", err);
      // Guard: don't try to speak/resume if disconnected
      if (!this._isConnected) {
        console.log("[native-voice] Disconnected during error handling, aborting");
        return;
      }
      this.pauseListening();
      try {
        if (this._isConnected) {
          await this.speakText("I'm sorry, I had trouble with that. Could you say it again?");
        }
      } catch (speakErr) {
        console.error("[native-voice] Error speech failed too:", speakErr);
      }
      if (this._isConnected) {
        await new Promise(r => setTimeout(r, 300));
        await this.resumeListening();
      }
    } finally {
      this.isProcessing = false;
      console.log("[native-voice] Processing complete, isProcessing:", this.isProcessing);
    }
  }

  // ===================================================================
  // TTS: Server Gemini TTS with triple-fallback playback
  // ===================================================================

  private async speakText(text: string): Promise<void> {
    // Client-side retry: try server TTS up to 2 times before falling back to browser TTS
    const MAX_CLIENT_RETRIES = 2;

    for (let attempt = 1; attempt <= MAX_CLIENT_RETRIES; attempt++) {
      // Bail if disconnected between retries
      if (!this._isConnected) {
        console.log("[native-voice] Disconnected, aborting TTS");
        return;
      }

      try {
        console.log(`[native-voice] Fetching TTS (attempt ${attempt}/${MAX_CLIENT_RETRIES}):`, text.substring(0, 60));
        const res = await fetch(apiUrl("/api/tts"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });

        if (res.ok) {
          const contentType = res.headers.get("content-type") || "audio/wav";
          const audioData = await res.arrayBuffer();
          console.log("[native-voice] TTS response:", audioData.byteLength, "bytes,", contentType);

          if (audioData.byteLength > 0) {
            // Try 1: AudioContext (pre-warmed during user gesture)
            try {
              await this.playAudioBuffer(audioData);
              console.log("[native-voice] AudioContext playback succeeded");
              return;
            } catch (e) {
              console.warn("[native-voice] AudioContext failed, trying <audio>:", e);
            }

            // Try 2: HTML <audio> element (most reliable on iOS)
            try {
              await this.playAudioViaElement(audioData, contentType);
              console.log("[native-voice] <audio> element playback succeeded");
              return;
            } catch (e) {
              console.warn("[native-voice] <audio> element failed:", e);
            }

            // If we got audio data but both playback methods failed, don't retry server
            // — the issue is playback not generation. Fall through to browser TTS.
            break;
          }
        } else {
          console.warn(`[native-voice] Server TTS HTTP ${res.status} (attempt ${attempt})`);
          if (attempt < MAX_CLIENT_RETRIES) {
            await new Promise(r => setTimeout(r, 300));
            continue; // Retry
          }
        }
      } catch (err) {
        console.warn(`[native-voice] Server TTS error (attempt ${attempt}):`, err);
        if (attempt < MAX_CLIENT_RETRIES) {
          await new Promise(r => setTimeout(r, 300));
          continue; // Retry
        }
      }
    }

    // Final fallback: browser speechSynthesis
    if (!this._isConnected) return;
    console.log("[native-voice] All server TTS methods failed, falling back to browser speechSynthesis");
    try {
      await this.speakWithBrowserTTS(text);
      console.log("[native-voice] Browser TTS completed");
    } catch (err) {
      console.error("[native-voice] All TTS methods failed:", err);
    }
  }

  /** Browser TTS with 5s timeout and iOS workarounds */
  private speakWithBrowserTTS(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) {
        console.warn("[native-voice] No speechSynthesis available");
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

      // Cancel any previous speech first (iOS can queue and stall)
      window.speechSynthesis.cancel();

      // 5s safety timeout (reduced from 10s — if it hasn't spoken by then, it won't)
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
      utterance.onerror = (e) => {
        console.warn("[native-voice] Browser TTS error event:", e);
        finish();
      };

      // iOS workaround: speechSynthesis.speaking can freeze — periodically
      // resume to keep the queue moving (known Safari bug)
      const iosKeepAlive = setInterval(() => {
        if (window.speechSynthesis.speaking) {
          window.speechSynthesis.pause();
          window.speechSynthesis.resume();
        }
      }, 3000);

      window.speechSynthesis.speak(utterance);
      console.log("[native-voice] Browser TTS started:", text.substring(0, 40));
    });
  }

  private playAudioViaElement(data: ArrayBuffer, mimeType: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const blob = new Blob([data], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        audio.onerror = (e) => {
          URL.revokeObjectURL(url);
          reject(e);
        };
        const playPromise = audio.play();
        if (playPromise) {
          playPromise.catch((err) => {
            URL.revokeObjectURL(url);
            reject(err);
          });
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  /** FIX 4: No async Promise executor — use proper async/await pattern */
  private async playAudioBuffer(data: ArrayBuffer): Promise<void> {
    // Always create a dedicated playback context (don't share with monitoring).
    // This prevents TTS playback from corrupting the mic monitoring AudioContext.
    if (!this.playbackContext || this.playbackContext.state === "closed") {
      this.playbackContext = new AudioContext();
    }
    if (this.playbackContext.state === "suspended") {
      await this.playbackContext.resume();
    }

    const audioBuffer = await this.playbackContext.decodeAudioData(data.slice(0));

    return new Promise<void>((resolve, reject) => {
      try {
        const source = this.playbackContext!.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.playbackContext!.destination);
        source.onended = () => resolve();
        source.start();
      } catch (err) {
        reject(err);
      }
    });
  }

  // ===================================================================
  // Volume monitoring & Disconnect
  // ===================================================================

  /** FIX 6: Use setInterval at ~7fps instead of requestAnimationFrame at 60fps */
  private startVolumeMonitor(): void {
    if (!this.volumeAnalyser) return;
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
    }, 150); // ~7fps — enough for smooth bars, not enough to cause jank
  }

  private stopVolumeMonitor(): void {
    if (this.volumeInterval !== null) {
      clearInterval(this.volumeInterval);
      this.volumeInterval = null;
    }
  }

  disconnect(): void {
    console.log("[native-voice] Disconnecting...");
    this.shouldRestart = false;
    this._isConnected = false;
    this.greetingDone = false;

    // Stop volume monitor (FIX 6: now uses clearInterval)
    this.stopVolumeMonitor();

    // Stop silence detection
    this.stopSilenceDetection();

    // Stop recognition (Strategy A)
    try { this.recognition?.stop(); } catch { /* ignore */ }
    this.recognition = null;

    // Stop MediaRecorder (Strategy B)
    this.stopMediaRecording();
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.isRecording = false;

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

    // Stop any browser TTS
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    this.isProcessing = false;
    this.callbacks.onClose?.();
  }
}
