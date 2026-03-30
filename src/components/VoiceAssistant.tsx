import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic, X } from "lucide-react";
import { GeminiLiveService } from "../lib/gemini";
import { AgentforceSession } from "../lib/agentforce-api";
import { cn } from "../lib/utils";

/**
 * VoiceAssistant — inline popup bar (not full-screen overlay).
 *
 * Flow:
 *   User speaks → Gemini Live (STT) → sendToAgent function call
 *   → AgentforceSession.sendMessage() → Agentforce Agent API
 *   → response text → returned to Gemini as function result
 *   → Gemini speaks it (TTS)
 */

interface VoiceAssistantProps {
  onOrderPlaced?: (order: any) => void;
}

export const VoiceAssistant: React.FC<VoiceAssistantProps> = ({
  onOrderPlaced,
}) => {
  const [isActive, setIsActive] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [volume, setVolume] = useState(0);
  const [status, setStatus] = useState("Listening...");
  const [hasError, setHasError] = useState(false);

  const hasErrorRef = useRef(false);
  const geminiRef = useRef<GeminiLiveService | null>(null);
  const agentRef = useRef<AgentforceSession | null>(null);

  const toggleAssistant = async () => {
    if (isActive || hasError) {
      // ─── Stop ─────────────────────────────────────────────
      geminiRef.current?.disconnect();
      geminiRef.current = null;

      // End Agentforce session
      agentRef.current?.end();
      agentRef.current = null;

      setIsActive(false);
      setIsListening(false);
      setIsConnecting(false);
      setHasError(false);
      hasErrorRef.current = false;
      setVolume(0);
      setStatus("Listening...");
    } else {
      // ─── Start ────────────────────────────────────────────
      setIsConnecting(true);
      setHasError(false);
      hasErrorRef.current = false;
      setStatus("Connecting...");

      // Clean up any existing sessions
      if (geminiRef.current) {
        geminiRef.current.disconnect();
        geminiRef.current = null;
      }
      if (agentRef.current) {
        agentRef.current.end();
        agentRef.current = null;
      }

      try {
        // 1. Start Agentforce session first
        const agent = new AgentforceSession();
        await agent.start();
        agentRef.current = agent;

        // 2. Start Gemini Live with function calling
        const service = new GeminiLiveService();
        geminiRef.current = service;

        await service.connect({
          onOpen: () => {
            setIsActive(true);
            setIsConnecting(false);
            setIsListening(true);
            setHasError(false);
            hasErrorRef.current = false;
          },
          onClose: () => {
            if (!hasErrorRef.current) {
              setIsActive(false);
              setIsListening(false);
              setIsConnecting(false);
              setVolume(0);
            }
          },
          onError: (err) => {
            console.error("[voice] Error:", err);
            setHasError(true);
            hasErrorRef.current = true;
            setIsConnecting(false);
            setIsListening(false);
          },
          onVolumeChange: (v) => {
            setVolume(v * 2);
          },
          onStatusChange: (s) => {
            setStatus(s);
          },
          onFunctionCall: async (name, args) => {
            // Gemini detected user speech and wants to send it to Agentforce
            if (name === "sendToAgent" && agentRef.current?.isActive) {
              const userMessage = (args.userMessage as string) || "";
              console.log("[voice] → Agentforce:", userMessage);
              setStatus("Processing...");

              const response = await agentRef.current.sendMessage(userMessage);
              console.log("[voice] ← Agentforce:", response.substring(0, 80));
              return response;
            }
            return "I'm sorry, I couldn't process that. Please try again.";
          },
          onMessage: (msg) => {
            // Check for function calls related to order placement
            if (msg.toolCall?.functionCalls) {
              for (const call of msg.toolCall.functionCalls) {
                if (call.name === "placeOrder" && call.args) {
                  onOrderPlaced?.(call.args);
                }
              }
            }
          },
        });
      } catch (err: any) {
        console.error("[voice] Failed to start:", err);
        setHasError(true);
        hasErrorRef.current = true;
        setIsConnecting(false);
        setIsActive(false);
        setVolume(0);
        setStatus(err.message || "Failed to connect");
      }
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      geminiRef.current?.disconnect();
      agentRef.current?.end();
    };
  }, []);

  return (
    <>
      {/* ─── Floating Mic Button ──────────────────────────────── */}
      <div className="fixed bottom-32 right-6 z-50">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={toggleAssistant}
          disabled={isConnecting}
          className={cn(
            "relative w-20 h-20 rounded-full flex items-center justify-center shadow-2xl transition-colors duration-500",
            isActive
              ? "bg-primary text-on-primary"
              : "bg-primary text-on-primary",
            isConnecting && "opacity-50 cursor-not-allowed"
          )}
        >
          {isActive && (
            <div className="absolute inset-0 rounded-full voice-pulse bg-primary/30" />
          )}
          <Mic size={32} />

          {isConnecting && (
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
              className="absolute inset-0 border-4 border-white/30 border-t-white rounded-full"
            />
          )}
        </motion.button>
      </div>

      {/* ─── Inline Status Bar (popup, not full-screen) ───────── */}
      <AnimatePresence>
        {(isActive || isConnecting || hasError) && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className={cn(
              "fixed bottom-32 left-1/2 -translate-x-1/2 z-40 w-[90%] max-w-lg px-8 py-6 rounded-2xl shadow-2xl flex items-center justify-between border backdrop-blur-md",
              hasError
                ? "border-red-500/50 bg-red-50/90"
                : "border-primary/10 bg-surface/90"
            )}
          >
            <div className="flex items-center gap-4">
              {/* Volume visualization bars */}
              <div className="flex gap-1.5 items-end h-8">
                {[...Array(5)].map((_, i) => (
                  <motion.div
                    key={i}
                    animate={{
                      height: isListening
                        ? Math.max(8, volume * (15 + i * 10) + Math.random() * 5)
                        : 8,
                    }}
                    transition={{
                      type: "spring",
                      stiffness: 300,
                      damping: 20,
                    }}
                    className={cn(
                      "w-1.5 rounded-full",
                      hasError ? "bg-red-500" : "bg-primary"
                    )}
                  />
                ))}
              </div>

              {/* Status text */}
              <div className="flex-1 min-w-0">
                <p
                  className={cn(
                    "font-headline font-black text-sm uppercase tracking-widest",
                    hasError
                      ? "text-red-600 whitespace-normal"
                      : "text-primary truncate"
                  )}
                >
                  {status}
                </p>
                <p className="text-xs text-on-surface/60 font-bold uppercase tracking-tighter truncate">
                  {hasError
                    ? "Tap Close to reset"
                    : '"Order my usual morning fuel"'}
                </p>
              </div>
            </div>

            {/* Stop / Close button */}
            <button
              onClick={toggleAssistant}
              className={cn(
                "px-6 py-2 rounded-full text-xs font-black uppercase tracking-widest transition-all flex-shrink-0",
                hasError
                  ? "bg-red-500/10 text-red-600 hover:bg-red-500 hover:text-white"
                  : "bg-primary/10 text-primary hover:bg-primary hover:text-on-primary"
              )}
            >
              {hasError ? "Close" : "Stop"}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
