import { useEffect, useState } from 'react';
import { TelosWorkApiClient } from '@mitzo/client';
import type { TelosWorkItem } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
const api = new TelosWorkApiClient(apiFetch);
/** Join the current collection to accepted record DTOs. Per-record reads are
 * bounded to four requests; a collection projection remains an upstream API gap. */
export function useTelosRecords(ids: string[]) {
  const key = JSON.stringify([...new Set(ids)]);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    records: TelosWorkItem[];
    unavailable: string[];
  }>();
  useEffect(() => {
    const invalidate = () => setRetry((value) => value + 1);
    const onResume = () => {
      if (document.visibilityState === 'visible') invalidate();
    };
    const unsubscribe = eventBus.on('todo_update', invalidate);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onResume);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const queue = JSON.parse(key) as string[];
    const records: TelosWorkItem[] = [];
    const unavailable: string[] = [];
    let cursor = 0;
    async function read() {
      while (cursor < queue.length && !controller.signal.aborted) {
        const id = queue[cursor++];
        try {
          const record = await api.readRecord(id, controller.signal);
          if (record.itemId !== id) throw Error('Record identity mismatch');
          records.push(record);
        } catch {
          if (!controller.signal.aborted) unavailable.push(id);
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, read)).then(() => {
      if (!controller.signal.aborted)
        setResult({
          key,
          records: records.sort((a, b) => queue.indexOf(a.itemId) - queue.indexOf(b.itemId)),
          unavailable,
        });
    });
    return () => controller.abort();
  }, [key, retry]);
  const current = result?.key === key ? result : undefined;
  return {
    loading: !current,
    records: current?.records ?? [],
    unavailable: current?.unavailable ?? [],
    refresh: () => {
      setResult(undefined);
      setRetry((n) => n + 1);
    },
  };
}
