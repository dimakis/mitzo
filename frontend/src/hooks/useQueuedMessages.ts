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

function readQueue(sessionId: string | undefined): QueuedMessage[] {
  const raw = localStorage.getItem(queueKey(sessionId));
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw Error('Queue storage is unavailable.');
  return fromStored(parsed);
}

function loadQueue(sessionId: string | undefined): QueuedMessage[] {
  try {
    return readQueue(sessionId);
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

function indexedEntries(entries: QueuedMessage[]): Array<[string, QueuedMessage]> {
  const occurrences = new Map<string, number>();
  return entries.map((entry) => {
    if (entry.queueEntryId) return [`id:${entry.queueEntryId}`, entry];
    const serialized = JSON.stringify(toStored([entry])[0]);
    const occurrence = occurrences.get(serialized) ?? 0;
    occurrences.set(serialized, occurrence + 1);
    return [`legacy:${serialized}:${occurrence}`, entry];
  });
}

function sameStoredQueue(a: QueuedMessage[], b: QueuedMessage[]): boolean {
  return JSON.stringify(toStored(a)) === JSON.stringify(toStored(b));
}

function sameQueue(a: QueuedMessage[], b: QueuedMessage[]): boolean {
  return (
    sameStoredQueue(a, b) &&
    a.every(
      (entry, index) =>
        entry.images === b[index]?.images ||
        (entry.images.length === 0 && b[index]?.images.length === 0),
    )
  );
}

/** Apply only known unsaved local changes; fresh external edits/deletions still win. */
function reconcileQueue(
  stored: QueuedMessage[],
  live: QueuedMessage[],
  baseline: QueuedMessage[],
): QueuedMessage[] {
  const prior = new Map(indexedEntries(baseline));
  const local = new Map(indexedEntries(live));
  const indexedStored = indexedEntries(stored);
  const storedIds = new Set(indexedStored.map(([id]) => id));
  const reconciled = indexedStored.flatMap(([id, entry]) => {
    const previous = prior.get(id);
    if (previous && JSON.stringify(toStored([previous])) === JSON.stringify(toStored([entry]))) {
      const current = local.get(id);
      return current ? [current] : [];
    }
    return [entry];
  });
  for (const [id, entry] of local) if (!prior.has(id) && !storedIds.has(id)) reconciled.push(entry);
  const restored = mergeLiveImages(reconciled, live);
  return sameQueue(restored, live) ? live : restored;
}

function saveQueue(sessionId: string | undefined, queue: QueuedMessage[]): boolean {
  try {
    const key = queueKey(sessionId);
    if (queue.length === 0) {
      localStorage.removeItem(key);
      return localStorage.getItem(key) === null;
    }
    const serialized = JSON.stringify(toStored(queue));
    localStorage.setItem(key, serialized);
    return localStorage.getItem(key) === serialized;
  } catch {
    // Optional storage may be readable but unable to retain newer live work.
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
  const persistence = useRef({ sessionId, baseline: queue, dirty: false });
  const excludeAccepted = useCallback(
    (entries: QueuedMessage[], live: QueuedMessage[], owner: string | undefined) => {
      // Only exact receipt cleanup removes an owned retained row without also
      // deleting its ownership. Keep that removal through fresh reads and retries.
      const removed = new Set(
        [...submittedOwners.current]
          .filter(
            ([id, source]) => source === owner && !live.some((entry) => entry.queueEntryId === id),
          )
          .map(([id]) => id),
      );
      return removed.size
        ? entries.filter((entry) => !entry.queueEntryId || !removed.has(entry.queueEntryId))
        : entries;
    },
    [],
  );
  const persist = useCallback(
    (id: string | undefined, next: QueuedMessage[]) => {
      const ownsLiveQueue = mounted.current && persistence.current.sessionId === id;
      let observed: QueuedMessage[] | undefined;
      let readable = true;
      let reconciled = next;
      if (ownsLiveQueue && persistence.current.dirty) {
        try {
          observed = readQueue(id);
          reconciled = reconcileQueue(observed, next, persistence.current.baseline);
        } catch {
          readable = false;
        }
      }
      const filtered = ownsLiveQueue ? excludeAccepted(reconciled, next, id) : reconciled;
      const candidate = sameQueue(filtered, next) ? next : filtered;
      const written =
        readable &&
        ((observed !== undefined && sameStoredQueue(observed, candidate)) ||
          saveQueue(id, candidate));
      if (persistence.current.sessionId === id) {
        if (written) persistence.current = { sessionId: id, baseline: candidate, dirty: false };
        else if (observed)
          persistence.current = {
            sessionId: id,
            baseline: observed,
            dirty: !sameStoredQueue(observed, candidate),
          };
        else persistence.current.dirty = true;
      }
      return { written, readable, queue: candidate };
    },
    [excludeAccepted],
  );

  useEffect(() => {
    mounted.current = true;
    const changed = (event: Event) => {
      if (suppressOwnEvent.current) return;
      if ((event as CustomEvent<{ key: string }>).detail?.key !== queueKey(sessionRef.current))
        return;
      let stored: QueuedMessage[];
      try {
        stored = readQueue(sessionRef.current);
      } catch {
        return;
      }
      const live = queueRef.current;
      const candidate = persistence.current.dirty
        ? reconcileQueue(stored, live, persistence.current.baseline)
        : mergeLiveImages(stored, live);
      const restored = excludeAccepted(candidate, live, sessionRef.current);
      // A verified read is storage-owned even if an incidental later save fails.
      // Keep only the difference from this raw snapshot as unsaved local work.
      persistence.current = {
        sessionId: sessionRef.current,
        baseline: stored,
        dirty: !sameStoredQueue(stored, restored),
      };
      queueRef.current = restored;
      setQueueRaw(restored);
    };
    window.addEventListener(QUEUE_CHANGED_EVENT, changed);
    return () => {
      mounted.current = false;
      window.removeEventListener(QUEUE_CHANGED_EVENT, changed);
    };
  }, [excludeAccepted]);

  // Keep ref in sync with state
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  // Persist before transferring ownership, including a queue edit batched with navigation.
  useEffect(() => {
    if (!persistence.current.dirty && sameStoredQueue(queue, persistence.current.baseline)) return;
    const saved = persist(sessionRef.current, queue);
    if (saved.readable && saved.queue !== queue) {
      queueRef.current = saved.queue;
      setQueueRaw(saved.queue);
    }
  }, [queue, persist]);

  // When sessionId changes, load queue for new session
  useEffect(() => {
    const prev = sessionRef.current;
    sessionRef.current = sessionId;
    if (prev === sessionId) return;

    const previousSaved = persist(prev, queueRef.current);
    if (previousSaved.readable) queueRef.current = previousSaved.queue;
    persistence.current = { sessionId, baseline: loadQueue(sessionId), dirty: false };
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
      if (persist(sessionId, promoted).written) {
        try {
          localStorage.removeItem(queueKey(prev));
        } catch {
          /* Optional storage. */
        }
      }
      return;
    }
    if (prev !== undefined || sessionId === undefined || assignment !== undefined) {
      const restored = loadQueue(sessionId);
      queueRef.current = restored;
      setQueueRaw(restored);
      return;
    }

    // Migrate queue from 'new' key when session gets assigned an ID.
    // Use the same persistence baseline as explicit assignment, including quota failure.
    const oldKey = queueKey(prev);
    try {
      const existing = localStorage.getItem(queueKey(sessionId));
      if (existing) {
        const restored = fromStored(JSON.parse(existing));
        queueRef.current = restored;
        setQueueRaw(restored);
        persistence.current = { sessionId, baseline: restored, dirty: false };
        localStorage.removeItem(oldKey);
      } else if (persist(sessionId, queueRef.current).written) {
        localStorage.removeItem(oldKey);
      }
    } catch {
      persistence.current.dirty = true;
    }
  }, [sessionId, assignment, persist]);

  const enqueue = useCallback(
    (msg: QueuedMessage): boolean => {
      if (queueRef.current.length >= maxQueued) return false;
      const next = [...queueRef.current, { ...msg, queueEntryId: createBrowserId() }];
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
  const restoreRejected = useCallback(
    (msg: QueuedMessage) => {
      const retained = { ...msg, requiresRetry: true, queueEntryId: createBrowserId() };
      submittedOwners.current.set(retained.queueEntryId, sessionRef.current);
      const next = [...queueRef.current.filter((item) => item !== msg), retained];
      queueRef.current = next;
      // The fence must exist before the caller dispatches its command, even if
      // the page disappears before React's persistence effect can commit.
      const saved = persist(sessionRef.current, next);
      queueRef.current = saved.readable ? saved.queue : next;
      setQueueRaw(queueRef.current);
      return retained;
    },
    [persist],
  );

  const removeSubmitted = useCallback(
    (msg: QueuedMessage) => {
      const id = msg.queueEntryId;
      if (!id || !submittedOwners.current.has(id)) return;
      const owner = submittedOwners.current.get(id);
      const key = queueKey(owner);
      // A receipt may arrive after navigation or unmount. Reread the owner's
      // storage, preserving locally unsaved work without reviving external deletions.
      const active = mounted.current && sessionRef.current === owner;
      const live = queueRef.current.filter((entry) => entry.queueEntryId !== id);
      let fallback = live;
      try {
        const observed = readQueue(owner);
        const stored = observed.filter((entry) => entry.queueEntryId !== id);
        const remaining = active
          ? persistence.current.dirty
            ? reconcileQueue(stored, live, persistence.current.baseline)
            : mergeLiveImages(stored, live)
          : stored;
        if (active)
          persistence.current = {
            sessionId: owner,
            baseline: observed,
            dirty: !sameStoredQueue(observed, remaining),
          };
        const saved = persist(owner, remaining);
        // Verified fresh fields/deletions can update memory despite write failure;
        // a key-only notification still requires confirmed persistence.
        fallback = saved.readable ? saved.queue : live;
        if (!saved.written) throw Error('Queue storage could not be updated.');
        if (active) {
          queueRef.current = saved.queue;
          setQueueRaw(saved.queue);
        }
        submittedOwners.current.delete(id);
        suppressOwnEvent.current = true;
        try {
          window.dispatchEvent(new CustomEvent(QUEUE_CHANGED_EVENT, { detail: { key } }));
        } finally {
          suppressOwnEvent.current = false;
        }
      } catch {
        // Keep ownership for a later exact cleanup retry. Storage is optional;
        // the accepted active entry must disappear without losing other live work.
        if (active) {
          queueRef.current = fallback;
          setQueueRaw(fallback);
        }
      }
    },
    [persist],
  );

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
