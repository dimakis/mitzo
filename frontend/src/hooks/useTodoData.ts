import { canonicalTodoData } from '../lib/canonical-todo-data';
import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import type { TodoItem, TodoData, TodoOutcomeDraft } from '../types/todo';
import { apiFetch, invalidateTodoReads } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
import { ListCache, SupersededListRequest } from '../lib/list-cache';
import { setTodoPriority, subscribeTodoPriorityUpdates } from '../lib/todo-priority';
import { todoPriority } from '../lib/todo-utils';
import { subscribeTodoLifecycleUpdates } from '../lib/todo-lifecycle-events';
import type { TelosCollectionView } from '../lib/telos-collection-view';

const todoCache = new ListCache<TodoData>();
// Same authentication lifetime as list snapshots. Keep only the latest known
// priority so navigation fallbacks survive responsive remounts without freezing
// a confirmed write over a later authoritative read.
const prioritySnapshots = new ListCache<number>();
function rememberPriorities(data: TodoData): void {
  function visit(items: TodoItem[]) {
    for (const item of items) {
      prioritySnapshots.set(item.id, todoPriority(item));
      visit(item.children);
    }
  }
  visit(data.items);
}
export function useLatestTodoPriority(item: TodoItem | undefined): TodoItem | undefined {
  const id = item?.id;
  const subscribe = useCallback(
    (listener: () => void) => (id ? prioritySnapshots.subscribe(id, listener) : () => {}),
    [id],
  );
  const read = useCallback(() => (id ? prioritySnapshots.get(id) : undefined), [id]);
  const priority = useSyncExternalStore(subscribe, read, read);
  return !item || priority === undefined || priority === item.priority
    ? item
    : { ...item, priority };
}
subscribeTodoPriorityUpdates(({ id, priority }) => {
  prioritySnapshots.set(id, priority);
  todoCache.update((data) => ({
    ...data,
    items: setPriorityInTree(data.items, id, priority),
    records: data.records?.map((record) =>
      record.itemId === id ? { ...record, priority } : record,
    ),
  }));
});
function invalidateTodos(): void {
  invalidateTodoReads();
  todoCache.invalidate();
}
// One invalidation boundary for all mounted canonical consumers. Subscribers
// renew together and ListCache coalesces their reads after retiring older work.
const collectionListeners = new Set<() => void>();
let stopCollectionEvents: (() => void) | undefined;
function subscribeCollectionEvents(listener: () => void) {
  collectionListeners.add(listener);
  if (!stopCollectionEvents) {
    const refresh = () => {
      invalidateTodos();
      collectionListeners.forEach((listener) => listener());
    };
    const offConnection = eventBus.onConnectionChange((connected) => {
      if (connected) refresh();
    });
    const offSessions = eventBus.on('sessions_changed', refresh);
    stopCollectionEvents = () => {
      offConnection();
      offSessions();
    };
  }
  return () => {
    collectionListeners.delete(listener);
    if (!collectionListeners.size) {
      stopCollectionEvents?.();
      stopCollectionEvents = undefined;
    }
  };
}
eventBus.on('todo_update', invalidateTodos);
subscribeTodoLifecycleUpdates(() => todoCache.clear());

