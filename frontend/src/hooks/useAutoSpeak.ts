// Auto-speak: reads aloud the last completed assistant message via TTS.

import { useEffect, useRef } from 'react';
import { stripCodeForTts, truncateForTts } from '../lib/tts';
import type { FinishedMessage } from '../types/chat';

interface AutoSpeakOpts {
  messages: FinishedMessage[];
  running: boolean;
  ttsEnabled: boolean;
  ttsAvailable: boolean;
  speak: (text: string) => void;
}

export function useAutoSpeak({
  messages,
  running,
  ttsEnabled,
  ttsAvailable,
  speak,
}: AutoSpeakOpts) {
  const lastSpokenIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ttsEnabled || !ttsAvailable) return;
    // Wait until streaming is done so we speak the full message
    if (running) return;

    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant') return;
    if (lastMsg.messageId === lastSpokenIdRef.current) return;

    lastSpokenIdRef.current = lastMsg.messageId;

    const raw = lastMsg.blocks
      .filter((b) => b.blockType === 'text')
      .map((b) => b.content)
      .join('\n');

    const text = truncateForTts(stripCodeForTts(raw)).trim();
    if (text) speak(text);
  }, [messages, running, ttsEnabled, ttsAvailable, speak]);
}
