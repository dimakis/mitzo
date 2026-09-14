import { useState, useEffect, useCallback, useRef } from 'react';
import type { Session } from '../types/chat';
import { renameSession as renameSessionApi } from '../lib/rename-session';
import { apiFetch } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
import type { SessionActivity } from './useSessionOverview';

export interface QuickAction {
  label: string;
  desc: string;
  path?: string;
  prompt?: string;
  cwd?: string;
  extraTools?: string;
}

const DEFAULT_ACTIONS: QuickAction[] = [
  { label: 'Chat Session', desc: 'Interactive chat', path: '/chat' },
  { label: 'Files', desc: 'Browse repo files', path: '/files' },
];

function buildQuickActions(serverActions: QuickAction[] | undefined): QuickAction[] {
  if (!serverActions || serverActions.length === 0) return DEFAULT_ACTIONS;
  return [
    { label: 'Chat Session', desc: 'Interactive chat', path: '/chat' },
    ...serverActions,
    { label: 'Files', desc: 'Browse repo files', path: '/files' },
  ];
}

export interface UseSessionListReturn {
  sessions: Session[];
  quickActions: QuickAction[];
  loading: boolean;
  error: string | null;
  loadingMore: boolean;
  hasMore: boolean;
  updateAvailable: boolean;
  checking: boolean;
  dismissSession: (id: string) => void;
  clearAll: () => void;
  handleRename: (id: string, title: string) => void;
  checkForUpdates: () => Promise<void>;
  loadMore: () => void;
  retry: () => void;
}

function parseSessionsResponse(data: unknown): { sessions: Session[]; hasMore: boolean } {
  // Handle both new paginated shape and legacy array shape
  if (Array.isArray(data)) return { sessions: data, hasMore: false };
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as { sessions?: unknown }).sessions)
  ) {
    throw new Error('Invalid sessions response');
  }
  const obj = data as { sessions: Session[]; hasMore?: unknown };
  return { sessions: obj.sessions, hasMore: obj.hasMore === true };
}

export function useSessionList(): UseSessionListReturn {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [quickActions, setQuickActions] = useState<QuickAction[]>(DEFAULT_ACTIONS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [checking, setChecking] = useState(false);
  const nextOffset = useRef(0);

  const loadSessions = useCallback(async () => {
    try {
      const response = await apiFetch('/api/sessions');
      if (!response.ok) throw new Error(`Sessions request failed (${response.status})`);
      const { sessions: page, hasMore: more } = parseSessionsResponse(await response.json());
      setSessions(page);
      setHasMore(more);
      nextOffset.current = page.length;
      setError(null);
    } catch {
      setError('Couldn’t load chats. Check the connection and try again.');
    }
  }, []);

  useEffect(() => {
    const loadAll = async () => {
      await Promise.all([
        loadSessions(),
        apiFetch('/api/config')
          .then((r) => r.json())
          .catch(() => ({}))
          .then((config) => setQuickActions(buildQuickActions(config.quickActions))),
        apiFetch('/api/version')
          .then((r) => r.json())
          .catch(() => ({}))
          .then((version) => {
            if (version?.updateAvailable) setUpdateAvailable(true);
          }),
      ]);
    };

    loadAll().finally(() => setLoading(false));

    const onVisible = () => {
      if (document.visibilityState === 'visible') loadAll();
    };
    document.addEventListener('visibilitychange', onVisible);

    // Refetch session list when sessions are created, renamed, or deleted
    const unsubChanged = eventBus.on('sessions_changed', () => {
      void loadSessions();
    });

    // Live session dots via SSE — update isActive/isAttached without full refetch
    const unsubActivity = eventBus.on('session_activity', (data) => {
      const activities = data as SessionActivity[];
      const activeIds = new Set(activities.map((a) => a.sessionId));
      setSessions((prev) =>
        prev.map((s) => ({
          ...s,
          isActive: activeIds.has(s.id),
          isAttached: activities.some(
            (a) => a.sessionId === s.id && a.state !== 'idle' && a.state !== 'done',
          ),
        })),
      );
    });

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      unsubChanged();
      unsubActivity();
    };
  }, [loadSessions]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    apiFetch(`/api/sessions?offset=${nextOffset.current}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Sessions request failed (${response.status})`);
        return response.json();
      })
      .then((data) => {
        const { sessions: page, hasMore: more } = parseSessionsResponse(data);
        setSessions((prev) => [...prev, ...page]);
        setHasMore(more);
        nextOffset.current += page.length;
        setError(null);
      })
      .catch(() => setError('Couldn’t load more chats. Check the connection and try again.'))
      .finally(() => setLoadingMore(false));
  }, [loadingMore, hasMore]);

  const dismissSession = useCallback((id: string) => {
    apiFetch(`/api/sessions/${id}`, { method: 'DELETE' })
      .then((response) => {
        if (response.ok) setSessions((prev) => prev.filter((s) => s.id !== id));
      })
      .catch(() => {});
  }, []);

  const clearAll = useCallback(() => {
    apiFetch('/api/sessions', { method: 'DELETE' })
      .then((response) => {
        if (!response.ok) return;
        setSessions([]);
        setHasMore(false);
        nextOffset.current = 0;
      })
      .catch(() => {});
  }, []);

  const handleRename = useCallback((id: string, title: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, summary: title } : s)));
    renameSessionApi(id, title).catch(() => {
      apiFetch('/api/sessions')
        .then((r) => r.json())
        .then((data) => {
          const { sessions: page, hasMore: more } = parseSessionsResponse(data);
          setSessions(page);
          setHasMore(more);
          nextOffset.current = page.length;
        })
        .catch(() => {});
    });
  }, []);

  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    try {
      const res = await apiFetch('/api/version/check', { method: 'POST' });
      const data = await res.json();
      setUpdateAvailable(data.updateAvailable);
    } catch {
      // Network error — ignore
    } finally {
      setChecking(false);
    }
  }, []);

  return {
    sessions,
    quickActions,
    loading,
    loadingMore,
    hasMore,
    updateAvailable,
    checking,
    error,
    dismissSession,
    clearAll,
    handleRename,
    checkForUpdates,
    loadMore,
    retry: () => void loadSessions(),
  };
}
