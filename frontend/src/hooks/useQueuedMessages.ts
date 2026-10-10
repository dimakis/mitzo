import { useState, useEffect, useRef, useCallback } from 'react';
import type { ImageAttachment } from '../types/chat';
import type { DraftSessionAssignment } from './useDraft';

const KEY_PREFIX = 'mitzo-queue-';
const QUEUE_CHANGED_EVENT = 'mitzo-queue-changed';

export interface QueuedMessage {
  /** Internal identity of one queue entry, independent of its text. */
  queueEntryId?: string;
  /** Submitted or refused input must never resume automatic queue drain. */
  requiresRetry?: boolean;
  text: string;
  images: ImageAttachment[];
  contextBlocks: string[];
}

/** Stored shape omits images — base64 data is too large for localStorage. */
interface StoredMessage {
  queueEntryId?: string;
  requiresRetry?: boolean;
  text: string;
  contextBlocks: string[];
}

// randomUUID requires a secure context; getRandomValues also works on remote HTTP.
function createQueueEntryId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function queueKey(sessionId: string | undefined): string {
  return `${KEY_PREFIX}${sessionId ?? 'new'}`;
}

function toStored(msgs: QueuedMessage[]): StoredMessage[] {
  return msgs.map(({ text, contextBlocks, requiresRetry, queueEntryId }) => ({
    text,
    contextBlocks,
    ...(requiresRetry ? { requiresRetry: true } : {}),
    ...(queueEntryId ? { queueEntryId } : {}),
  }));
}

function fromStored(msgs: StoredMessage[]): QueuedMessage[] {
  return msgs.map(({ text, contextBlocks, requiresRetry, queueEntryId }) => ({
    text,
    contextBlocks,
    images: [],
    ...(requiresRetry ? { requiresRetry: true } : {}),
    ...(typeof queueEntryId === 'string' ? { queueEntryId } : {}),
  }));
}

function loadQueue(sessionId: string | undefined): QueuedMessage[] {
  try {
    const raw = localStorage.getItem(queueKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? fromStored(parsed) : [];
  } catch {
    return [];
  }
}

function mergeLiveImages(stored: QueuedMessage[], live: QueuedMessage[]): QueuedMessage[] {
  const imagesById = new Map(live.map((entry) => [entry.queueEntryId, entry.images]));
  return stored.map((entry) => ({
    ...entry,
    images: entry.queueEntryId ? (imagesById.get(entry.queueEntryId) ?? []) : [],
  }));
}

function saveQueue(sessionId: string | undefined, queue: QueuedMessage[]): void {
  try {
    const key = queueKey(sessionId);
    if (queue.length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(toStored(queue)));
    }
  } catch {
    // localStorage full or unavailable — ignore
  }
}

