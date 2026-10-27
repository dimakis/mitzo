import { chatStorage } from '../lib/large-chat-storage';
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
  COMPOSER_DRAFT_ACCEPTED,
  recordAcceptedComposerDraft,
  composerDraftMemoryRevision,
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
  /** Optional-storage fallback: exact local memory only, never a durable receipt. */
  captureVolatile(): (() => boolean) | undefined;
  recordAcceptance(proof: ComposerDraftProof): boolean;
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
    const saved = JSON.parse(chatStorage.getItem(revisionKey(key)) ?? 'null');
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
    return chatStorage.getItem(key) ?? initialText ?? '';
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
    if (text || preserveEmpty) chatStorage.setItem(key, text);
    else chatStorage.removeItem(key);
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
  const localRevision = useRef(0);
  const durableTokenSeen = useRef(!!initialRevision.token);
  const volatileAssignedFrom = useRef<string | undefined>(undefined);
  const volatileAssignmentBaseline = useRef<
    | {
        draft: string | null | undefined;
        revision: string | null | undefined;
        memoryRevision: number;
      }
    | undefined
  >(undefined);
  const assignedFromKey = useRef<string | undefined>(undefined);
  const assignedProofOwners = useRef(new Map<string, { from: string; to: string }>());
  const mountedRef = useRef(false);

  // Only an ordinary assignment transfers ownership. Navigation
  // keeps the previous conversation's draft and loads the destination's own.
  // Commit that owner before a newly rendered composer can receive an edit.
  useLayoutEffect(() => {
    const previous = storageRef.current;
    if (previous.key === key) return;
    volatileAssignmentBaseline.current = undefined;
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
      localRevision.current++;
      volatileAssignedFrom.current = undefined;
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
    volatileAssignedFrom.current = oldKey;
    try {
      if (!allowComposerDraftPersistence(oldKey) || !allowComposerDraftPersistence(newKey)) {
        localRevision.current++;
        volatileAssignedFrom.current = undefined;
        // An unrelated destination remains usable; never copy edited bytes
        // beneath the old proof when its revocation is still unavailable.
        const restored = readDraft(newKey);
        textRef.current = restored;
        revisionRef.current = { key, token: readRevision(newKey, restored) };
        setTextRaw(restored);
        return;
      }
      const existing = chatStorage.getItem(newKey);
      if (existing) {
        localRevision.current++;
        volatileAssignedFrom.current = undefined;
        // New session already has a draft — use it
        textRef.current = existing;
        revisionRef.current = { key, token: readRevision(newKey, existing) };
        setTextRaw(existing);
      } else {
        // Migrate from old key
        const old = chatStorage.getItem(oldKey);
        if (old) {
          chatStorage.setItem(newKey, old);
          if (oldRevision.token && readRevision(oldKey, old) === oldRevision.token) {
            const raw = chatStorage.getItem(revisionKey(oldKey));
            if (raw && replaceComposerDraftRevision(newKey, raw)) {
              revisionRef.current = { ...oldRevision, key };
              assignedFromKey.current = oldKey;
              assignedProofOwners.current.set(oldRevision.token, { from: oldKey, to: newKey });
            }
          }
          // Don't change text state — it's the same draft, just moved
        }
      }
      chatStorage.removeItem(oldKey);
    } catch {
      // localStorage unavailable — ignore
    } finally {
      if (volatileAssignedFrom.current === oldKey) {
        let draft: string | null | undefined;
        let revision: string | null | undefined;
        try {
          draft = chatStorage.getItem(newKey);
          revision = chatStorage.getItem(revisionKey(newKey));
        } catch {
          // Unreadable assignment cannot weaken a readable original snapshot.
        }
        volatileAssignmentBaseline.current = {
          draft,
          revision,
          memoryRevision: composerDraftMemoryRevision(newKey),
        };
      }
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
    localRevision.current++;
    const owner = storageRef.current.key;
    const previous = revisionRef.current;
    if (previous.token) durableTokenSeen.current = true;
    let submittedToken: string | undefined;
    try {
      const durable = JSON.parse(chatStorage.getItem(revisionKey(owner)) ?? 'null');
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
    if (revisionRef.current.token) durableTokenSeen.current = true;
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
      chatStorage.removeItem(revisionKey(storageRef.current.key));
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
    if (revisionRef.current.token) durableTokenSeen.current = true;
    clearTimeout(timerRef.current);
    const owner = storageRef.current;
    if (!saveDraft(owner.key, textRef.current, owner.scoped)) return undefined;
    dirty.current = false;
    const token = writeRevision(owner.key, textRef.current, true);
    revisionRef.current = { key: owner.key, token, submittedToken: token };
    if (token) durableTokenSeen.current = true;
    return token ? { storageKey: owner.key, revisionToken: token } : undefined;
  }, []);
  const captureVolatile = useCallback(() => {
    const owner = storageRef.current.key;
    const revision = localRevision.current;
    const memoryRevision = composerDraftMemoryRevision(owner);
    let baseline: string | null | undefined;
    let draftBaseline: string | null | undefined;
    try {
      draftBaseline = chatStorage.getItem(owner);
      baseline = chatStorage.getItem(revisionKey(owner));
      // A failed replacement of existing durable authority cannot become
      // weaker in-memory authority. Successful revocation leaves no token.
      const token = JSON.parse(baseline ?? 'null')?.revisionToken;
      durableTokenSeen.current = !!token;
      if (token && (composerDraftRevocationPending(owner) || token !== revisionRef.current.token))
        return undefined;
    } catch {
      if (durableTokenSeen.current) return undefined;
    }
    return () => {
      const currentOwner = storageRef.current.key;
      if (
        (currentOwner !== owner && volatileAssignedFrom.current !== owner) ||
        localRevision.current !== revision ||
        // Assignment cannot erase a foreign edit to the submitted source.
        composerDraftMemoryRevision(owner) !== memoryRevision
      )
        return false;
      const assigned = currentOwner !== owner ? volatileAssignmentBaseline.current : undefined;
      if (
        currentOwner !== owner &&
        (!assigned ||
          (assigned.revision === undefined && baseline !== undefined) ||
          (assigned.draft === undefined && draftBaseline !== undefined))
      )
        return false;
      const expectedRevision = assigned ? assigned.revision : baseline;
      const expectedDraft = assigned ? assigned.draft : draftBaseline;
      if (
        composerDraftMemoryRevision(currentOwner) !==
        (assigned ? assigned.memoryRevision : memoryRevision)
      )
        return false;
      try {
        if (
          chatStorage.getItem(revisionKey(currentOwner)) !== expectedRevision ||
          chatStorage.getItem(currentOwner) !== expectedDraft
        )
          return false;
      } catch {
        if (expectedRevision !== undefined || expectedDraft !== undefined) return false;
      }
      // This authority belongs solely to this mount. Never delete durable
      // bytes or manufacture a receipt usable by another editor.
      clearTimeout(timerRef.current);
      dirty.current = false;
      textRef.current = '';
      setTextRaw('');
      localRevision.current++;
      return true;
    };
  }, []);
  const recordAcceptance = useCallback((proof: ComposerDraftProof) => {
    const assignment = assignedProofOwners.current.get(proof.revisionToken);
    if (assignment?.from === proof.storageKey)
      return recordAcceptedComposerDraft({ ...proof, storageKey: assignment.to });
    return recordAcceptedComposerDraft(proof);
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
          const marker = composerDraftProof(JSON.parse(chatStorage.getItem(markerKey) ?? 'null'));
          if (marker?.revisionToken === proof.revisionToken) chatStorage.removeItem(markerKey);
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
      const saved = JSON.parse(chatStorage.getItem(revisionKey(owner)) ?? 'null');
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
    const recover = () => {
      try {
        const marker = composerDraftProof(
          JSON.parse(chatStorage.getItem(acceptedComposerDraftKey(key)) ?? 'null'),
        );
        if (marker) consume(marker);
      } catch {
        // An unreadable local receipt does not authorize clearing a draft.
      }
    };
    recover();
    window.addEventListener(COMPOSER_DRAFT_ACCEPTED, recover);
    window.addEventListener('storage', recover);
    return () => {
      window.removeEventListener(COMPOSER_DRAFT_ACCEPTED, recover);
      window.removeEventListener('storage', recover);
    };
  }, [key, consume]);
  return [
    text,
    setText,
    clearDraft,
    flushDraft,
    { capture, captureVolatile, recordAcceptance, consume, ownsCurrent, revise, consumedRevision },
  ];
}
