import { useEffect, useRef, useState } from 'react';
import { TelosWorkApiClient } from '@mitzo/client';
import type { TelosWorkView } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
const api = new TelosWorkApiClient(apiFetch);
/** Abort-fenced role history and current assignments; no allocator/settings writes. */
export function useTelosChatWork(itemId: string | null, refreshKey: string | number) {
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([itemId, refreshKey, revision]);
  const active = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{
    key: string;
    controller: AbortController;
    itemId: string;
    work?: TelosWorkView;
    error?: string;
  }>();
  useEffect(() => {
    const refresh = () => setRevision((v) => v + 1);
    const resume = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const off = eventBus.on('todo_update', refresh),
      offSessions = eventBus.on('sessions_changed', refresh);
    const offConnection = eventBus.onConnectionChange((connected) => {
      if (connected) refresh();
    });
    document.addEventListener('visibilitychange', resume);
    return () => {
      off();
      offSessions();
      offConnection();
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  useEffect(() => {
    if (!itemId) return;
    const controller = new AbortController();
    active.current = controller;
    void api.read(itemId, controller.signal).then(
      (work) => {
        if (!controller.signal.aborted)
          setResult(
            work.itemId === itemId
              ? { key, controller, itemId, work }
              : { key, controller, itemId, error: 'Linked conversations unavailable.' },
          );
      },
      () => {
        if (!controller.signal.aborted)
          setResult({ key, controller, itemId, error: 'Linked conversations unavailable.' });
      },
    );
    return () => controller.abort();
  }, [itemId, key]);
  return {
    // Retained same-item content is display-only until this exact read generation settles.
    current:
      result?.key === key &&
      result.controller === active.current &&
      !result.controller.signal.aborted &&
      !!result.work &&
      !result.error,
    work: result?.itemId === itemId ? result.work : undefined,
    error: result?.itemId === itemId ? result.error : undefined,
    refresh: () => setRevision((v) => v + 1),
  };
}