/** Persists queued messages to localStorage per session. */
export function useQueuedMessages(
  sessionId: string | undefined,
  maxQueued: number = 5,
  // Legacy callers omit this; composers pass null until an exact assignment arrives.
  assignment?: DraftSessionAssignment | null,
): {
  queue: QueuedMessage[];
  enqueue: (msg: QueuedMessage) => boolean;
  dequeue: () => QueuedMessage | undefined;
  restoreRejected: (msg: QueuedMessage) => QueuedMessage;
  removeSubmitted: (msg: QueuedMessage) => void;
  remove: (index: number) => void;
  edit: (index: number) => QueuedMessage | undefined;
} {
  const [queue, setQueueRaw] = useState<QueuedMessage[]>(() => loadQueue(sessionId));
  const queueRef = useRef(queue);
  const sessionRef = useRef(sessionId);
  const submittedOwners = useRef(new Map<string, string | undefined>());
  const suppressOwnEvent = useRef(false);

  useEffect(() => {
    const changed = (event: Event) => {
      if (suppressOwnEvent.current) return;
      if ((event as CustomEvent<{ key: string }>).detail?.key !== queueKey(sessionRef.current))
        return;
      const restored = mergeLiveImages(loadQueue(sessionRef.current), queueRef.current);
      queueRef.current = restored;
      setQueueRaw(restored);
    };
    window.addEventListener(QUEUE_CHANGED_EVENT, changed);
    return () => window.removeEventListener(QUEUE_CHANGED_EVENT, changed);
  }, []);

  // Keep ref in sync with state
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  // Persist before transferring ownership, including a queue edit batched with navigation.
  useEffect(() => {
    saveQueue(sessionRef.current, queue);
  }, [queue]);

  // When sessionId changes, load queue for new session
  useEffect(() => {
    const prev = sessionRef.current;
    sessionRef.current = sessionId;
    if (prev === sessionId) return;

    saveQueue(prev, queueRef.current);
    if (assignment && assignment.fromSessionId === prev && assignment.toSessionId === sessionId) {
      // Keep submitted object identity (including images) for its eventual
      // receipt. Existing destination work must survive the transfer too.
      const destination = loadQueue(sessionId);
      for (const entry of queueRef.current)
        if (entry.queueEntryId && submittedOwners.current.has(entry.queueEntryId))
          submittedOwners.current.set(entry.queueEntryId, sessionId);
      const promoted = destination.length
        ? [...destination, ...queueRef.current]
        : queueRef.current;
      queueRef.current = promoted;
      setQueueRaw(promoted);
      saveQueue(sessionId, promoted);
      try {
        localStorage.removeItem(queueKey(prev));
      } catch {
        /* Optional storage. */
      }
      return;
    }
    if (prev !== undefined || sessionId === undefined || assignment !== undefined) {
      const restored = loadQueue(sessionId);
      queueRef.current = restored;
      setQueueRaw(restored);
      return;
    }

    // Migrate queue from 'new' key when session gets assigned an ID
    const oldKey = queueKey(prev);
    const newKey = queueKey(sessionId);
    try {
      const existing = localStorage.getItem(newKey);
      if (existing) {
        setQueueRaw(fromStored(JSON.parse(existing)));
      } else {
        const old = localStorage.getItem(oldKey);
        if (old) {
          localStorage.setItem(newKey, old);
          // Queue state stays the same — just moved the key
        }
      }
      localStorage.removeItem(oldKey);
    } catch {
      // ignore
    }
  }, [sessionId, assignment]);

  const enqueue = useCallback(
    (msg: QueuedMessage): boolean => {
      if (queueRef.current.length >= maxQueued) return false;
      const next = [...queueRef.current, { ...msg, queueEntryId: createQueueEntryId() }];
      queueRef.current = next;
      setQueueRaw(next);
      return true;
    },
    [maxQueued],
  );

  const dequeue = useCallback((): QueuedMessage | undefined => {
    const current = queueRef.current;
    if (current.length === 0 || current[0].requiresRetry) return undefined;
    const item = current[0];
    queueRef.current = current.slice(1);
    setQueueRaw(queueRef.current);
    return item;
  }, []);

  // Return already-submitted input without discarding it when the ordinary queue is full.
  const restoreRejected = useCallback((msg: QueuedMessage) => {
    const retained = { ...msg, requiresRetry: true, queueEntryId: createQueueEntryId() };
    submittedOwners.current.set(retained.queueEntryId, sessionRef.current);
    const next = [...queueRef.current.filter((item) => item !== msg), retained];
    queueRef.current = next;
    // The fence must exist before the caller dispatches its command, even if
    // the page disappears before React's persistence effect can commit.
    saveQueue(sessionRef.current, next);
    setQueueRaw(next);
    return retained;
  }, []);

  const removeSubmitted = useCallback((msg: QueuedMessage) => {
    const id = msg.queueEntryId;
    if (!id || !submittedOwners.current.has(id)) return;
    const owner = submittedOwners.current.get(id);
    const key = queueKey(owner);
    // A receipt may arrive after navigation or unmount. Reread the owner's
    // storage and remove only its exact entry; never write a captured queue back.
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
      if (!Array.isArray(parsed)) return;
      const remaining = parsed.filter((entry: StoredMessage) => entry.queueEntryId !== id);
      if (sessionRef.current === owner) {
        const restored = mergeLiveImages(fromStored(remaining), queueRef.current);
        queueRef.current = restored;
        setQueueRaw(restored);
      }
      if (remaining.length) localStorage.setItem(key, JSON.stringify(remaining));
      else localStorage.removeItem(key);
      submittedOwners.current.delete(id);
      suppressOwnEvent.current = true;
      try {
        window.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT, { detail: { key } }));
      } finally {
        suppressOwnEvent.current = false;
      }
    } catch {
      // Browser storage remains optional; remove only the exact active entry.
      if (sessionRef.current === owner) {
        queueRef.current = queueRef.current.filter((item) => item.queueEntryId !== id);
        setQueueRaw(queueRef.current);
      }
    }
  }, []);

  const remove = useCallback((index: number) => {
    const id = queueRef.current[index]?.queueEntryId;
    if (id) submittedOwners.current.delete(id);
    queueRef.current = queueRef.current.filter((_, i) => i !== index);
    setQueueRaw(queueRef.current);
  }, []);

  const edit = useCallback((index: number): QueuedMessage | undefined => {
    const item = queueRef.current[index];
    if (!item) return undefined;
    if (item.queueEntryId) submittedOwners.current.delete(item.queueEntryId);
    queueRef.current = queueRef.current.filter((_, i) => i !== index);
    setQueueRaw(queueRef.current);
    return item;
  }, []);

  return { queue, enqueue, dequeue, restoreRejected, removeSubmitted, remove, edit };
}
