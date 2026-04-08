// Auto-speak: reads aloud each completed assistant message via TTS.

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

export function useAutoSpeak({ messages, ttsEnabled, ttsAvailable, speak }: AutoSpeakOpts) {
  const spokenIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!ttsEnabled || !ttsAvailable) return;

    // Prune IDs no longer present in messages
    const currentIds = new Set(messages.map((m) => m.messageId));
    for (const id of spokenIdsRef.current) {
      if (!currentIds.has(id)) spokenIdsRef.current.delete(id);
    }

    // Speak all unspoken assistant messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant') continue;
      if (spokenIdsRef.current.has(msg.messageId)) continue; // already spoken

      const raw = msg.blocks
        .filter((b) => b.blockType === 'text')
        .map((b) => b.content)
        .join('\n');

      const text = truncateForTts(stripCodeForTts(raw)).trim();
      if (text) {
        spokenIdsRef.current.add(msg.messageId);
        speak(text);
      }
    }
  }, [messages, ttsEnabled, ttsAvailable, speak]);
}