export interface UseTodoDataResult {
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  items: TodoItem[];
  profiles: string[];
  records?: TodoData['records'];
  recordFailures?: TodoData['recordFailures'];
  refreshKey: number;
  ack: (id: string) => Promise<void>;
  snooze: (id: string, days?: number) => Promise<void>;
  done: (id: string) => Promise<void>;
  star: (id: string) => Promise<void>;
  setPriority: (id: string, priority: number) => Promise<void>;
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

function setPriorityInTree(items: TodoItem[], id: string, priority: number): TodoItem[] {
  return items.map((item) => {
    if (item.id === id) return { ...item, priority };
    return item.children.length > 0
      ? { ...item, children: setPriorityInTree(item.children, id, priority) }
      : item;
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

function filterCanonicalProfile(items: TodoItem[], profile: string): TodoItem[] {
  return items.flatMap((item) =>
    item.profile === profile ? [item] : filterCanonicalProfile(item.children, profile),
  );
}

export function useTodoData(
  profile?: string,
  resolveItemId?: string,
  view: TelosCollectionView = 'active',
  source: 'legacy' | 'canonical' = 'legacy',
  enabled = true,
): UseTodoDataResult {
  const params = new URLSearchParams();
  if (profile && source === 'legacy') params.set('profile', profile);
  if (view !== 'active') params.set('view', view);
  const query = params.toString();
  const url =
    (source === 'canonical' ? '/api/telos/work/collection' : '/api/todos') +
    (query ? '?' + query : '');
  const [data, setData] = useState<TodoData | null>(() => todoCache.get(url) ?? null);
  const [dataScope, setDataScope] = useState(url);
  const visibleData = dataScope === url ? data : (todoCache.get(url) ?? null);
  const [loading, setLoading] = useState(() => !todoCache.get(url));
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const dataRef = useRef<TodoData | null>(null);
  dataRef.current = visibleData;
  const errorScope = useRef(url);
  const urlRef = useRef(url);
  urlRef.current = url;

  useEffect(
    () =>
      todoCache.subscribe(url, () => {
        setData(todoCache.get(url) ?? null);
        setDataScope(url);
      }),
    [url],
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const cached = todoCache.get(url);
    setDataScope(url);
    setData(cached ?? null);
    setLoading(!cached);
    setRefreshing(true);
    // Keep the visible fallback and its error while a retry is pending. Only
    // an accepted read proves recovery; switching query scopes starts fresh.
    if (errorScope.current !== url) {
      errorScope.current = url;
      setError(null);
    }

    todoCache
      .load(
        url,
        async () => {
          const response = await apiFetch(url);
          if (!response.ok) throw new Error(`Todo API returned ${response.status}`);
          const data: unknown = await response.json();
          return source === 'canonical' ? canonicalTodoData(data) : (data as TodoData);
        },
        rememberPriorities,
        resolveItemId
          ? {
              id: resolveItemId,
              present: (snapshot) => !!findInTree(snapshot?.items ?? [], resolveItemId),
              retire: invalidateTodoReads,
            }
          : undefined,
      )
      .then(() => {
        if (!cancelled) {
          // The cache subscription publishes admitted reads and confirmed
          // mutations in order. Promise completion must not replay an older
          // read over a write acknowledged after that read's admission.
          setError(null);
          setLoading(false);
          setRefreshing(false);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof SupersededListRequest) {
          // An action can finish after switching to an uncached profile.
          // The mounted consumer still needs a current read after invalidation.
          setRefreshKey((k) => k + 1);
        } else {
          setError('Unable to load Telos items');
          setLoading(false);
          setRefreshing(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url, refreshKey, resolveItemId, source, enabled]);

  useEffect(() => {
    if (source !== 'canonical' || !enabled) return;
    return subscribeCollectionEvents(() => setRefreshKey((key) => key + 1));
  }, [source, enabled]);

  // Live update: SSE todo_update signals a refetch
  useEffect(() => {
    const refreshOnResume = () => {
      if (document.visibilityState === 'visible') setRefreshKey((k) => k + 1);
    };
    document.addEventListener('visibilitychange', refreshOnResume);
    const unsubscribe = eventBus.on('todo_update', () => {
      setRefreshKey((k) => k + 1);
    });
    const lifecycle = subscribeTodoLifecycleUpdates(() => {
      setLoading(true);
      setRefreshKey((k) => k + 1);
    });
    return () => {
      document.removeEventListener('visibilitychange', refreshOnResume);
      unsubscribe();
      lifecycle();
    };
  }, []);

  const performAction = useCallback(async (id: string, action: string, days?: number) => {
    const actionUrl = urlRef.current;
    const body: Record<string, unknown> = { action };
    if (days !== undefined) body.days = days;

    try {
      const res = await apiFetch(`/api/todos/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error('Outcome change rejected');
      if (urlRef.current === actionUrl)
        setError((previous) =>
          previous === 'Couldn’t confirm this change. Refresh to check its status.'
            ? null
            : previous,
        );
      invalidateTodoReads();
      todoCache.update((data) => ({ ...data, items: removeFromTree(data.items, id) }));
    } catch {
      if (urlRef.current === actionUrl)
        setError('Couldn’t confirm this change. Refresh to check its status.');
    }
  }, []);

  const ack = useCallback((id: string) => performAction(id, 'ack'), [performAction]);
  const snooze = useCallback(
    (id: string, days: number = 3) => performAction(id, 'snooze', days),
    [performAction],
  );
  const done = useCallback((id: string) => performAction(id, 'done'), [performAction]);
  const refresh = useCallback(() => {
    invalidateTodos();
    setRefreshKey((k) => k + 1);
  }, []);

  const star = useCallback(async (id: string) => {
    const actionUrl = urlRef.current;
    // Read current starred state from the ref before toggling,
    // so rapid clicks always see the latest state (avoids stale closure).
    const currentItem = dataRef.current ? findInTree(dataRef.current.items, id) : undefined;
    const action = currentItem?.starred ? 'unstar' : 'star';

    // Optimistically toggle
    invalidateTodoReads();
    todoCache.update((data) => ({ ...data, items: toggleStarInTree(data.items, id) }));

    try {
      const response = await apiFetch(`/api/todos/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw Error('Star change rejected');
    } catch {
      // A lost response may follow a completed write. Keep the visible state
      // uncertain until an explicit refresh reconciles it; never replay a write.
      if (urlRef.current === actionUrl)
        setError('Couldn’t confirm this change. Refresh to check its status.');
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
        if (!res.ok) throw Error('Creation rejected');
        refresh();
      } catch {
        // The form already retains its fields when onCreate rejects.
        throw Error('Couldn’t confirm creation. Refresh to check its status.');
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
    loading: dataScope === url ? loading : !visibleData,
    refreshing: dataScope !== url || refreshing,
    error: dataScope === url ? error : null,
    items:
      source === 'canonical' && profile
        ? filterCanonicalProfile(visibleData?.items ?? [], profile)
        : (visibleData?.items ?? []),
    profiles: visibleData?.profiles ?? [],
    records: visibleData?.records,
    recordFailures: visibleData?.recordFailures,
    refreshKey,
    ack,
    snooze,
    done,
    star,
    setPriority: setTodoPriority,
    create,
    createOutcome,
    refresh,
  };
}
