import { useCallback, useEffect, useRef, useState } from 'react';
import { YAPPER_URL, YAPPER_HEALTH_POLL_MS, DEFAULT_TTS_VOICE } from '../lib/constants';
import { synthesizeDocument, playAudio, unlockAudioContext } from '../lib/tts';

export type ReaderState = 'idle' | 'loading' | 'playing';

export interface DocumentReader {
  available: boolean;
  state: ReaderState;
  read: (content: string) => void;
  stop: () => void;
}

/**
 * Lightweight hook for document read-aloud in the file viewer.
 * Checks Yapper TTS availability and manages document playback lifecycle.
 */
export function useDocumentReader(): DocumentReader {
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<ReaderState>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const playRef = useRef<{ stop: () => void } | null>(null);

  // Health poll — reuses same pattern as useVoice
  useEffect(() => {
    let mounted = true;
    async function check() {
      try {
        const res = await fetch(`${YAPPER_URL}/health`);
        if (!res.ok) {
          if (mounted) setAvailable(false);
          return;
        }
        const data = await res.json();
        const ready = data.status === 'ready' || data.status === 'ok';
        const tts = data.models ? data.models.tts === true : ready;
        if (mounted) setAvailable(ready && tts);
      } catch {
        if (mounted) setAvailable(false);
      }
    }
    check();
    const timer = setInterval(check, YAPPER_HEALTH_POLL_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    playRef.current?.stop();
    playRef.current = null;
    setState('idle');
  }, []);

  const read = useCallback(
    (content: string) => {
      // Stop any in-progress playback
      stop();

      const abort = new AbortController();
      abortRef.current = abort;
      setState('loading');

      (async () => {
        try {
          await unlockAudioContext();
          const blob = await synthesizeDocument(content, DEFAULT_TTS_VOICE, YAPPER_URL, abort.signal);
          if (abort.signal.aborted) return;

          const handle = playAudio(blob);
          playRef.current = handle;
          setState('playing');
          await handle.play();
          // Playback finished naturally
          if (!abort.signal.aborted) {
            setState('idle');
            playRef.current = null;
          }
        } catch (err) {
          if (!abort.signal.aborted) {
            setState('idle');
          }
        }
      })();
    },
    [stop],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      playRef.current?.stop();
    };
  }, []);

  return { available, state, read, stop };
}
