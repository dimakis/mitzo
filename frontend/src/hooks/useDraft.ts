import {
  type Dispatch,
  type SetStateAction,
  useState,
  useEffect,
  useRef,
  useCallback,
} from 'react';

const KEY_PREFIX = 'mitzo-draft-';
const DEBOUNCE_MS = 400;

function draftKey(sessionId: string | undefined): string {
  return `${KEY_PREFIX}${sessionId ?? 'new'}`;
}

/**
 * Persists draft prompt text to localStorage per session.
 * Returns [text, setText, clearDraft].
 */
export function useDraft(
  sessionId: string | undefined,
  initialText?: string,
): [string, Dispatch<SetStateAction<string>>, () => void] {
  const [text, setTextRaw] = useState(() => {
    if (initialText) return initialText;
    try {
      return localStorage.getItem(draftKey(sessionId)) ?? '';
    } catch {
      return '';
    }
  });

  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sessionRef = useRef(sessionId);

  // When sessionId changes (e.g. new session gets assigned an ID),
  // migrate draft from old key and load any existing draft for new key.
  useEffect(() => {
    const prev = sessionRef.current;
    sessionRef.current = sessionId;
    if (prev === sessionId) return;

    // If we had a draft under the old key, migrate it
    const oldKey = draftKey(prev);
    const newKey = draftKey(sessionId);
    try {
      const existing = localStorage.getItem(newKey);
      if (existing) {
        // New session already has a draft — use it
        setTextRaw(existing);
      } else {
        // Migrate from old key
        const old = localStorage.getItem(oldKey);
        if (old) {
          localStorage.setItem(newKey, old);
          // Don't change text state — it's the same draft, just moved
        }
      }
      localStorage.removeItem(oldKey);
    } catch {
      // localStorage unavailable — ignore
    }
  }, [sessionId]);

  // Debounced save to localStorage on text change
  useEffect(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      try {
        const key = draftKey(sessionRef.current);
        if (text) {
          localStorage.setItem(key, text);
        } else {
          localStorage.removeItem(key);
        }
      } catch {
        // localStorage full or unavailable — ignore
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timerRef.current);
  }, [text]);

  const clearDraft = useCallback(() => {
    setTextRaw('');
    try {
      localStorage.removeItem(draftKey(sessionRef.current));
    } catch {
      // ignore
    }
  }, []);

  return [text, setTextRaw, clearDraft];
}
