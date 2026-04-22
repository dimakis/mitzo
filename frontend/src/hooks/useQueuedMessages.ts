import { useState, useEffect, useRef, useCallback } from 'react';
import type { ImageAttachment } from '../types/chat';

const KEY_PREFIX = 'mitzo-queue-';

export interface QueuedMessage {
  text: string;
  images: ImageAttachment[];
  contextBlocks: string[];
}

function queueKey(sessionId: string | undefined): string {
  return `${KEY_PREFIX}${sessionId ?? 'new'}`;
}

function loadQueue(sessionId: string | undefined): QueuedMessage[] {
  try {
    const raw = localStorage.getItem(queueKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
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
      localStorage.setItem(key, JSON.stringify(queue));
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
  clear: () => void;
} {
  const [queue, setQueueRaw] = useState<QueuedMessage[]>(() => loadQueue(sessionId));
  const sessionRef = useRef(sessionId);

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
        setQueueRaw(JSON.parse(existing));
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
      let added = false;
      setQueueRaw((prev) => {
        if (prev.length >= maxQueued) return prev;
        added = true;
        return [...prev, msg];
      });
      return added;
    },
    [maxQueued],
  );

  const dequeue = useCallback((): QueuedMessage | undefined => {
    let item: QueuedMessage | undefined;
    setQueueRaw((prev) => {
      if (prev.length === 0) return prev;
      [item] = prev;
      return prev.slice(1);
    });
    return item;
  }, []);

  const remove = useCallback((index: number) => {
    setQueueRaw((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const edit = useCallback((index: number): QueuedMessage | undefined => {
    let item: QueuedMessage | undefined;
    setQueueRaw((prev) => {
      item = prev[index];
      if (!item) return prev;
      return prev.filter((_, i) => i !== index);
    });
    return item;
  }, []);

  const clear = useCallback(() => {
    setQueueRaw([]);
  }, []);

  return { queue, enqueue, dequeue, remove, edit, clear };
}
