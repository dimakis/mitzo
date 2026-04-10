import { useState, useEffect, useCallback } from 'react';
import type { TodoItem, TodoData } from '../types/todo';

export interface UseTodoDataResult {
  loading: boolean;
  items: TodoItem[];
  profiles: string[];
  ack: (id: string) => Promise<void>;
  snooze: (id: string, days?: number) => Promise<void>;
  done: (id: string) => Promise<void>;
  refresh: () => void;
}

export function useTodoData(profile?: string): UseTodoDataResult {
  const [data, setData] = useState<TodoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const url = profile ? `/api/todos?profile=${profile}` : '/api/todos';

    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`Todo API returned ${r.status}`);
        return r.json();
      })
      .then((result: TodoData) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setData({ profiles: [], items: [] });
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [profile, refreshKey]);

  const performAction = useCallback(
    async (id: string, action: string, days?: number) => {
      const body: Record<string, unknown> = { action };
      if (days !== undefined) body.days = days;

      const res = await fetch(`/api/todos/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        // Optimistically remove from list
        setData((prev) =>
          prev ? { ...prev, items: prev.items.filter((item) => item.id !== id) } : prev,
        );
      }
    },
    [],
  );

  const ack = useCallback((id: string) => performAction(id, 'ack'), [performAction]);
  const snooze = useCallback(
    (id: string, days: number = 3) => performAction(id, 'snooze', days),
    [performAction],
  );
  const done = useCallback((id: string) => performAction(id, 'done'), [performAction]);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return {
    loading,
    items: data?.items ?? [],
    profiles: data?.profiles ?? [],
    ack,
    snooze,
    done,
    refresh,
  };
}
