import { useEffect, useState } from 'react';
import { TelosWorkApiClient } from '@mitzo/client';
import type { TelosWorkView } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
const api = new TelosWorkApiClient(apiFetch);
/** Abort-fenced role history and current assignments; no allocator/settings writes. */
export function useTelosChatWork(itemId: string, refreshKey: string | number) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ itemId: string; work?: TelosWorkView; error?: string }>();
  useEffect(() => {
    const refresh = () => setRevision((v) => v + 1);
    const resume = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const off = eventBus.on('todo_update', refresh),
      offSessions = eventBus.on('sessions_changed', refresh);
    document.addEventListener('visibilitychange', resume);
    return () => {
      off();
      offSessions();
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api.read(itemId, controller.signal).then(
      (work) => {
        if (!controller.signal.aborted)
          setResult(
            work.itemId === itemId
              ? { itemId, work }
              : { itemId, error: 'Linked conversations unavailable.' },
          );
      },
      () => {
        if (!controller.signal.aborted)
          setResult({ itemId, error: 'Linked conversations unavailable.' });
      },
    );
    return () => controller.abort();
  }, [itemId, refreshKey, revision]);
  return {
    work: result?.itemId === itemId ? result.work : undefined,
    error: result?.itemId === itemId ? result.error : undefined,
    refresh: () => setRevision((v) => v + 1),
  };
}
