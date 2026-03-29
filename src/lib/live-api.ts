import { GoogleGenAI, LiveServerMessage, Modality, ThinkingLevel } from "@google/genai";

export type LiveConfig = {
  systemInstruction?: string;
  onMessage?: (message: LiveServerMessage) => void;
  onClose?: () => void;
  onError?: (error: Error) => void;
};

export class LiveAPIConnection {
  private ai: GoogleGenAI;
  private session: any = null;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  }

  async connect(config: LiveConfig) {
    this.session = await this.ai.live.connect({
      model: "gemini-3.1-flash-live-preview",
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: config.systemInstruction || "You are Scott's Kitchen AI assistant. Help users order food.",
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
        },
      },
      callbacks: {
        onmessage: (message) => config.onMessage?.(message),
        onclose: () => config.onClose?.(),
        onerror: (error) => config.onError?.(new Error(String(error))),
      },
    });
    return this.session;
  }

  sendAudio(base64Data: string) {
    if (this.session) {
      this.session.sendRealtimeInput({
        audio: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
      });
    }
  }

  sendText(text: string) {
    if (this.session) {
      this.session.sendRealtimeInput({ text });
    }
  }

  disconnect() {
    if (this.session) {
      this.session.close();
      this.session = null;
    }
  }
}
