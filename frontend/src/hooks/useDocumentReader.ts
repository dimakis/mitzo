import { useCallback, useEffect, useRef, useState } from 'react';
import { YAPPER_URL, DEFAULT_TTS_VOICE, DOCUMENT_READ_MAX_CHARS } from '../lib/constants';
import { synthesizeDocument, playAudio, unlockAudioContext } from '../lib/tts';
import { useServiceHealth } from './useServiceHealth';

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
  const { yapper } = useServiceHealth();
  const available = yapper?.ok === true && yapper.detail?.tts !== false;
  const [state, setState] = useState<ReaderState>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const playRef = useRef<{ stop: () => void } | null>(null);

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
          const trimmed =
            content.length > DOCUMENT_READ_MAX_CHARS
              ? content.slice(0, DOCUMENT_READ_MAX_CHARS)
              : content;
          const blob = await synthesizeDocument(
            trimmed,
            DEFAULT_TTS_VOICE,
            YAPPER_URL,
            abort.signal,
          );
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
          console.warn('Document read-aloud failed:', err);
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
