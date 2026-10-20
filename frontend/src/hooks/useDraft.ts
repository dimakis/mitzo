import { preserveAcceptedLaunchText } from '../lib/launch-draft-delivery';
import {
  type Dispatch,
  type SetStateAction,
  useState,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import {
  chatDraftIdFromKey,
  getChatDraft,
  saveChatDraft,
  deleteChatDraft,
  isRetiredLegacyChatDraft,
  writeLegacyChatDraft,
} from '../lib/chat-drafts';

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

function readDraft(
  key: string,
  initialText?: string,
  scoped = false,
  observe?: (value: string | null) => void,
): string {
  try {
    const id = chatDraftIdFromKey(key);
    if (id) return getChatDraft(id)?.text ?? initialText ?? '';
    const value = localStorage.getItem(key);
    observe?.(value);
    if (!scoped && initialText) return initialText;
    if (key.startsWith(KEY_PREFIX) && isRetiredLegacyChatDraft(key.slice(KEY_PREFIX.length)))
      return '';
    return value ?? initialText ?? '';
  } catch {
    return initialText ?? '';
  }
}

function saveDraft(key: string, text: string, preserveEmpty = false, edited = true): boolean {
  try {
    const id = chatDraftIdFromKey(key);
    if (id) {
      if (!text && !preserveEmpty) return deleteChatDraft(id);
      else {
        const draft = getChatDraft(id);
        if (draft) return saveChatDraft({ ...draft, text });
      }
      return false;
    }
    if (key.startsWith(KEY_PREFIX))
      writeLegacyChatDraft(key.slice(KEY_PREFIX.length), text, preserveEmpty, edited);
    else if (text || preserveEmpty) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
    if (key.startsWith('mitzo-chat-draft-text:'))
      preserveAcceptedLaunchText(key.slice('mitzo-chat-draft-text:'.length), text);
    return true;
  } catch {
    // Browser draft storage is optional.
    return false;
  }
}

/** Persists draft prompt text to localStorage per session. */
export function useDraft(
  sessionId: string | undefined,
  initialText?: string,
  draftStorageKey?: string,
  // Legacy callers omit this; composers pass null until an exact assignment arrives.
  assignment?: DraftSessionAssignment | null,
): [
  string,
  Dispatch<SetStateAction<string>>,
  () => void,
  () => void,
  () => { sessionId: string; expectedLegacyText: string | null } | null,
] {
  const key = draftStorageKey ?? draftKey(sessionId);
  const scoped = draftStorageKey !== undefined;
  const observedLegacy = useRef<{ key: string; value: string | null }>({ key, value: null });
  const observe = (value: string | null) => {
    observedLegacy.current = { key, value };
  };
  const [text, setTextRaw] = useState(() => readDraft(key, initialText, scoped, observe));

  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const storageRef = useRef({ key, scoped });
  const textRef = useRef(text);
  textRef.current = text;
  const dirty = useRef(false);
  const mountedRef = useRef(false);
  const persistDraft = useCallback(
    (savedKey: string, value: string, preserveEmpty = false, edited = true) => {
      const saved = saveDraft(savedKey, value, preserveEmpty, edited);
      if (saved && savedKey.startsWith(KEY_PREFIX))
        observedLegacy.current = { key: savedKey, value: value || preserveEmpty ? value : null };
      return saved;
    },
    [],
  );

  // Only an ordinary assignment transfers ownership. Navigation
  // keeps the previous conversation's draft and loads the destination's own.
  useEffect(() => {
    const previous = storageRef.current;
    if (previous.key === key) return;
    clearTimeout(timerRef.current);
    if (dirty.current) persistDraft(previous.key, textRef.current, previous.scoped);
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
      const restored = readDraft(key, initialText, scoped, (value) => {
        observedLegacy.current = { key, value };
      });
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
      observedLegacy.current = { key: newKey, value: localStorage.getItem(newKey) };
    } catch {
      // localStorage unavailable — ignore
    }
  }, [key, scoped, initialText, sessionId, assignment, persistDraft]);

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
      persistDraft(savedKey, text, preserveEmpty);
      dirty.current = false;
    }, DEBOUNCE_MS);

    return () => clearTimeout(timerRef.current);
  }, [text, key, persistDraft]);

  useEffect(() => {
    const flushOnLeave = () => {
      clearTimeout(timerRef.current);
      if (dirty.current)
        persistDraft(storageRef.current.key, textRef.current, storageRef.current.scoped);
    };
    window.addEventListener('pagehide', flushOnLeave);
    return () => {
      window.removeEventListener('pagehide', flushOnLeave);
      flushOnLeave();
    };
  }, [persistDraft]);

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
    persistDraft(storageRef.current.key, '');
  }, [persistDraft]);

  const flushDraft = useCallback(() => {
    clearTimeout(timerRef.current);
    persistDraft(storageRef.current.key, textRef.current, storageRef.current.scoped, dirty.current);
    dirty.current = false;
  }, [persistDraft]);

  const prepareUpgrade = useCallback(() => {
    const current = storageRef.current;
    if (!sessionId || current.scoped || current.key !== draftKey(sessionId)) return null;
    try {
      if (
        observedLegacy.current.key !== current.key ||
        localStorage.getItem(current.key) !== observedLegacy.current.value
      )
        return null;
      clearTimeout(timerRef.current);
      if (dirty.current && !persistDraft(current.key, textRef.current)) return null;
      dirty.current = false;
      return { sessionId, expectedLegacyText: observedLegacy.current.value };
    } catch {
      return null;
    }
  }, [sessionId, persistDraft]);
  return [text, setText, clearDraft, flushDraft, prepareUpgrade];
}
