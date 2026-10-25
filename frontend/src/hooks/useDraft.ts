import { preserveAcceptedLaunchText } from '../lib/launch-draft-delivery';
import { createBrowserId, sha256Hex } from '../lib/browser-crypto';
import {
  acceptedComposerDraftKey,
  allowComposerDraftPersistence,
  composerDraftRevisionKey,
  composerDraftRevocationPending,
  replaceComposerDraftRevision,
  composerDraftProof,
  type ComposerDraftProof,
} from '../lib/composer-draft-proof';
import {
  type Dispatch,
  type SetStateAction,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
} from 'react';
import {
  chatDraftIdFromKey,
  getChatDraft,
  saveChatDraft,
  deleteChatDraft,
} from '../lib/chat-drafts';

const KEY_PREFIX = 'mitzo-draft-';
const DEBOUNCE_MS = 400;
interface DraftReceiptControl {
  capture(): ComposerDraftProof | undefined;
  consume(proof: ComposerDraftProof): boolean;
  ownsCurrent(proof: ComposerDraftProof): boolean;
  revise(): void;
  consumedRevision?: string;
}
interface DraftRevision {
  key: string;
  token?: string;
  submittedToken?: string;
}
const revisionKey = composerDraftRevisionKey;
function richDraftSignature(key: string): string {
  const id = chatDraftIdFromKey(key);
  const draft = id ? getChatDraft(id) : null;
  return draft
    ? sha256Hex(
        JSON.stringify({
          images: draft.images,
          contextBlocks: draft.contextBlocks,
          settings: draft.settings,
        }),
      )
    : '';
}
function readRevision(key: string, text: string): string | undefined {
  try {
    if (composerDraftRevocationPending(key)) return undefined;
    const saved = JSON.parse(localStorage.getItem(revisionKey(key)) ?? 'null');
    return saved?.textSha256 === sha256Hex(text) &&
      readDraft(key, undefined, true) === text &&
      saved.richDraftSignature === richDraftSignature(key) &&
      typeof saved.revisionToken === 'string'
      ? saved.revisionToken
      : undefined;
  } catch {
    return undefined;
  }
}
function writeRevision(key: string, text: string, bindRichDraft = false): string | undefined {
  try {
    const revisionToken = createBrowserId();
    const saved = replaceComposerDraftRevision(
      key,
      JSON.stringify({
        textSha256: sha256Hex(text),
        revisionToken,
        // Only submission needs a complete persisted rich-draft fingerprint.
        // Edits rotate the token without repeatedly hashing image attachments.
        ...(bindRichDraft ? { richDraftSignature: richDraftSignature(key) } : {}),
      }),
    );
    return saved ? revisionToken : undefined;
  } catch {
    return undefined;
  }
}

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
    const id = chatDraftIdFromKey(key);
    if (id) return getChatDraft(id)?.text ?? initialText ?? '';
    return localStorage.getItem(key) ?? initialText ?? '';
  } catch {
    return initialText ?? '';
  }
}

