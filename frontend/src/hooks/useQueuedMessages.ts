import { useState, useEffect, useRef, useCallback } from 'react';
import type { ImageAttachment } from '../types/chat';

const KEY_PREFIX = 'mitzo-queue-';

export interface QueuedMessage {
  text: string;
  images: ImageAttachment[];
  contextBlocks: string[];
}

/** Stored shape omits images — base64 data is too large for localStorage. */
interface StoredMessage {
  text: string;
  contextBlocks: string[];
}

function queueKey(sessionId: string | undefined): string {
  return `${KEY_PREFIX}${sessionId ?? 'new'}`;
}

function toStored(msgs: QueuedMessage[]): StoredMessage[] {
  return msgs.map(({ text, contextBlocks }) => ({ text, contextBlocks }));
}

function fromStored(msgs: StoredMessage[]): QueuedMessage[] {
  return msgs.map(({ text, contextBlocks }) => ({ text, contextBlocks, images: [] }));
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
): {
  queue: QueuedMessage[];
  enqueue: (msg: QueuedMessage) => boolean;
  dequeue: () => QueuedMessage | undefined;
  remove: (index: number) => void;
  edit: (index: number) => QueuedMessage | undefined;
} {
  const [queue, setQueueRaw] = useState<QueuedMessage[]>(() => loadQueue(sessionId));
  const queueRef = useRef(queue);
  const sessionRef = useRef(sessionId);

  // Keep ref in sync with state
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  // When sessionId changes, load queue for new session
  useEffect(() => {
    const prev = sessionRef.current;
    sessionRef.current = sessionId;
    if (prev === sessionId) return;

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
  }, [sessionId]);

  // Persist whenever queue changes
  useEffect(() => {
    saveQueue(sessionRef.current, queue);
  }, [queue]);

  const enqueue = useCallback(
    (msg: QueuedMessage): boolean => {
      if (queueRef.current.length >= maxQueued) return false;
      setQueueRaw((prev) => [...prev, msg]);
      return true;
    },
    [maxQueued],
  );

  const dequeue = useCallback((): QueuedMessage | undefined => {
    const current = queueRef.current;
    if (current.length === 0) return undefined;
    const item = current[0];
    setQueueRaw((prev) => prev.slice(1));
    return item;
  }, []);

  const remove = useCallback((index: number) => {
    setQueueRaw((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const edit = useCallback((index: number): QueuedMessage | undefined => {
    const item = queueRef.current[index];
    if (!item) return undefined;
    setQueueRaw((prev) => prev.filter((_, i) => i !== index));
    return item;
  }, []);

  return { queue, enqueue, dequeue, remove, edit };
}
