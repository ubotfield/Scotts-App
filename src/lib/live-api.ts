import { GoogleGenAI, Modality } from "@google/genai";

/**
 * Gemini Live API connection — used ONLY for text-to-speech (TTS).
 *
 * Flow: Agentforce returns text → we send it to Gemini → Gemini speaks it with the Zephyr voice.
 * Speech-to-text is handled by the browser's SpeechRecognition API instead.
 */

export type TTSConfig = {
  onAudio?: (base64AudioData: string) => void;
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
};

export class LiveTTSConnection {
  private ai: GoogleGenAI;
  private session: any = null;
  private config: TTSConfig = {};

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  }

  /**
   * Connect to Gemini Live API in TTS-only mode.
   */
  async connect(config: TTSConfig): Promise<void> {
    this.config = config;

    this.session = await this.ai.live.connect({
      model: "gemini-3.1-flash-live-preview",
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction:
          "You are a voice relay. When you receive text, speak it out loud naturally and conversationally as if you are a friendly restaurant ordering assistant. Do not add any extra commentary or change the meaning. Just read the text warmly and clearly.",
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Zephyr" },
          },
        },
      },
      callbacks: {
        onmessage: (message: any) => {
          // Handle audio data from Gemini
          if (message.serverContent?.modelTurn?.parts) {
            for (const part of message.serverContent.modelTurn.parts) {
              if (part.inlineData?.data) {
                this.config.onAudio?.(part.inlineData.data);
              }
            }
          }

          // Detect when model is done speaking
          if (message.serverContent?.turnComplete) {
            this.config.onSpeechEnd?.();
          }
        },
        onclose: () => {
          this.config.onClose?.();
        },
        onerror: (error: any) => {
          this.config.onError?.(new Error(String(error)));
        },
      },
    });
  }

  /**
   * Send text to Gemini to be spoken aloud.
   * This is the core method — takes Agentforce response text and converts to speech.
   */
  speakText(text: string): void {
    if (!this.session) {
      console.warn("[tts] No active session, cannot speak text");
      return;
    }

    this.config.onSpeechStart?.();

    // Send the text as a client message for Gemini to vocalize
    this.session.sendClientContent({
      turns: [
        {
          role: "user",
          parts: [{ text: `Please speak the following: "${text}"` }],
        },
      ],
      turnComplete: true,
    });
  }

  /**
   * Disconnect from Gemini Live API.
   */
  disconnect(): void {
    if (this.session) {
      this.session.close();
      this.session = null;
    }
  }

  get isConnected(): boolean {
    return this.session !== null;
  }
}
