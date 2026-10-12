import { useState, useEffect, useCallback, useRef } from 'react';
import type { TodoItem, TodoData, TodoOutcomeDraft } from '../types/todo';
import { apiFetch } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
import { ListCache, SupersededListRequest } from '../lib/list-cache';

const todoCache = new ListCache<TodoData>();
eventBus.on('todo_update', () => todoCache.invalidate());

export interface UseTodoDataResult {
  loading: boolean;
  error: string | null;
  items: TodoItem[];
  profiles: string[];
  ack: (id: string) => Promise<void>;
  snooze: (id: string, days?: number) => Promise<void>;
  done: (id: string) => Promise<void>;
  star: (id: string) => Promise<void>;
  create: (summary: string, profile: string, parentId?: string) => Promise<void>;
  createOutcome: (draft: TodoOutcomeDraft) => Promise<TodoItem | undefined>;
  refresh: () => void;
}

function removeFromTree(items: TodoItem[], id: string): TodoItem[] {
  return items
    .filter((item) => item.id !== id)
    .map((item) => {
      const updatedChildren = removeFromTree(item.children, id);
      return {
        ...item,
        children: updatedChildren,
        childCount: updatedChildren.length,
        completedChildCount: updatedChildren.filter((c) => c.status === 'completed').length,
      };
    });
}

export function toggleStarInTree(items: TodoItem[], id: string): TodoItem[] {
  return items.map((item) => {
    if (item.id === id) return { ...item, starred: !item.starred };
    if (item.children.length > 0) {
      return { ...item, children: toggleStarInTree(item.children, id) };
    }
    return item;
  });
}

export function findInTree(items: TodoItem[], id: string): TodoItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const found = findInTree(item.children, id);
    if (found) return found;
  }
  return undefined;
}

export function useTodoData(profile?: string): UseTodoDataResult {
  const url = profile ? `/api/todos?${new URLSearchParams({ profile })}` : '/api/todos';
  const [data, setData] = useState<TodoData | null>(() => todoCache.get(url) ?? null);
  const [loading, setLoading] = useState(() => !todoCache.get(url));
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const dataRef = useRef<TodoData | null>(null);
  dataRef.current = data;

  useEffect(() => {
    let cancelled = false;
    const cached = todoCache.get(url);
    setData(cached ?? null);
    setLoading(!cached);
    setError(null);

    todoCache
      .load(url, async () => {
        const response = await apiFetch(url);
        if (!response.ok) throw new Error(`Todo API returned ${response.status}`);
        return response.json();
      })
      .then((result: TodoData) => {
        if (!cancelled) {
          setData(result);
          setError(null);
          setLoading(false);
        }
      })
      .catch((error) => {
        if (!cancelled && !(error instanceof SupersededListRequest)) {
          setError('Unable to load Telos items');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url, refreshKey]);

  // Live update: SSE todo_update signals a refetch
  useEffect(() => {
    const refreshOnResume = () => {
      if (document.visibilityState === 'visible') setRefreshKey((k) => k + 1);
    };
    document.addEventListener('visibilitychange', refreshOnResume);
    const unsubscribe = eventBus.on('todo_update', () => {
      setRefreshKey((k) => k + 1);
    });
    return () => {
      document.removeEventListener('visibilitychange', refreshOnResume);
      unsubscribe();
    };
  }, []);

  const performAction = useCallback(async (id: string, action: string, days?: number) => {
    const body: Record<string, unknown> = { action };
    if (days !== undefined) body.days = days;

    try {
      const res = await apiFetch(`/api/todos/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        todoCache.update((data) => ({ ...data, items: removeFromTree(data.items, id) }));
        setData((prev) => (prev ? { ...prev, items: removeFromTree(prev.items, id) } : prev));
      }
    } catch {
      // Network error — leave item in list
    }
  }, []);

  const ack = useCallback((id: string) => performAction(id, 'ack'), [performAction]);
  const snooze = useCallback(
    (id: string, days: number = 3) => performAction(id, 'snooze', days),
    [performAction],
  );
  const done = useCallback((id: string) => performAction(id, 'done'), [performAction]);
  const refresh = useCallback(() => {
    todoCache.invalidate();
    setRefreshKey((k) => k + 1);
  }, []);

  const star = useCallback(async (id: string) => {
    // Read current starred state from the ref before toggling,
    // so rapid clicks always see the latest state (avoids stale closure).
    const currentItem = dataRef.current ? findInTree(dataRef.current.items, id) : undefined;
    const action = currentItem?.starred ? 'unstar' : 'star';

    // Optimistically toggle
    todoCache.update((data) => ({ ...data, items: toggleStarInTree(data.items, id) }));
    setData((prev) => {
      if (!prev) return prev;
      return { ...prev, items: toggleStarInTree(prev.items, id) };
    });

    try {
      await apiFetch(`/api/todos/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
    } catch {
      // Optimistic update stays; next refresh will reconcile
    }
  }, []);

  const create = useCallback(
    async (summary: string, profileName: string, parentId?: string) => {
      const body: Record<string, string> = { summary, profile: profileName };
      if (parentId) body.parentId = parentId;

      try {
        const res = await apiFetch('/api/todos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          refresh();
        }
      } catch {
        // Network error
      }
    },
    [refresh],
  );

  const createOutcome = useCallback(
    async (draft: TodoOutcomeDraft) => {
      try {
        const res = await apiFetch('/api/todos/outcomes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draft),
        });
        if (!res.ok) return undefined;
        const result = (await res.json()) as { item?: TodoItem };
        refresh();
        return result.item;
      } catch {
        return undefined;
      }
    },
    [refresh],
  );

  return {
    loading,
    error,
    items: data?.items ?? [],
    profiles: data?.profiles ?? [],
    ack,
    snooze,
    done,
    star,
    create,
    createOutcome,
    refresh,
  };
}
