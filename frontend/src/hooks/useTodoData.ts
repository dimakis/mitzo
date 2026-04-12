import { useState, useEffect, useCallback } from 'react';
import type { TodoItem, TodoData } from '../types/todo';

export interface UseTodoDataResult {
  loading: boolean;
  items: TodoItem[];
  profiles: string[];
  ack: (id: string) => Promise<void>;
  snooze: (id: string, days?: number) => Promise<void>;
  done: (id: string) => Promise<void>;
  star: (id: string) => Promise<void>;
  create: (summary: string, profile: string, parentId?: string) => Promise<void>;
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

function toggleStarInTree(items: TodoItem[], id: string): TodoItem[] {
  return items.map((item) => {
    if (item.id === id) return { ...item, starred: !item.starred };
    if (item.children.length > 0) {
      return { ...item, children: toggleStarInTree(item.children, id) };
    }
    return item;
  });
}

function findInTree(items: TodoItem[], id: string): TodoItem | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const found = findInTree(item.children, id);
    if (found) return found;
  }
  return undefined;
}

export function useTodoData(profile?: string): UseTodoDataResult {
  const [data, setData] = useState<TodoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const url = profile ? `/api/todos?${new URLSearchParams({ profile })}` : '/api/todos';

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

  const performAction = useCallback(async (id: string, action: string, days?: number) => {
    const body: Record<string, unknown> = { action };
    if (days !== undefined) body.days = days;

    try {
      const res = await fetch(`/api/todos/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
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
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const star = useCallback(
    async (id: string) => {
      // Determine current state, then optimistically toggle
      setData((prev) => {
        if (!prev) return prev;
        return { ...prev, items: toggleStarInTree(prev.items, id) };
      });

      // Read current starred state to decide action (before toggle)
      const currentItem = data ? findInTree(data.items, id) : undefined;
      const action = currentItem?.starred ? 'unstar' : 'star';

      try {
        await fetch(`/api/todos/${id}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
      } catch {
        // Optimistic update stays; next refresh will reconcile
      }
    },
    [data],
  );

  const create = useCallback(
    async (summary: string, profileName: string, parentId?: string) => {
      const body: Record<string, string> = { summary, profile: profileName };
      if (parentId) body.parentId = parentId;

      try {
        const res = await fetch('/api/todos', {
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

  return {
    loading,
    items: data?.items ?? [],
    profiles: data?.profiles ?? [],
    ack,
    snooze,
    done,
    star,
    create,
    refresh,
  };
}
