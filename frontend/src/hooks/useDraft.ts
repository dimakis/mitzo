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

/** Exact ordinary command assignment reported by the authenticated client store. */
export interface DraftSessionAssignment {
  fromSessionId: string | undefined;
  toSessionId: string;
}

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

function saveDraft(key: string, text: string, preserveEmpty = false): void {
  try {
    if (text || preserveEmpty) localStorage.setItem(key, text);
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
  // Legacy callers omit this; composers pass null until an exact assignment arrives.
  assignment?: DraftSessionAssignment | null,
): [string, Dispatch<SetStateAction<string>>, () => void, () => void] {
  const key = draftStorageKey ?? draftKey(sessionId);
  const scoped = draftStorageKey !== undefined;
  const [text, setTextRaw] = useState(() => readDraft(key, initialText, scoped));

  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const storageRef = useRef({ key, scoped });
  const textRef = useRef(text);
  textRef.current = text;
  const dirty = useRef(false);
  const mountedRef = useRef(false);

  // Only an ordinary assignment transfers ownership. Navigation
  // keeps the previous conversation's draft and loads the destination's own.
  useEffect(() => {
    const previous = storageRef.current;
    if (previous.key === key) return;
    clearTimeout(timerRef.current);
    if (dirty.current) saveDraft(previous.key, textRef.current, previous.scoped);
    dirty.current = false;
    // Preparation drafts belong to their own receipt. Never move ordinary or
    // another preparation's text across this ownership boundary.
    const assigningOrdinaryDraft =
      !previous.scoped &&
      !scoped &&
      sessionId !== undefined &&
      ((assignment === undefined && previous.key === draftKey(undefined)) ||
        (assignment?.toSessionId === sessionId &&
          previous.key === draftKey(assignment.fromSessionId)));
    if (!assigningOrdinaryDraft) {
      storageRef.current = { key, scoped };
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
  }, [key, scoped, initialText, sessionId, assignment]);

  // Debounced save to localStorage on text change (skip initial render)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    clearTimeout(timerRef.current);
    if (!dirty.current) return;
    const savedKey = storageRef.current.key;
    const preserveEmpty = storageRef.current.scoped;
    timerRef.current = setTimeout(() => {
      saveDraft(savedKey, text, preserveEmpty);
      dirty.current = false;
    }, DEBOUNCE_MS);

    return () => clearTimeout(timerRef.current);
  }, [text, key]);

  useEffect(
    () => () => {
      clearTimeout(timerRef.current);
      if (dirty.current)
        saveDraft(storageRef.current.key, textRef.current, storageRef.current.scoped);
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

  const flushDraft = useCallback(() => {
    clearTimeout(timerRef.current);
    saveDraft(storageRef.current.key, textRef.current, storageRef.current.scoped);
    dirty.current = false;
  }, []);

  return [text, setText, clearDraft, flushDraft];
}
