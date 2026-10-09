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

function readDraft(key: string, initialText?: string, scoped = false): string {
  if (!scoped && initialText) return initialText;
  try {
    return localStorage.getItem(key) ?? initialText ?? '';
  } catch {
    return initialText ?? '';
  }
}

function saveDraft(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    // Browser draft storage is optional.
  }
}

/** Persists draft prompt text to localStorage per session. */
export function useDraft(
  sessionId: string | undefined,
  initialText?: string,
  draftStorageKey?: string,
): [string, Dispatch<SetStateAction<string>>, () => void] {
  const key = draftStorageKey ?? draftKey(sessionId);
  const scoped = draftStorageKey !== undefined;
  const [text, setTextRaw] = useState(() => readDraft(key, initialText, scoped));

  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const storageRef = useRef({ key, scoped });
  const textRef = useRef(text);
  textRef.current = text;
  const dirty = useRef(false);
  const mountedRef = useRef(false);

  // When sessionId changes (e.g. new session gets assigned an ID),
  // migrate draft from old key and load any existing draft for new key.
  useEffect(() => {
    const previous = storageRef.current;
    if (previous.key === key) return;
    clearTimeout(timerRef.current);
    // Preparation drafts belong to their own receipt. Never move ordinary or
    // another preparation's text across this ownership boundary.
    if (previous.scoped || scoped) {
      if (previous.scoped && dirty.current) saveDraft(previous.key, textRef.current);
      storageRef.current = { key, scoped };
      dirty.current = false;
      const restored = readDraft(key, initialText, scoped);
      textRef.current = restored;
      setTextRaw(restored);
      return;
    }
    storageRef.current = { key, scoped };

    // If we had a draft under the old key, migrate it
    const oldKey = previous.key;
    const newKey = key;
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
  }, [key, scoped, initialText]);

  // Debounced save to localStorage on text change (skip initial render)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    clearTimeout(timerRef.current);
    if (!dirty.current) return;
    const savedKey = storageRef.current.key;
    timerRef.current = setTimeout(() => {
      saveDraft(savedKey, text);
      dirty.current = false;
    }, DEBOUNCE_MS);

    return () => clearTimeout(timerRef.current);
  }, [text, key]);

  useEffect(
    () => () => {
      clearTimeout(timerRef.current);
      if (storageRef.current.scoped && dirty.current)
        saveDraft(storageRef.current.key, textRef.current);
    },
    [],
  );

  const setText = useCallback<Dispatch<SetStateAction<string>>>((update) => {
    setTextRaw((previous) => {
      const next = typeof update === 'function' ? update(previous) : update;
      textRef.current = next;
      dirty.current = true;
      return next;
    });
  }, []);

  const clearDraft = useCallback(() => {
    clearTimeout(timerRef.current);
    dirty.current = false;
    textRef.current = '';
    setTextRaw('');
    saveDraft(storageRef.current.key, '');
  }, []);

  return [text, setText, clearDraft];
}
