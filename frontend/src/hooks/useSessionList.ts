import { removeConversationPins, renameConversationPin } from './useConversationPins';
import { useState, useEffect, useCallback, useRef } from 'react';
import type { Session } from '../types/chat';
import type { SessionRemovalOptions } from '../types/sandboxes';
import { renameSession as renameSessionApi } from '../lib/rename-session';
import { apiFetch } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
import type { SessionActivity } from './useSessionOverview';
import { ListCache, SupersededListRequest } from '../lib/list-cache';

type SessionPage = { sessions: Session[]; hasMore: boolean };
const sessionCache = new ListCache<SessionPage>();
const sessionsUrl = '/api/sessions';
// Invalidate once per broadcast, before the mounted consumers revalidate.
eventBus.on('sessions_changed', () => sessionCache.invalidate());

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
  dismissSession: (id: string, options?: SessionRemovalOptions) => Promise<boolean>;
  clearAll: () => Promise<boolean>;
  handleRename: (id: string, title: string) => Promise<boolean>;
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
  const [sessions, setSessions] = useState<Session[]>(
    () => sessionCache.get(sessionsUrl)?.sessions ?? [],
  );
  const [quickActions, setQuickActions] = useState<QuickAction[]>(DEFAULT_ACTIONS);
  const [loading, setLoading] = useState(() => !sessionCache.get(sessionsUrl));
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(() => sessionCache.get(sessionsUrl)?.hasMore ?? false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [checking, setChecking] = useState(false);
  const nextOffset = useRef(sessions.length);
  const hasLoaded = useRef(!loading);

  const loadSessions = useCallback(async () => {
    try {
      const { sessions: page, hasMore: more } = await sessionCache.load(sessionsUrl, async () => {
        const response = await apiFetch(sessionsUrl);
        if (!response.ok) throw new Error(`Sessions request failed (${response.status})`);
        return parseSessionsResponse(await response.json());
      });
      setSessions(page);
      setHasMore(more);
      nextOffset.current = page.length;
      hasLoaded.current = true;
      setError(null);
    } catch (error) {
      if (!(error instanceof SupersededListRequest))
        setError(
          hasLoaded.current
            ? 'Couldn’t refresh chats. Showing the last loaded list.'
            : 'Couldn’t load chats. Check the connection and try again.',
        );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    // Auxiliary metadata must never hold the conversation list in loading state.
    void apiFetch('/api/config')
      .then((r) => r.json())
      .catch(() => ({}))
      .then((config) => setQuickActions(buildQuickActions(config.quickActions)));
    void apiFetch('/api/version')
      .then((r) => r.json())
      .catch(() => ({}))
      .then((version) => {
        if (version?.updateAvailable) setUpdateAvailable(true);
      });

    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadSessions();
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
      const attachedIds = new Set(
        activities.filter((a) => a.state !== 'idle' && a.state !== 'done').map((a) => a.sessionId),
      );
      setSessions((prev) => {
        let changed = false;
        const next = prev.map((session) => {
          const isActive = activeIds.has(session.id);
          const isAttached = attachedIds.has(session.id);
          if (session.isActive === isActive && session.isAttached === isAttached) return session;
          changed = true;
          return { ...session, isActive, isAttached };
        });
        return changed ? next : prev;
      });
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

  const dismissSession = useCallback((id: string, options: SessionRemovalOptions = {}) => {
    return apiFetch(
      `/api/sessions/${encodeURIComponent(id)}${options.archive ? '?archive=1' : ''}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options.cleanupToken ? { cleanupToken: options.cleanupToken } : {}),
      },
    )
      .then((response) => {
        if (response.ok) {
          removeConversationPins(id);
          sessionCache.update((page) => ({
            ...page,
            sessions: page.sessions.filter((s) => s.id !== id),
          }));
          setSessions((prev) => prev.filter((s) => s.id !== id));
          return true;
        }
        return false;
      })
      .catch(() => false);
  }, []);

  const clearAll = useCallback(() => {
    return apiFetch('/api/sessions', { method: 'DELETE' })
      .then((response) => {
        if (!response.ok) return false;
        removeConversationPins();
        sessionCache.clear();
        sessionCache.set(sessionsUrl, { sessions: [], hasMore: false });
        setSessions([]);
        setHasMore(false);
        nextOffset.current = 0;
        return true;
      })
      .catch(() => false);
  }, []);

  const handleRename = useCallback(
    (id: string, title: string) => {
      sessionCache.update((page) => ({
        ...page,
        sessions: page.sessions.map((s) => (s.id === id ? { ...s, summary: title } : s)),
      }));
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, summary: title } : s)));
      return renameSessionApi(id, title)
        .then(() => {
          renameConversationPin(id, title);
          return true;
        })
        .catch(() => {
          sessionCache.invalidate();
          void loadSessions();
          return false;
        });
    },
    [loadSessions],
  );

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
