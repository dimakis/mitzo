import { useEffect, useRef, useState } from 'react';
import { TelosWorkApiClient, TelosWorkApiError } from '@mitzo/client';
import type { TelosWorkItem } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
import { subscribeTodoLifecycleUpdates } from '../lib/todo-lifecycle-events';
import { subscribeTodoPriorityUpdates, type ConfirmedTodoPriority } from '../lib/todo-priority';
const api = new TelosWorkApiClient(apiFetch);
// Carry an acknowledged write across navigation until a record read confirms it.
const confirmations = new Map<string, ConfirmedTodoPriority>();
subscribeTodoPriorityUpdates((change) => confirmations.set(change.id, change));
interface RecordsResult {
  key: string;
  records: TelosWorkItem[];
  unavailable: string[];
  failures: { itemId: string; code: string; status?: number }[];
  loading: boolean;
  settled: boolean;
}
/** Join the current collection to accepted record DTOs. Per-record reads are
 * bounded to four requests; a collection projection remains an upstream API gap. */
export function useTelosRecords(ids: string[], refreshKey: string | number = 0) {
  const key = JSON.stringify([...new Set(ids)]);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<RecordsResult>();
  const latest = useRef(result);
  latest.current = result;
  const active = useRef<AbortController | null>(null);
  const pending = useRef(new Map(confirmations));
  useEffect(() => {
    const invalidate = () => {
      active.current?.abort();
      setRetry((value) => value + 1);
    };
    const onResume = () => {
      if (document.visibilityState === 'visible') invalidate();
    };
    const unsubscribe = eventBus.on('todo_update', invalidate);
    const lifecycle = subscribeTodoLifecycleUpdates(invalidate);
    const unsubscribePriority = subscribeTodoPriorityUpdates((change) => {
      pending.current.set(change.id, change);
      invalidate();
      setResult(
        (current) =>
          current && {
            ...current,
            records: current.records.map((record) =>
              record.itemId === change.id ? { ...record, priority: change.priority } : record,
            ),
          },
      );
    });
    document.addEventListener('visibilitychange', onResume);
    return () => {
      unsubscribe();
      lifecycle();
      unsubscribePriority();
      document.removeEventListener('visibilitychange', onResume);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    const queue = JSON.parse(key) as string[];
    const records: TelosWorkItem[] = [];
    const unavailable: string[] = [];
    const failures: RecordsResult['failures'] = [];
    const retainedAtStart = latest.current?.key === key ? latest.current : undefined;
    const retainUntilSettled = retainedAtStart?.settled === true;
    if (retainedAtStart) setResult({ ...retainedAtStart, loading: true });
    function publish(loading: boolean) {
      if (controller.signal.aborted) return;
      setResult({
        key,
        loading,
        settled: !loading,
        records: [...records].sort((a, b) => queue.indexOf(a.itemId) - queue.indexOf(b.itemId)),
        unavailable: [...unavailable],
        failures: [...failures],
      });
    }
    let cursor = 0;
    async function read() {
      while (cursor < queue.length && !controller.signal.aborted) {
        const id = queue[cursor++];
        try {
          const record = await api.readRecord(id, controller.signal);
          if (controller.signal.aborted) return;
          if (record.itemId !== id) throw Error('Record identity mismatch');
          const confirmation = pending.current.get(id);
          if (confirmation) {
            // The record route is private/no-store and opens a fresh canonical
            // transaction. Save notifications abort every earlier admitted read;
            // this successful read was therefore admitted after acknowledgement.
            // Another client may already have changed the priority again. Accept
            // that authority even when it differs from our last confirmed value.
            pending.current.delete(id);
            if (confirmations.get(id) === confirmation) confirmations.delete(id);
          }
          records.push(record);
        } catch (error) {
          if (!controller.signal.aborted) {
            unavailable.push(id);
            failures.push({
              itemId: id,
              code:
                error instanceof TelosWorkApiError
                  ? error.code
                  : error instanceof Error && error.name === 'ZodError'
                    ? 'invalid_record'
                    : error instanceof Error && error.message === 'Record identity mismatch'
                      ? 'record_identity_mismatch'
                      : 'record_read_failed',
              ...(error instanceof TelosWorkApiError ? { status: error.status } : {}),
            });
            const retained = retainedAtStart?.records.find((record) => record.itemId === id);
            const confirmation = pending.current.get(id);
            if (retained && confirmation)
              records.push({ ...retained, priority: confirmation.priority });
          }
        }
        // Initial discovery can display each ready item without waiting for a
        // slow sibling, including after an interrupted initial read. Only a
        // previously settled snapshot is retained until its refresh settles.
        if (!retainUntilSettled) publish(true);
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, read)).then(() => {
      publish(false);
    });
    return () => controller.abort();
  }, [key, retry, refreshKey]);
  const current = result?.key === key ? result : undefined;
  return {
    // Conversation controls share this owner’s manual/event/resume invalidation.
    refreshKey: JSON.stringify([key, retry, refreshKey]),
    loading: current?.loading ?? true,
    initializing: !current || !current.settled,
    records: current?.records ?? [],
    unavailable: current?.unavailable ?? [],
    failures: current?.failures ?? [],
    refresh: () => {
      active.current?.abort();
      setRetry((n) => n + 1);
    },
  };
}