function saveDraft(key: string, text: string, preserveEmpty = false): boolean {
  try {
    if (!allowComposerDraftPersistence(key)) return false;
    const id = chatDraftIdFromKey(key);
    if (id) {
      if (!text && !preserveEmpty) return deleteChatDraft(id);
      else {
        const draft = getChatDraft(id);
        if (draft) return saveChatDraft({ ...draft, text });
      }
      return false;
    }
    if (text || preserveEmpty) localStorage.setItem(key, text);
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
): [string, Dispatch<SetStateAction<string>>, () => void, () => boolean, DraftReceiptControl] {
  const key = draftStorageKey ?? draftKey(sessionId);
  const scoped = draftStorageKey !== undefined;
  const [text, setTextRaw] = useState(() => readDraft(key, initialText, scoped));
  const [consumedRevision, setConsumedRevision] = useState<string>();

  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const storageRef = useRef({ key, scoped });
  const textRef = useRef(text);
  textRef.current = text;
  const dirty = useRef(false);
  const [initialRevision] = useState(() => {
    const token = readRevision(key, text);
    return { key, token, submittedToken: token };
  });
  const revisionRef = useRef<DraftRevision>(initialRevision);
  const assignedFromKey = useRef<string | undefined>(undefined);
  const mountedRef = useRef(false);

  // Only an ordinary assignment transfers ownership. Navigation
  // keeps the previous conversation's draft and loads the destination's own.
  // Commit that owner before a newly rendered composer can receive an edit.
  useLayoutEffect(() => {
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
      assignedFromKey.current = undefined;
      storageRef.current = { key, scoped };
      const restored = readDraft(key, initialText, scoped);
      textRef.current = restored;
      revisionRef.current = { key, token: readRevision(key, restored) };
      setTextRaw(restored);
      return;
    }
    storageRef.current = { key, scoped };
    const oldRevision = revisionRef.current;
    assignedFromKey.current = undefined;
    revisionRef.current = { key, token: undefined };

    // If we had a draft under the old key, migrate it
    const oldKey = previous.key;
    const newKey = key;
    try {
      if (!allowComposerDraftPersistence(oldKey) || !allowComposerDraftPersistence(newKey)) {
        // An unrelated destination remains usable; never copy edited bytes
        // beneath the old proof when its revocation is still unavailable.
        const restored = readDraft(newKey);
        textRef.current = restored;
        revisionRef.current = { key, token: readRevision(newKey, restored) };
        setTextRaw(restored);
        return;
      }
      const existing = localStorage.getItem(newKey);
      if (existing) {
        // New session already has a draft — use it
        textRef.current = existing;
        revisionRef.current = { key, token: readRevision(newKey, existing) };
        setTextRaw(existing);
      } else {
        // Migrate from old key
        const old = localStorage.getItem(oldKey);
        if (old) {
          localStorage.setItem(newKey, old);
          if (oldRevision.token && readRevision(oldKey, old) === oldRevision.token) {
            const raw = localStorage.getItem(revisionKey(oldKey));
            if (raw && replaceComposerDraftRevision(newKey, raw)) {
              revisionRef.current = { ...oldRevision, key };
              assignedFromKey.current = oldKey;
            }
          }
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
      if (saveDraft(savedKey, text, preserveEmpty)) dirty.current = false;
    }, DEBOUNCE_MS);

    return () => clearTimeout(timerRef.current);
  }, [text, key]);

  useEffect(() => {
    const flushOnLeave = () => {
      clearTimeout(timerRef.current);
      if (dirty.current)
        saveDraft(storageRef.current.key, textRef.current, storageRef.current.scoped);
    };
    window.addEventListener('pagehide', flushOnLeave);
    return () => {
      window.removeEventListener('pagehide', flushOnLeave);
      flushOnLeave();
    };
  }, []);

  const rotateRevision = useCallback((next: string) => {
    const owner = storageRef.current.key;
    const previous = revisionRef.current;
    let submittedToken: string | undefined;
    try {
      const durable = JSON.parse(localStorage.getItem(revisionKey(owner)) ?? 'null');
      // Only local transitions retain a submitted revision's text authority.
      // Replacing another editor's token cannot reacquire an older receipt.
      if (
        previous.key === owner &&
        previous.token &&
        durable?.revisionToken === previous.token &&
        !composerDraftRevocationPending(owner)
      )
        submittedToken = previous.submittedToken;
    } catch {
      // Unreadable ancestry cannot authorize a partial receipt cleanup.
    }
    revisionRef.current = { key: owner, token: writeRevision(owner, next), submittedToken };
  }, []);

  const setText = useCallback<Dispatch<SetStateAction<string>>>(
    (update) => {
      const next = typeof update === 'function' ? update(textRef.current) : update;
      textRef.current = next;
      dirty.current = true;
      // Rotate even for a same-valued edit; content equality cannot prove that
      // a reloaded composer is still the revision submitted by an older command.
      rotateRevision(next);
      setTextRaw(next);
    },
    [rotateRevision],
  );

  const clearDraft = useCallback(() => {
    const saved = saveDraft(storageRef.current.key, '');
    if (!saved) return false;
    clearTimeout(timerRef.current);
    dirty.current = false;
    textRef.current = '';
    setTextRaw('');
    revisionRef.current = { key: storageRef.current.key, token: undefined };
    try {
      localStorage.removeItem(revisionKey(storageRef.current.key));
    } catch {
      // Missing durable proof always preserves text on a later receipt.
    }
    return saved;
  }, []);

  const flushDraft = useCallback(() => {
    clearTimeout(timerRef.current);
    const saved = saveDraft(storageRef.current.key, textRef.current, storageRef.current.scoped);
    if (saved) dirty.current = false;
    return saved;
  }, []);

  const revise = useCallback(() => {
    rotateRevision(textRef.current);
  }, [rotateRevision]);
  const capture = useCallback(() => {
    clearTimeout(timerRef.current);
    const owner = storageRef.current;
    if (!saveDraft(owner.key, textRef.current, owner.scoped)) return undefined;
    dirty.current = false;
    const token = writeRevision(owner.key, textRef.current, true);
    revisionRef.current = { key: owner.key, token, submittedToken: token };
    return token ? { storageKey: owner.key, revisionToken: token } : undefined;
  }, []);
  const consume = useCallback(
    (proof: ComposerDraftProof) => {
      const owner = storageRef.current.key;
      if (
        (proof.storageKey !== owner && proof.storageKey !== assignedFromKey.current) ||
        revisionRef.current.key !== owner ||
        revisionRef.current.token !== proof.revisionToken ||
        readRevision(owner, textRef.current) !== proof.revisionToken
      )
        return false;
      const saved = clearDraft();
      if (!saved) return false;
      setConsumedRevision(proof.revisionToken);
      if (saved) {
        try {
          const markerKey = acceptedComposerDraftKey(owner);
          const marker = composerDraftProof(JSON.parse(localStorage.getItem(markerKey) ?? 'null'));
          if (marker?.revisionToken === proof.revisionToken) localStorage.removeItem(markerKey);
        } catch {
          // A retained marker cannot consume another revision.
        }
      }
      return true;
    },
    [clearDraft],
  );
  const ownsCurrent = useCallback((proof: ComposerDraftProof) => {
    const owner = storageRef.current.key;
    if (
      (proof.storageKey !== owner && proof.storageKey !== assignedFromKey.current) ||
      revisionRef.current.key !== owner ||
      !revisionRef.current.token ||
      revisionRef.current.submittedToken !== proof.revisionToken ||
      composerDraftRevocationPending(owner)
    )
      return false;
    try {
      const saved = JSON.parse(localStorage.getItem(revisionKey(owner)) ?? 'null');
      return (
        saved?.revisionToken === revisionRef.current.token &&
        saved.textSha256 === sha256Hex(textRef.current) &&
        readDraft(owner, undefined, true) === textRef.current
      );
    } catch {
      return false;
    }
  }, []);
  useLayoutEffect(() => {
    try {
      const marker = composerDraftProof(
        JSON.parse(localStorage.getItem(acceptedComposerDraftKey(key)) ?? 'null'),
      );
      if (marker) consume(marker);
    } catch {
      // An unreadable local receipt does not authorize clearing a draft.
    }
  }, [key, consume]);
  return [
    text,
    setText,
    clearDraft,
    flushDraft,
    { capture, consume, ownsCurrent, revise, consumedRevision },
  ];
}
