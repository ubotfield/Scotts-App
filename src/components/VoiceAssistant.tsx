import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Mic } from "lucide-react";
import { GeminiLiveService, hasGeminiApiKey } from "../lib/gemini";
import { NativeVoiceService } from "../lib/native-voice";
import { AgentforceSession } from "../lib/agentforce-api";
import { cn } from "../lib/utils";

/**
 * VoiceAssistant — inline popup bar (not full-screen overlay).
 *
 * Platform-aware voice:
 *   - Desktop/Chrome: Gemini Live (bidirectional WebSocket)
 *   - iOS/Capacitor/Safari: Native Web Speech API + server-side TTS
 *     (WKWebView blocks Gemini's WebSocket connection)
 */

interface VoiceAssistantProps {
  onOrderPlaced?: (order: any) => void;
}

/**
 * Detect if we should use NativeVoiceService (Web Speech API + server TTS)
 * instead of Gemini Live (bidirectional WebSocket).
 *
 * Returns true when:
 *   1. Running inside Capacitor (native iOS app)
 *   2. Running on iOS Safari / WKWebView (WebSocket issues with Gemini)
 *   3. Running as standalone PWA on iOS
 *   4. Gemini API key is missing from the build (no client-side Gemini possible)
 *   5. Any mobile device (Web Speech is more reliable on mobile)
 */
function shouldUseNativeVoice(): boolean {
  // Check for Capacitor
  if ((window as any).Capacitor?.isNativePlatform?.()) return true;
  if ((window as any).Capacitor?.getPlatform?.() === "ios") return true;

  // Check for iOS Safari/WKWebView (also has WebSocket issues with Gemini)
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIOS) return true;

  // Check for standalone PWA on iOS
  if ((navigator as any).standalone) return true;

  // Check for any mobile device — Web Speech API is more reliable on mobile
  const isMobile = /Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  if (isMobile) return true;

  // If the Gemini API key wasn't baked into this build, Gemini Live can't work.
  // Fall back to Web Speech API + server-side TTS on ALL platforms.
  if (!hasGeminiApiKey()) {
    console.log("[voice] No Gemini API key in build — using Web Speech API + server TTS");
    return true;
  }

  return false;
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
  const nativeRef = useRef<NativeVoiceService | null>(null);
  const agentRef = useRef<AgentforceSession | null>(null);
  const useNativeRef = useRef(false);

  const toggleAssistant = async () => {
    if (isActive || hasError) {
      // ─── Stop ─────────────────────────────────────────────
      geminiRef.current?.disconnect();
      geminiRef.current = null;

      nativeRef.current?.disconnect();
      nativeRef.current = null;

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
      if (nativeRef.current) {
        nativeRef.current.disconnect();
        nativeRef.current = null;
      }
      if (agentRef.current) {
        agentRef.current.end();
        agentRef.current = null;
      }

      // Detect platform
      useNativeRef.current = shouldUseNativeVoice();
      console.log("[voice] Platform:", useNativeRef.current ? "native (Web Speech)" : "desktop (Gemini Live)");

      try {
        // 1. Start Agentforce session
        const agent = new AgentforceSession();
        await agent.start();
        agentRef.current = agent;

        const voiceCallbacks = {
          onOpen: async () => {
            setIsActive(true);
            setIsConnecting(false);
            setIsListening(true);
            setHasError(false);
            hasErrorRef.current = false;

            // Send initial greeting to Agentforce
            try {
              if (agentRef.current?.isActive) {
                setStatus("Getting greeting...");
                const greeting = await agentRef.current.sendMessage("Hello");
                console.log("[voice] Greeting from agent:", greeting.substring(0, 80));

                if (useNativeRef.current) {
                  nativeRef.current?.sendGreeting(greeting);
                } else {
                  geminiRef.current?.sendGreeting(greeting);
                }
              }
            } catch (err) {
              console.warn("[voice] Greeting failed (non-fatal):", err);
              setStatus("Listening...");
            }
          },
          onClose: () => {
            if (!hasErrorRef.current) {
              setIsActive(false);
              setIsListening(false);
              setIsConnecting(false);
              setVolume(0);
            }
          },
          onError: (err: string) => {
            console.error("[voice] Error:", err);
            setHasError(true);
            hasErrorRef.current = true;
            setIsConnecting(false);
            setIsListening(false);
          },
          onVolumeChange: (v: number) => {
            setVolume(v * 2);
          },
          onStatusChange: (s: string) => {
            setStatus(s);
          },
          onUserTranscription: async (userText: string) => {
            if (!agentRef.current?.isActive) {
              return "I'm sorry, the connection was lost. Please try again.";
            }
            console.log("[voice] → Agentforce:", userText);
            setStatus("Processing...");
            const response = await agentRef.current.sendMessage(userText);
            console.log("[voice] ← Agentforce:", response.substring(0, 80));
            return response;
          },
        };

        // 2. Start voice service based on platform
        if (useNativeRef.current) {
          const native = new NativeVoiceService();
          nativeRef.current = native;
          await native.connect(voiceCallbacks);
        } else {
          const service = new GeminiLiveService();
          geminiRef.current = service;
          await service.connect(voiceCallbacks);
        }
      } catch (err: any) {
        const errMsg = err?.message || err?.toString?.() || JSON.stringify(err) || "Unknown error";
        console.error("[voice] Failed to start:", errMsg, err);
        setHasError(true);
        hasErrorRef.current = true;
        setIsConnecting(false);
        setIsActive(false);
        setVolume(0);
        setStatus(errMsg.substring(0, 120));
      }
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      geminiRef.current?.disconnect();
      nativeRef.current?.disconnect();
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
