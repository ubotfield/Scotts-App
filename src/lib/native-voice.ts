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

      // Set up speech recognition
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = false;
      this.recognition.lang = "en-US";
      this.recognition.maxAlternatives = 1;

      this.recognition.onstart = () => {
        console.log("[native-voice] Recognition started");
        callbacks.onStatusChange?.("Listening...");
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
        // "no-speech" and "aborted" are non-fatal — just restart
        if (event.error === "no-speech" || event.error === "aborted") {
          if (this.shouldRestart && this._isConnected) {
            this.restartRecognition();
          }
          return;
        }
        callbacks.onError?.(event.error);
        callbacks.onStatusChange?.(`Error: ${event.error}`);
      };

      this.recognition.onend = () => {
        console.log("[native-voice] Recognition ended");
        // Auto-restart if we're still supposed to be listening
        if (this.shouldRestart && this._isConnected) {
          this.restartRecognition();
        }
      };

      // Start recognition
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
    try {
      setTimeout(() => {
        if (this.shouldRestart && this._isConnected && this.recognition) {
          console.log("[native-voice] Restarting recognition");
          this.recognition.start();
        }
      }, 300);
    } catch (err) {
      console.warn("[native-voice] Failed to restart recognition:", err);
    }
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
        const agentResponse = await this.callbacks.onUserTranscription(userText);
        console.log("[native-voice] Agent response:", agentResponse.substring(0, 100));

        if (agentResponse) {
          this.callbacks.onStatusChange?.("Speaking...");
          this.pauseRecognition();
          await this.speakText(agentResponse);
          this.resumeRecognition();
        }
      }
    } catch (err: any) {
      console.error("[native-voice] Agent routing error:", err);
      this.pauseRecognition();
      await this.speakText("I'm sorry, I had trouble with that. Could you say it again?");
      this.resumeRecognition();
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Speak text using server-side TTS endpoint, with browser speechSynthesis fallback.
   */
  private async speakText(text: string): Promise<void> {
    try {
      // Try server-side TTS first (Gemini)
      const res = await fetch(apiUrl("/api/tts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (res.ok) {
        const audioData = await res.arrayBuffer();
        if (audioData.byteLength > 0) {
          await this.playAudioBuffer(audioData);
          return;
        }
      }
      console.warn("[native-voice] Server TTS failed, falling back to browser TTS");
    } catch (err) {
      console.warn("[native-voice] Server TTS error, falling back:", err);
    }

    // Fallback: browser speechSynthesis
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

  private async playAudioBuffer(data: ArrayBuffer): Promise<void> {
    return new Promise(async (resolve) => {
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
        console.log("[native-voice] Playing audio via context state:", ctx.state);
        const audioBuffer = await ctx.decodeAudioData(data.slice(0));
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        source.onended = () => resolve();
        source.start();
      } catch (err) {
        console.warn("[native-voice] Audio playback error:", err);
        // Fallback: try browser TTS if audio playback fails
        resolve();
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
