import React, { useEffect, useRef, useState } from 'react';
import { LiveAPIConnection } from '../lib/live-api';
import { Mic, MicOff, Volume2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface VoiceAssistantProps {
  isActive: boolean;
  onToggle: () => void;
}

export const VoiceAssistant: React.FC<VoiceAssistantProps> = ({ isActive, onToggle }) => {
  const [isConnecting, setIsConnecting] = useState(false);
  const [transcript, setTranscript] = useState('');
  const connectionRef = useRef<LiveAPIConnection | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (isActive) {
      startSession();
    } else {
      stopSession();
    }
    return () => stopSession();
  }, [isActive]);

  const startSession = async () => {
    setIsConnecting(true);
    try {
      connectionRef.current = new LiveAPIConnection();
      await connectionRef.current.connect({
        systemInstruction: "You are the voice of Scott's Kitchen. You are helpful, energetic, and professional. You help users browse the menu, customize orders, and checkout. Keep responses concise for voice interaction.",
        onMessage: (message) => {
          if (message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data) {
            playAudio(message.serverContent.modelTurn.parts[0].inlineData.data);
          }
          if (message.serverContent?.modelTurn?.parts?.[0]?.text) {
            setTranscript(message.serverContent.modelTurn.parts[0].text);
          }
        },
        onError: (err) => {
          console.error("Live API Error:", err);
          onToggle();
        }
      });

      // Start microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      const source = audioContextRef.current.createMediaStreamSource(stream);
      processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);

      processorRef.current.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
        }
        const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
        connectionRef.current?.sendAudio(base64Data);
      };

      source.connect(processorRef.current);
      processorRef.current.connect(audioContextRef.current.destination);
      
      setIsConnecting(false);
    } catch (err) {
      console.error("Failed to start voice session:", err);
      setIsConnecting(false);
      onToggle();
    }
  };

  const stopSession = () => {
    connectionRef.current?.disconnect();
    connectionRef.current = null;
    
    processorRef.current?.disconnect();
    processorRef.current = null;
    
    audioContextRef.current?.close();
    audioContextRef.current = null;
    
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    
    setTranscript('');
  };

  const playAudio = async (base64Data: string) => {
    if (!audioContextRef.current) return;
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const pcm = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 0x7FFF;

    const buffer = audioContextRef.current.createBuffer(1, float32.length, 16000);
    buffer.getChannelData(0).set(float32);
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContextRef.current.destination);
    source.start();
  };

  return (
    <AnimatePresence>
      {isActive && (
        <motion.div 
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          className="fixed bottom-24 left-4 right-4 z-50 glass-panel p-6 rounded-xl shadow-2xl border border-primary/10"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="voice-pulse relative">
                <div className="w-3 h-3 bg-tertiary rounded-full" />
              </div>
              <span className="font-headline font-bold text-sm uppercase tracking-widest text-primary">
                {isConnecting ? 'Connecting...' : 'Listening...'}
              </span>
            </div>
            <button 
              onClick={onToggle}
              className="bg-primary text-on-primary px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-widest hover:brightness-110 transition-all"
            >
              Stop
            </button>
          </div>
          
          <div className="min-h-[40px]">
            <p className="text-on-surface/80 italic font-medium">
              {transcript || "How can I help you today?"}
            </p>
          </div>
          
          <div className="mt-4 flex justify-center gap-1">
            {[...Array(5)].map((_, i) => (
              <motion.div
                key={i}
                animate={{ height: [10, 30, 10] }}
                transition={{ duration: 0.5, repeat: Infinity, delay: i * 0.1 }}
                className="w-1 bg-primary rounded-full"
              />
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
