import { useState, useEffect, useRef, useCallback } from 'react';
import type { ImageAttachment } from '../types/chat';
import type { DraftSessionAssignment } from './useDraft';
import { createBrowserId } from '../lib/browser-crypto';

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

function legacyKey(entry: StoredMessage): string {
  return JSON.stringify([entry.text, entry.contextBlocks, entry.requiresRetry === true]);
}

function legacyCounts(entries: StoredMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.queueEntryId) continue;
    const key = legacyKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function saveQueue(sessionId: string | undefined, queue: QueuedMessage[]): boolean {
  try {
    const key = queueKey(sessionId);
    if (queue.length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(toStored(queue)));
    }
    return true;
  } catch {
    return false;
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
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A readable snapshot is not authoritative for edits whose writes failed.
  const storedQueues = useRef(new Map([[queueKey(sessionId), toStored(queue)]]));
  const dirtyQueues = useRef(new Set<string>());
  const persistQueue = useCallback((owner: string | undefined, next: QueuedMessage[]) => {
    const key = queueKey(owner);
    if (saveQueue(owner, next)) {
      storedQueues.current.set(key, toStored(next));
      dirtyQueues.current.delete(key);
      return true;
    }
    dirtyQueues.current.add(key);
    return false;
  }, []);
  const reconcileStored = useCallback((owner: string | undefined, stored: QueuedMessage[]) => {
    const key = queueKey(owner);
    const live = queueRef.current;
    const baseline = storedQueues.current.get(key) ?? [];
    const baselineIds = new Set(baseline.map((entry) => entry.queueEntryId));
    // Observed entries stay storage-owned even if the subsequent optional save fails.
    storedQueues.current.set(key, toStored(stored));
    if (!dirtyQueues.current.has(key)) return mergeLiveImages(stored, live);
    const liveIds = new Set(live.map((entry) => entry.queueEntryId));
    const removedIds = new Set([...baselineIds].filter((id) => id && !liveIds.has(id)));
    // Older stored rows have no IDs. Preserve their multiplicity while applying
    // only the local removal delta; receipt matching still uses its modern ID.
    const removedLegacy = legacyCounts(baseline);
    const liveLegacy = legacyCounts(toStored(live));
    const storedLegacy = legacyCounts(toStored(stored));
    for (const [key, count] of removedLegacy) {
      const liveCount = liveLegacy.get(key) ?? 0;
      // A newer writer may already have applied the removal. Never subtract it twice.
      removedLegacy.set(
        key,
        Math.max(0, Math.min(count - liveCount, (storedLegacy.get(key) ?? 0) - liveCount)),
      );
    }
    const reconciled = mergeLiveImages(
      stored.filter((entry) => {
        if (entry.queueEntryId) return !removedIds.has(entry.queueEntryId);
        const key = legacyKey(entry);
        const removed = removedLegacy.get(key) ?? 0;
        if (!removed) return true;
        removedLegacy.set(key, removed - 1);
        return false;
      }),
      live,
    );
    for (const entry of live) {
      if (!entry.queueEntryId || baselineIds.has(entry.queueEntryId)) continue;
      const index = reconciled.findIndex((item) => item.queueEntryId === entry.queueEntryId);
      if (index < 0) reconciled.push(entry);
      else reconciled[index] = entry;
    }
    return reconciled;
  }, []);

  useEffect(() => {
    const changed = (event: Event) => {
      if (suppressOwnEvent.current) return;
      if ((event as CustomEvent<{ key: string }>).detail?.key !== queueKey(sessionRef.current))
        return;
      const restored = reconcileStored(sessionRef.current, loadQueue(sessionRef.current));
      queueRef.current = restored;
      setQueueRaw(restored);
    };
    window.addEventListener(QUEUE_CHANGED_EVENT, changed);
    return () => window.removeEventListener(QUEUE_CHANGED_EVENT, changed);
  }, [reconcileStored]);

  // Keep ref in sync with state
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  // Persist before transferring ownership, including a queue edit batched with navigation.
  useEffect(() => {
    persistQueue(sessionRef.current, queue);
  }, [queue, persistQueue]);

  // When sessionId changes, load queue for new session
  useEffect(() => {
    const prev = sessionRef.current;
    sessionRef.current = sessionId;
    if (prev === sessionId) return;

    persistQueue(prev, queueRef.current);
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
      persistQueue(sessionId, promoted);
      try {
        localStorage.removeItem(queueKey(prev));
      } catch {
        /* Optional storage. */
      }
      return;
    }
    if (prev !== undefined || sessionId === undefined || assignment !== undefined) {
      const restored = loadQueue(sessionId);
      storedQueues.current.set(queueKey(sessionId), toStored(restored));
      dirtyQueues.current.delete(queueKey(sessionId));
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
          if (!persistQueue(sessionId, fromStored(JSON.parse(old)))) return;
          // Queue state stays the same — just moved the key
        }
      }
      localStorage.removeItem(oldKey);
    } catch {
      // ignore
    }
  }, [sessionId, assignment, persistQueue]);

  const enqueue = useCallback(
    (msg: QueuedMessage): boolean => {
      if (queueRef.current.length >= maxQueued) return false;
      const next = [...queueRef.current, { ...msg, queueEntryId: createBrowserId() }];
      queueRef.current = next;
      persistQueue(sessionRef.current, next);
      setQueueRaw(next);
      return true;
    },
    [maxQueued, persistQueue],
  );

  const dequeue = useCallback((): QueuedMessage | undefined => {
    const current = queueRef.current;
    if (current.length === 0 || current[0].requiresRetry) return undefined;
    const item = current[0];
    queueRef.current = current.slice(1);
    persistQueue(sessionRef.current, queueRef.current);
    setQueueRaw(queueRef.current);
    return item;
  }, [persistQueue]);

  // Return already-submitted input without discarding it when the ordinary queue is full.
  const restoreRejected = useCallback(
    (msg: QueuedMessage) => {
      const retained = { ...msg, requiresRetry: true, queueEntryId: createBrowserId() };
      submittedOwners.current.set(retained.queueEntryId, sessionRef.current);
      const next = [...queueRef.current.filter((item) => item !== msg), retained];
      queueRef.current = next;
      // The fence must exist before the caller dispatches its command, even if
      // the page disappears before React's persistence effect can commit.
      persistQueue(sessionRef.current, next);
      setQueueRaw(next);
      return retained;
    },
    [persistQueue],
  );

  const removeSubmitted = useCallback(
    (msg: QueuedMessage) => {
      const id = msg.queueEntryId;
      if (!id || !submittedOwners.current.has(id)) return;
      const owner = submittedOwners.current.get(id);
      const key = queueKey(owner);
      // A receipt may arrive after navigation or unmount. Reread the owner's
      // storage and remove only its exact entry; never write a captured queue back.
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
        if (!Array.isArray(parsed)) return;
        let remaining = parsed.filter((entry: StoredMessage) => entry.queueEntryId !== id);
        if (mounted.current && sessionRef.current === owner) {
          const restored = reconcileStored(owner, fromStored(parsed)).filter(
            (entry) => entry.queueEntryId !== id,
          );
          remaining = toStored(restored);
          queueRef.current = restored;
          setQueueRaw(restored);
        }
        const persisted = persistQueue(owner, fromStored(remaining));
        submittedOwners.current.delete(id);
        // A key-only notification requires a successfully updated snapshot.
        if (!persisted) return;
        suppressOwnEvent.current = true;
        try {
          window.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT, { detail: { key } }));
        } finally {
          suppressOwnEvent.current = false;
        }
      } catch {
        // Browser storage remains optional; remove only the exact active entry.
        if (mounted.current && sessionRef.current === owner) {
          queueRef.current = queueRef.current.filter((item) => item.queueEntryId !== id);
          setQueueRaw(queueRef.current);
        }
      }
    },
    [persistQueue, reconcileStored],
  );

  const remove = useCallback(
    (index: number) => {
      const id = queueRef.current[index]?.queueEntryId;
      if (id) submittedOwners.current.delete(id);
      queueRef.current = queueRef.current.filter((_, i) => i !== index);
      persistQueue(sessionRef.current, queueRef.current);
      setQueueRaw(queueRef.current);
    },
    [persistQueue],
  );

  const edit = useCallback(
    (index: number): QueuedMessage | undefined => {
      const item = queueRef.current[index];
      if (!item) return undefined;
      if (item.queueEntryId) submittedOwners.current.delete(item.queueEntryId);
      queueRef.current = queueRef.current.filter((_, i) => i !== index);
      persistQueue(sessionRef.current, queueRef.current);
      setQueueRaw(queueRef.current);
      return item;
    },
    [persistQueue],
  );

  return { queue, enqueue, dequeue, restoreRejected, removeSubmitted, remove, edit };
}
