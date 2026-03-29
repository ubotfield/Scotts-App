import React, { useEffect, useRef, useState, useCallback } from "react";
import { AgentforceSession, AgentMessage } from "../lib/agentforce-api";
import { LiveTTSConnection } from "../lib/live-api";
import { Mic, MicOff, X, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface VoiceAssistantProps {
  isActive: boolean;
  onToggle: () => void;
}

type SessionState = "idle" | "connecting" | "listening" | "processing" | "speaking" | "error";

// Browser SpeechRecognition API types
interface SpeechRecognitionEvent {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

export const VoiceAssistant: React.FC<VoiceAssistantProps> = ({
  isActive,
  onToggle,
}) => {
  const [state, setState] = useState<SessionState>("idle");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [interimText, setInterimText] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const agentRef = useRef<AgentforceSession | null>(null);
  const ttsRef = useRef<LiveTTSConnection | null>(null);
  const recognitionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom of messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, interimText]);

  // ─── Play audio from Gemini TTS ─────────────────────────────
  const playAudio = useCallback((base64Data: string) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext({ sampleRate: 24000 });
    }

    const ctx = audioContextRef.current;
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const pcm = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 0x7fff;

    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
  }, []);

  // ─── Send user text to Agentforce ───────────────────────────
  const handleUserMessage = useCallback(
    async (text: string) => {
      if (!agentRef.current?.isActive || !text.trim()) return;

      setState("processing");
      setInterimText("");

      try {
        const response = await agentRef.current.sendMessage(text);
        setMessages(agentRef.current.messages);

        // Send agent response to Gemini TTS
        if (ttsRef.current?.isConnected && response) {
          setState("speaking");
          ttsRef.current.speakText(response);
        } else {
          // If TTS not available, go back to listening
          setState("listening");
          startRecognition();
        }
      } catch (err: any) {
        console.error("[voice] Agentforce error:", err);
        setErrorMsg(err.message || "Failed to get response");
        setState("error");
        // Retry listening after a brief delay
        setTimeout(() => {
          setErrorMsg("");
          setState("listening");
          startRecognition();
        }, 2000);
      }
    },
    [playAudio]
  );

  // ─── Speech Recognition (STT) ──────────────────────────────
  const startRecognition = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.start();
      } catch {
        // Already started
      }
    }
  }, []);

  const stopRecognition = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Already stopped
      }
    }
  }, []);

  const initRecognition = useCallback(() => {
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.error("[voice] SpeechRecognition API not supported");
      setErrorMsg("Voice recognition is not supported in this browser");
      setState("error");
      return null;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = "";
      let interimTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interimTranscript += result[0].transcript;
        }
      }

      if (interimTranscript) {
        setInterimText(interimTranscript);
      }

      if (finalTranscript.trim()) {
        handleUserMessage(finalTranscript.trim());
        stopRecognition();
      }
    };

    recognition.onend = () => {
      // Auto-restart if still in listening state
      // (speech recognition stops after silence)
    };

    recognition.onerror = (event: any) => {
      if (event.error === "no-speech") {
        // Just restart — user was quiet
        startRecognition();
        return;
      }
      console.error("[voice] Recognition error:", event.error);
    };

    return recognition;
  }, [handleUserMessage, stopRecognition, startRecognition]);

  // ─── Session lifecycle ──────────────────────────────────────
  const startSession = useCallback(async () => {
    setState("connecting");
    setMessages([]);
    setInterimText("");
    setErrorMsg("");

    try {
      // 1. Start Agentforce session
      const agent = new AgentforceSession();
      await agent.start();
      agentRef.current = agent;

      // 2. Start Gemini TTS connection
      const tts = new LiveTTSConnection();
      await tts.connect({
        onAudio: playAudio,
        onSpeechStart: () => {
          // Pause recognition while TTS is speaking
          stopRecognition();
        },
        onSpeechEnd: () => {
          // Resume listening after TTS finishes
          setState("listening");
          startRecognition();
        },
        onError: (err) => {
          console.error("[tts] Error:", err);
          // TTS failure isn't fatal — agent still works, just no voice output
        },
        onClose: () => {
          console.log("[tts] Connection closed");
        },
      });
      ttsRef.current = tts;

      // 3. Initialize speech recognition
      const recognition = initRecognition();
      if (!recognition) return;
      recognitionRef.current = recognition;

      // 4. Start listening
      setState("listening");
      recognition.start();

      // 5. Send initial greeting request to the agent
      try {
        const greeting = await agent.sendMessage("Hello");
        setMessages(agent.messages);
        if (tts.isConnected && greeting) {
          setState("speaking");
          stopRecognition();
          tts.speakText(greeting);
        }
      } catch {
        // Non-fatal — user can still interact
      }
    } catch (err: any) {
      console.error("[voice] Failed to start session:", err);
      setErrorMsg(err.message || "Failed to connect");
      setState("error");
    }
  }, [playAudio, stopRecognition, startRecognition, initRecognition]);

  const stopSession = useCallback(async () => {
    // Stop speech recognition
    stopRecognition();
    recognitionRef.current = null;

    // Disconnect TTS
    ttsRef.current?.disconnect();
    ttsRef.current = null;

    // End agent session
    await agentRef.current?.end();
    agentRef.current = null;

    // Close audio context
    audioContextRef.current?.close();
    audioContextRef.current = null;

    setState("idle");
    setMessages([]);
    setInterimText("");
    setErrorMsg("");
  }, [stopRecognition]);

  // ─── React to isActive changes ──────────────────────────────
  useEffect(() => {
    if (isActive) {
      startSession();
    } else {
      stopSession();
    }
    return () => {
      stopSession();
    };
  }, [isActive]);

  // ─── Status text ────────────────────────────────────────────
  const getStatusText = () => {
    switch (state) {
      case "connecting":
        return "Connecting...";
      case "listening":
        return "Listening...";
      case "processing":
        return "Thinking...";
      case "speaking":
        return "Speaking...";
      case "error":
        return errorMsg || "Something went wrong";
      default:
        return "";
    }
  };

  const getStatusColor = () => {
    switch (state) {
      case "listening":
        return "bg-tertiary";
      case "processing":
        return "bg-primary animate-pulse";
      case "speaking":
        return "bg-secondary";
      case "error":
        return "bg-red-500";
      default:
        return "bg-primary";
    }
  };

  // ─── Render ─────────────────────────────────────────────────
  return (
    <AnimatePresence>
      {isActive && (
        <motion.div
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 25, stiffness: 300 }}
          className="fixed inset-0 z-50 bg-surface flex flex-col"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-on-surface/10">
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${getStatusColor()}`} />
              <span className="font-headline font-bold text-sm uppercase tracking-widest text-on-surface/70">
                {getStatusText()}
              </span>
            </div>
            <button
              onClick={onToggle}
              className="w-10 h-10 rounded-full bg-surface-container-high flex items-center justify-center hover:bg-surface-container-highest transition-colors"
            >
              <X size={20} className="text-on-surface" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {messages.map((msg, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] px-5 py-3 rounded-2xl ${
                    msg.role === "user"
                      ? "bg-primary text-on-primary rounded-br-md"
                      : "bg-surface-container-high text-on-surface rounded-bl-md"
                  }`}
                >
                  <p className="text-sm leading-relaxed">{msg.text}</p>
                </div>
              </motion.div>
            ))}

            {/* Interim speech text */}
            {interimText && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.6 }}
                className="flex justify-end"
              >
                <div className="max-w-[85%] px-5 py-3 rounded-2xl bg-primary/30 text-on-surface rounded-br-md border border-primary/20">
                  <p className="text-sm italic">{interimText}</p>
                </div>
              </motion.div>
            )}

            {/* Processing indicator */}
            {state === "processing" && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex justify-start"
              >
                <div className="px-5 py-3 rounded-2xl bg-surface-container-high rounded-bl-md">
                  <div className="flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin text-primary" />
                    <span className="text-sm text-on-surface/60">Thinking...</span>
                  </div>
                </div>
              </motion.div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Bottom controls */}
          <div className="px-6 py-6 border-t border-on-surface/10 flex flex-col items-center gap-4">
            {/* Voice visualization */}
            {(state === "listening" || state === "speaking") && (
              <div className="flex justify-center gap-1">
                {[...Array(7)].map((_, i) => (
                  <motion.div
                    key={i}
                    animate={{
                      height: state === "listening" ? [8, 28, 8] : [4, 16, 4],
                    }}
                    transition={{
                      duration: state === "listening" ? 0.6 : 0.4,
                      repeat: Infinity,
                      delay: i * 0.08,
                    }}
                    className={`w-1 rounded-full ${
                      state === "listening" ? "bg-primary" : "bg-secondary"
                    }`}
                  />
                ))}
              </div>
            )}

            {/* Mic button */}
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={onToggle}
              className={`w-20 h-20 rounded-full flex items-center justify-center shadow-2xl transition-colors ${
                state === "listening"
                  ? "bg-primary text-on-primary voice-pulse"
                  : state === "error"
                    ? "bg-red-500 text-white"
                    : "bg-surface-container-highest text-on-surface"
              }`}
            >
              {state === "connecting" ? (
                <Loader2 size={36} className="animate-spin" />
              ) : state === "listening" ? (
                <Mic size={36} fill="currentColor" />
              ) : (
                <MicOff size={36} />
              )}
            </motion.button>

            <p className="text-xs text-on-surface/50 font-medium text-center">
              {state === "listening"
                ? "Speak now — I'm listening"
                : state === "speaking"
                  ? "Hold on, I'm responding..."
                  : state === "processing"
                    ? "Working on your request..."
                    : "Tap to end conversation"}
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
