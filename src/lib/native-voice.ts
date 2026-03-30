/**
 * NativeVoiceService — Cross-platform voice with dual STT strategy:
 *
 *   Strategy A (Safari/Safari PWA): Web Speech API (SpeechRecognition)
 *   Strategy B (Chrome/Chrome PWA/homescreen): MediaRecorder → server-side Gemini STT
 *
 * Both strategies share the same TTS pipeline:
 *   Server-side Gemini TTS → AudioContext / <audio> element / browser speechSynthesis
 *
 * The fallback to MediaRecorder is needed because Apple restricts SpeechRecognition
 * to Safari only — it's unavailable in iOS Chrome, PWA standalone, and WKWebView.
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

export class NativeVoiceService {
  // ── Shared state ──────────────────────────────────────────────
  private callbacks: NativeVoiceCallbacks = {};
  private isProcessing = false;
  private audioContext: AudioContext | null = null;
  private playbackContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private volumeAnalyser: AnalyserNode | null = null;
  private volumeInterval: number | null = null;
  private _isConnected = false;
  private shouldRestart = false;

  // ── STT mode ──────────────────────────────────────────────────
  private sttMode: SttMode = "speech-recognition";

  // Strategy A: Web Speech API
  private recognition: any = null;

  // Strategy B: MediaRecorder + server STT
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private isRecording = false;
  private silenceDetectionInterval: number | null = null;
  private supportedMimeType: string = "audio/webm";

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(callbacks: NativeVoiceCallbacks): Promise<void> {
    this.callbacks = callbacks;
    callbacks.onStatusChange?.("Connecting...");

    // Detect which STT strategy to use
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    this.sttMode = SpeechRecognition ? "speech-recognition" : "media-recorder";
    console.log("[native-voice] STT mode:", this.sttMode);

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
      this.startVolumeMonitor();

      // ── Pre-warm audio for iOS ──────────────────────────────
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

      // ── Detect supported MIME type for MediaRecorder ────────
      if (this.sttMode === "media-recorder") {
        this.supportedMimeType = this.getSupportedMimeType();
        console.log("[native-voice] MediaRecorder MIME:", this.supportedMimeType);
      }

      // ── Start listening based on STT strategy ───────────────
      this.shouldRestart = true;
      if (this.sttMode === "speech-recognition") {
        this.setupRecognition();
        try {
          this.recognition.start();
        } catch (e) {
          console.warn("[native-voice] Initial recognition.start() failed:", e);
        }
      } else {
        this.startMediaRecording();
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

  // ═══════════════════════════════════════════════════════════════
  // Strategy A: Web Speech API (SpeechRecognition)
  // ═══════════════════════════════════════════════════════════════

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

  // ═══════════════════════════════════════════════════════════════
  // Strategy B: MediaRecorder → Server-side STT
  // ═══════════════════════════════════════════════════════════════

  private startMediaRecording(): void {
    if (!this.mediaStream || !this._isConnected) {
      console.warn("[native-voice] Cannot start recording: no stream or not connected");
      return;
    }

    // Verify the media stream is still active
    const tracks = this.mediaStream.getAudioTracks();
    if (tracks.length === 0 || tracks[0].readyState !== "live") {
      console.warn("[native-voice] Media stream tracks not live, cannot record");
      this.callbacks.onStatusChange?.("Mic error — tap to retry");
      return;
    }

    console.log("[native-voice] Starting MediaRecorder, MIME:", this.supportedMimeType);

    try {
      this.recordedChunks = [];

      // Create a fresh MediaRecorder each time
      this.mediaRecorder = new MediaRecorder(this.mediaStream, {
        mimeType: this.supportedMimeType,
        audioBitsPerSecond: 64000,
      });

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        console.log("[native-voice] MediaRecorder stopped, chunks:", this.recordedChunks.length);
        this.isRecording = false;

        if (this.recordedChunks.length > 0) {
          const blob = new Blob(this.recordedChunks, { type: this.supportedMimeType });
          this.recordedChunks = [];

          // Only transcribe if blob has meaningful audio (> 2KB)
          if (blob.size > 2000) {
            console.log("[native-voice] Sending", Math.round(blob.size / 1024), "KB for transcription");
            this.transcribeAudio(blob, this.supportedMimeType);
          } else {
            console.log("[native-voice] Audio too short (" + blob.size + " bytes), restarting");
            this.scheduleMediaRestart();
          }
        } else {
          console.log("[native-voice] No recorded data, restarting");
          this.scheduleMediaRestart();
        }
      };

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
      // Try without options as last resort
      try {
        this.mediaRecorder = new MediaRecorder(this.mediaStream);
        this.supportedMimeType = this.mediaRecorder.mimeType || "audio/webm";
        console.log("[native-voice] Retrying MediaRecorder with default MIME:", this.supportedMimeType);
        this.mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) this.recordedChunks.push(event.data);
        };
        this.mediaRecorder.onstop = () => {
          this.isRecording = false;
          if (this.recordedChunks.length > 0) {
            const blob = new Blob(this.recordedChunks, { type: this.supportedMimeType });
            this.recordedChunks = [];
            if (blob.size > 2000) {
              this.transcribeAudio(blob, this.supportedMimeType);
            } else {
              this.scheduleMediaRestart();
            }
          } else {
            this.scheduleMediaRestart();
          }
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
    // On iOS, audio/mp4 is most reliable
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

    let hasSpeech = false;
    let silenceSince: number | null = null;
    const recordingStart = Date.now();

    this.silenceDetectionInterval = window.setInterval(() => {
      if (!this.volumeAnalyser || !this.isRecording) {
        this.stopSilenceDetection();
        return;
      }

      this.volumeAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const volume = sum / dataArray.length / 255;

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

      // Safety: max recording duration
      if (Date.now() - recordingStart > MAX_RECORDING && hasSpeech) {
        console.log("[native-voice] Max recording duration reached");
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

  /** Schedule a MediaRecorder restart with a short delay */
  private scheduleMediaRestart(): void {
    if (!this.shouldRestart || !this._isConnected) return;
    setTimeout(() => {
      if (this.shouldRestart && this._isConnected && !this.isProcessing && !this.isRecording) {
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

  // ═══════════════════════════════════════════════════════════════
  // Shared: Greeting, Agent routing, TTS
  // ═══════════════════════════════════════════════════════════════

  async sendGreeting(greetingResponse: string): Promise<void> {
    if (!greetingResponse) return;
    console.log("[native-voice] Speaking greeting:", greetingResponse.substring(0, 80));
    this.callbacks.onStatusChange?.("Speaking...");

    this.pauseListening();
    await this.speakText(greetingResponse);

    // Small delay before resuming to let iOS audio system settle
    await new Promise(r => setTimeout(r, 300));
    this.resumeListening();
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

  private resumeListening(): void {
    console.log("[native-voice] Resuming listening (mode:", this.sttMode + ")");
    this.shouldRestart = true;
    if (!this._isConnected) return;

    this.callbacks.onStatusChange?.("Listening...");

    if (this.sttMode === "speech-recognition") {
      // For Safari PWA: recreate recognition fresh after audio playback
      this.restartRecognition();
    } else {
      // For MediaRecorder: start a new recording session
      // Use direct call instead of scheduleMediaRestart to avoid isProcessing check
      setTimeout(() => {
        if (this.shouldRestart && this._isConnected && !this.isRecording) {
          this.startMediaRecording();
        }
      }, 200);
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
        console.log("[native-voice] Sending to agent:", userText);
        const agentResponse = await this.callbacks.onUserTranscription(userText);
        console.log("[native-voice] Agent response:", agentResponse?.substring(0, 100));

        if (agentResponse) {
          this.callbacks.onStatusChange?.("Speaking...");
          this.pauseListening();
          try {
            await this.speakText(agentResponse);
          } catch (speakErr) {
            console.error("[native-voice] speakText failed:", speakErr);
          }
          // Small delay before resuming
          await new Promise(r => setTimeout(r, 300));
          this.resumeListening();
        } else {
          console.warn("[native-voice] Empty agent response");
          this.callbacks.onStatusChange?.("Listening...");
          this.scheduleMediaRestart();
        }
      }
    } catch (err: any) {
      console.error("[native-voice] Agent routing error:", err);
      this.pauseListening();
      try {
        await this.speakText("I'm sorry, I had trouble with that. Could you say it again?");
      } catch (speakErr) {
        console.error("[native-voice] Error speech failed too:", speakErr);
      }
      await new Promise(r => setTimeout(r, 300));
      this.resumeListening();
    } finally {
      this.isProcessing = false;
      console.log("[native-voice] Processing complete, isProcessing:", this.isProcessing);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // TTS: Server Gemini TTS with triple-fallback playback
  // ═══════════════════════════════════════════════════════════════

  private async speakText(text: string): Promise<void> {
    try {
      console.log("[native-voice] Fetching TTS for:", text.substring(0, 60));
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
            console.log("[native-voice] ✓ AudioContext playback succeeded");
            return;
          } catch (e) {
            console.warn("[native-voice] AudioContext failed, trying <audio>:", e);
          }

          // Try 2: HTML <audio> element (most reliable on iOS)
          try {
            await this.playAudioViaElement(audioData, contentType);
            console.log("[native-voice] ✓ <audio> element playback succeeded");
            return;
          } catch (e) {
            console.warn("[native-voice] <audio> element failed:", e);
          }
        }
      } else {
        console.warn("[native-voice] Server TTS HTTP", res.status);
      }
    } catch (err) {
      console.warn("[native-voice] Server TTS error:", err);
    }

    // Try 3: browser speechSynthesis
    console.log("[native-voice] Falling back to browser speechSynthesis");
    return this.speakWithBrowserTTS(text);
  }

  private speakWithBrowserTTS(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) {
        console.warn("[native-voice] No speechSynthesis available");
        resolve();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
      utterance.lang = "en-US";
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();

      window.speechSynthesis.speak(utterance);
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

  private async playAudioBuffer(data: ArrayBuffer): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        let ctx = this.playbackContext || this.audioContext;
        if (!ctx || ctx.state === "closed") {
          ctx = new AudioContext();
        }
        if (ctx.state === "suspended") {
          await ctx.resume();
        }
        const audioBuffer = await ctx.decodeAudioData(data.slice(0));
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        source.onended = () => resolve();
        source.start();
      } catch (err) {
        reject(err);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Volume monitoring & Disconnect
  // ═══════════════════════════════════════════════════════════════

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

  disconnect(): void {
    console.log("[native-voice] Disconnecting...");
    this.shouldRestart = false;
    this._isConnected = false;

    // Stop volume monitor
    if (this.volumeInterval) {
      cancelAnimationFrame(this.volumeInterval);
      this.volumeInterval = null;
    }

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
