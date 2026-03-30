/**
 * NativeVoiceService — Uses Web Speech API (STT) + Server-side Gemini TTS.
 *
 * This avoids the WebSocket limitation in WKWebView (Capacitor iOS).
 * Instead of Gemini Live's bidirectional WebSocket, we:
 *   1. Use the browser's built-in SpeechRecognition for voice input
 *   2. Route transcriptions to Agentforce via the existing callback
 *   3. Use the server's /api/tts endpoint (Gemini REST) for speech output
 *
 * Falls back gracefully: if SpeechRecognition is unavailable, reports error.
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

export class NativeVoiceService {
  private recognition: any = null;
  private callbacks: NativeVoiceCallbacks = {};
  private isProcessing = false;
  private audioContext: AudioContext | null = null;
  private playbackContext: AudioContext | null = null; // Separate context for TTS playback
  private mediaStream: MediaStream | null = null;
  private volumeAnalyser: AnalyserNode | null = null;
  private volumeInterval: number | null = null;
  private _isConnected = false;
  private shouldRestart = false;
  private playbackQueue: ArrayBuffer[] = [];
  private isPlaying = false;

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(callbacks: NativeVoiceCallbacks): Promise<void> {
    this.callbacks = callbacks;
    callbacks.onStatusChange?.("Connecting...");

    // Check for SpeechRecognition support
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      const msg = "Speech recognition not supported on this device";
      callbacks.onError?.(msg);
      callbacks.onStatusChange?.(msg);
      throw new Error(msg);
    }

    try {
      // Request microphone access for volume visualization
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
      // iOS/WebKit blocks AudioContext playback unless it's "unlocked"
      // during a user gesture. This connect() is called from the mic
      // button tap (a user gesture), so we unlock everything now.

      // 1. Create a dedicated playback AudioContext and resume it
      this.playbackContext = new AudioContext();
      await this.playbackContext.resume();
      console.log("[native-voice] Playback AudioContext state:", this.playbackContext.state);

      // 2. Play a tiny silent buffer to fully unlock iOS audio
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

      // 3. Pre-warm browser speechSynthesis (fallback TTS)
      if ("speechSynthesis" in window) {
        const warmup = new SpeechSynthesisUtterance("");
        warmup.volume = 0;
        window.speechSynthesis.speak(warmup);
        console.log("[native-voice] speechSynthesis pre-warmed");
      }

      // Set up and start speech recognition
      this.setupRecognition();
      this.shouldRestart = true;
      this.recognition.start();

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

  private restartRecognition(): void {
    setTimeout(() => {
      if (!this.shouldRestart || !this._isConnected) return;

      try {
        // Try to start the existing recognition instance
        if (this.recognition) {
          console.log("[native-voice] Restarting recognition...");
          this.recognition.start();
          return;
        }
      } catch (err) {
        console.warn("[native-voice] recognition.start() failed, recreating:", err);
      }

      // If start() failed or recognition is null, recreate it entirely
      // iOS WebKit often needs a fresh SpeechRecognition after audio playback
      try {
        this.setupRecognition();
        this.recognition?.start();
        console.log("[native-voice] Recognition recreated and started");
      } catch (err2) {
        console.error("[native-voice] Failed to recreate recognition:", err2);
        this.callbacks.onStatusChange?.("Tap mic to retry");
      }
    }, 500);
  }

  /**
   * Create (or recreate) the SpeechRecognition instance with all event handlers.
   * Needed for iOS WebKit which can invalidate recognition after audio playback.
   */
  private setupRecognition(): void {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) return;

    // Stop any existing instance
    try { this.recognition?.stop(); } catch { /* ignore */ }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = false;
    this.recognition.lang = "en-US";
    this.recognition.maxAlternatives = 1;

    this.recognition.onstart = () => {
      console.log("[native-voice] Recognition started");
      this.callbacks.onStatusChange?.("Listening...");
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
      console.log("[native-voice] Recognition ended");
      if (this.shouldRestart && this._isConnected) {
        this.restartRecognition();
      }
    };
  }

  /**
   * Send initial greeting — use browser TTS to speak it.
   */
  async sendGreeting(greetingResponse: string): Promise<void> {
    if (!greetingResponse) return;
    console.log("[native-voice] Speaking greeting:", greetingResponse.substring(0, 80));
    this.callbacks.onStatusChange?.("Speaking...");

    // Pause recognition while speaking to avoid picking up our own audio
    this.pauseRecognition();
    await this.speakText(greetingResponse);
    this.resumeRecognition();
  }

  private pauseRecognition(): void {
    try {
      this.shouldRestart = false;
      this.recognition?.stop();
    } catch {
      // Ignore
    }
  }

  private resumeRecognition(): void {
    this.shouldRestart = true;
    if (this._isConnected) {
      console.log("[native-voice] Resuming recognition...");
      this.callbacks.onStatusChange?.("Listening...");
      this.restartRecognition();
    }
  }

  /**
   * Route user text to Agentforce, then speak the response.
   */
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
        console.log("[native-voice] Agent response:", agentResponse.substring(0, 100));

        if (agentResponse) {
          this.callbacks.onStatusChange?.("Speaking...");
          this.pauseRecognition();
          try {
            await this.speakText(agentResponse);
          } catch (speakErr) {
            console.error("[native-voice] speakText failed:", speakErr);
          }
          this.resumeRecognition();
        } else {
          console.warn("[native-voice] Empty agent response");
          this.callbacks.onStatusChange?.("Listening...");
        }
      }
    } catch (err: any) {
      console.error("[native-voice] Agent routing error:", err);
      this.pauseRecognition();
      try {
        await this.speakText("I'm sorry, I had trouble with that. Could you say it again?");
      } catch (speakErr) {
        console.error("[native-voice] Error speech failed too:", speakErr);
      }
      this.resumeRecognition();
    } finally {
      this.isProcessing = false;
      console.log("[native-voice] Processing complete, isProcessing:", this.isProcessing);
    }
  }

  /**
   * Speak text using server-side TTS with triple-fallback:
   *   1. Server TTS → AudioContext (pre-warmed)
   *   2. Server TTS → <audio> HTML element (most iOS-compatible)
   *   3. Browser speechSynthesis
   */
  private async speakText(text: string): Promise<void> {
    try {
      // Try server-side TTS first (Gemini)
      console.log("[native-voice] Fetching TTS for:", text.substring(0, 60));
      const res = await fetch(apiUrl("/api/tts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (res.ok) {
        const contentType = res.headers.get("content-type") || "audio/wav";
        const audioData = await res.arrayBuffer();
        console.log("[native-voice] TTS response: ", audioData.byteLength, "bytes,", contentType);

        if (audioData.byteLength > 0) {
          // Try 1: AudioContext (pre-warmed during user gesture)
          try {
            await this.playAudioBuffer(audioData);
            console.log("[native-voice] ✓ AudioContext playback succeeded");
            return;
          } catch (e) {
            console.warn("[native-voice] AudioContext playback failed, trying <audio> element:", e);
          }

          // Try 2: HTML <audio> element (most reliable on iOS)
          try {
            await this.playAudioViaElement(audioData, contentType);
            console.log("[native-voice] ✓ <audio> element playback succeeded");
            return;
          } catch (e) {
            console.warn("[native-voice] <audio> element playback failed:", e);
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

  /**
   * Play audio via an HTML <audio> element — most reliable on iOS.
   * Creates a Blob URL from the raw audio data and plays it through
   * a standard media element, bypassing AudioContext entirely.
   */
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
          console.warn("[native-voice] <audio> element error:", e);
          URL.revokeObjectURL(url);
          reject(e);
        };
        // play() returns a promise on modern browsers
        const playPromise = audio.play();
        if (playPromise) {
          playPromise.catch((err) => {
            console.warn("[native-voice] <audio> play() rejected:", err);
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
        // Use the pre-warmed playbackContext (unlocked during user gesture)
        // Fall back to audioContext or a new one if needed
        let ctx = this.playbackContext || this.audioContext;
        if (!ctx || ctx.state === "closed") {
          ctx = new AudioContext();
        }
        // Ensure the context is running (iOS may suspend it)
        if (ctx.state === "suspended") {
          await ctx.resume();
        }
        console.log("[native-voice] AudioContext playback, state:", ctx.state);
        const audioBuffer = await ctx.decodeAudioData(data.slice(0));
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        source.onended = () => resolve();
        source.start();
      } catch (err) {
        console.warn("[native-voice] AudioContext playback error:", err);
        // Reject so speakText() can try the <audio> element fallback
        reject(err);
      }
    });
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

  disconnect(): void {
    this.shouldRestart = false;
    this._isConnected = false;

    // Stop volume monitor
    if (this.volumeInterval) {
      cancelAnimationFrame(this.volumeInterval);
      this.volumeInterval = null;
    }

    // Stop recognition
    try {
      this.recognition?.stop();
    } catch {
      // Ignore
    }
    this.recognition = null;

    // Stop mic
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    this.volumeAnalyser = null;

    // Close audio contexts
    this.audioContext?.close();
    this.audioContext = null;
    this.playbackContext?.close();
    this.playbackContext = null;

    // Stop any browser TTS
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }

    this.isProcessing = false;
    this.callbacks.onClose?.();
  }
}
