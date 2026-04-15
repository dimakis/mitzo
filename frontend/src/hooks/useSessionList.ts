import { useState, useEffect, useCallback } from 'react';
import type { Session } from '../types/chat';
import { renameSession as renameSessionApi } from '../lib/rename-session';

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
  loadingMore: boolean;
  hasMore: boolean;
  updateAvailable: boolean;
  checking: boolean;
  dismissSession: (id: string) => void;
  clearAll: () => void;
  handleRename: (id: string, title: string) => void;
  checkForUpdates: () => Promise<void>;
  loadMore: () => void;
}

const PAGE_SIZE = 20;

function parseSessionsResponse(data: unknown): { sessions: Session[]; hasMore: boolean } {
  // Handle both new paginated shape and legacy array shape
  if (Array.isArray(data)) return { sessions: data, hasMore: false };
  const obj = data as { sessions?: Session[]; hasMore?: boolean };
  return { sessions: obj.sessions ?? [], hasMore: obj.hasMore ?? false };
}

export function useSessionList(): UseSessionListReturn {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [quickActions, setQuickActions] = useState<QuickAction[]>(DEFAULT_ACTIONS);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const loadAll = () =>
      Promise.all([
        fetch(`/api/sessions?offset=0&limit=${PAGE_SIZE}`)
          .then((r) => r.json())
          .catch(() => ({ sessions: [], hasMore: false })),
        fetch('/api/config')
          .then((r) => r.json())
          .catch(() => ({})),
        fetch('/api/version')
          .then((r) => r.json())
          .catch(() => ({})),
      ]).then(([sessData, config, version]) => {
        const { sessions: page, hasMore: more } = parseSessionsResponse(sessData);
        setSessions(page);
        setHasMore(more);
        setQuickActions(buildQuickActions(config.quickActions));
        if (version?.updateAvailable) setUpdateAvailable(true);
      });

    loadAll().finally(() => setLoading(false));

    const onVisible = () => {
      if (document.visibilityState === 'visible') loadAll();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const offset = sessions.length;
    fetch(`/api/sessions?offset=${offset}&limit=${PAGE_SIZE}`)
      .then((r) => r.json())
      .then((data) => {
        const { sessions: page, hasMore: more } = parseSessionsResponse(data);
        setSessions((prev) => [...prev, ...page]);
        setHasMore(more);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [loadingMore, hasMore, sessions.length]);

  const dismissSession = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    fetch(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
  }, []);

  const clearAll = useCallback(() => {
    setSessions([]);
    setHasMore(false);
    fetch('/api/sessions', { method: 'DELETE' }).catch(() => {});
  }, []);

  const handleRename = useCallback((id: string, title: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, summary: title } : s)));
    renameSessionApi(id, title).catch(() => {
      fetch(`/api/sessions?offset=0&limit=${PAGE_SIZE}`)
        .then((r) => r.json())
        .then((data) => {
          const { sessions: page, hasMore: more } = parseSessionsResponse(data);
          setSessions(page);
          setHasMore(more);
        })
        .catch(() => {});
    });
  }, []);

  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch('/api/version/check', { method: 'POST' });
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
    dismissSession,
    clearAll,
    handleRename,
    checkForUpdates,
    loadMore,
  };
}
