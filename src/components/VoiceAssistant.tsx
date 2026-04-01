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
      // Capture refs before nulling — ensures cleanup runs even if React re-renders
      const gemini = geminiRef.current;
      const native = nativeRef.current;
      const agent = agentRef.current;

      // Null refs immediately to prevent any further callbacks
      geminiRef.current = null;
      nativeRef.current = null;
      agentRef.current = null;

      // Update UI state immediately
      setIsActive(false);
      setIsListening(false);
      setIsConnecting(false);
      setHasError(false);
      hasErrorRef.current = false;
      setVolume(0);
      setStatus("Listening...");

      // Now tear down services (order matters — stop voice first, then agent)
      try { gemini?.disconnect(); } catch { /* ignore */ }
      try { native?.disconnect(); } catch { /* ignore */ }
      try { agent?.end(); } catch { /* ignore */ }
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

      // ═══════════════════════════════════════════════════════
      // iOS PWA FIX: Call unlockAudio() SYNCHRONOUSLY here,
      // in the DIRECT user gesture (tap) context.
      // This grabs the mic and unlocks AudioContext BEFORE
      // any async work (agent.start, connect) breaks the
      // gesture chain that iOS requires.
      // ═══════════════════════════════════════════════════════
      let preCreatedNative: NativeVoiceService | null = null;
      if (useNativeRef.current) {
        preCreatedNative = new NativeVoiceService();
        preCreatedNative.unlockAudio(); // SYNC — in tap context
        nativeRef.current = preCreatedNative;
      }

      try {
        // 1. Start Agentforce session (async — mic already grabbed above)
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

                // Guard: don't speak greeting if user already disconnected
                if (!agentRef.current?.isActive) {
                  console.log("[voice] Session ended during greeting fetch, skipping");
                } else if (useNativeRef.current) {
                  await nativeRef.current?.sendGreeting(greeting);
                } else {
                  await geminiRef.current?.sendGreeting(greeting);
                }
                setStatus("Listening...");
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
          // Reuse the pre-created native service (unlockAudio already called in tap context)
          const native = preCreatedNative || new NativeVoiceService();
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
      <AnimatePresence>
        {!(isActive || isConnecting || hasError) && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            className="fixed bottom-32 right-6 z-50"
          >
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={toggleAssistant}
              disabled={isConnecting}
              className="relative w-20 h-20 rounded-full flex items-center justify-center shadow-2xl bg-primary text-on-primary"
            >
              <Mic size={32} />
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Voice Status Bar (replaces mic button when active) ─ */}
      <AnimatePresence>
        {(isActive || isConnecting || hasError) && (
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            className={cn(
              "fixed bottom-28 left-4 right-4 z-50 px-5 py-4 rounded-2xl shadow-2xl flex items-center gap-3 border",
              hasError
                ? "border-red-500/50 bg-red-50"
                : "border-primary/10 bg-surface"
            )}
          >
            {/* Mic icon / volume bars */}
            <div className="flex gap-1 items-end h-7 flex-shrink-0">
              {[...Array(4)].map((_, i) => (
                <motion.div
                  key={i}
                  animate={{
                    height: isListening
                      ? Math.max(6, volume * (12 + i * 8))
                      : 6,
                  }}
                  transition={{
                    type: "spring",
                    stiffness: 300,
                    damping: 20,
                  }}
                  className={cn(
                    "w-1 rounded-full",
                    hasError ? "bg-red-500" : "bg-primary"
                  )}
                />
              ))}
            </div>

            {/* Status text — takes remaining space */}
            <div className="flex-1 min-w-0">
              <p
                className={cn(
                  "font-headline font-black text-xs uppercase tracking-wider leading-tight",
                  hasError
                    ? "text-red-600"
                    : "text-primary"
                )}
              >
                {status}
              </p>
              <p className="text-[10px] text-on-surface/50 font-bold uppercase tracking-tight leading-tight mt-0.5">
                {hasError
                  ? "Tap to reset"
                  : "Say your order"}
              </p>
            </div>

            {/* Stop / Close button */}
            <button
              onClick={toggleAssistant}
              className={cn(
                "px-4 py-2 rounded-full text-xs font-black uppercase tracking-wider transition-all flex-shrink-0 whitespace-nowrap",
                hasError
                  ? "bg-red-500 text-white"
                  : "bg-primary text-on-primary"
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
