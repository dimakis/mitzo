import { NOTIFICATIONS_REFRESH_EVENT } from '../lib/notification-target';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { NotificationFeed, NotificationFilter } from '@mitzo/protocol';
import { apiFetch, AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
import { readApiJson } from '../lib/api-json-read';
import { syncNotificationBadge } from '../lib/notification-badge';
interface NotificationContext {
  feed: NotificationFeed | null;
  error: string | null;
  loading: boolean;
  filter: NotificationFilter;
  offset: number;
  setFilter: (value: NotificationFilter) => void;
  setOffset: (value: number) => void;
  refresh: () => Promise<void>;
  mutate: (path: string, body?: unknown, method?: string) => Promise<void>;
}
const Context = createContext<NotificationContext | null>(null);
export function useNotifications(): NotificationContext | null {
  return useContext(Context);
}
/** One authenticated shared subscription keeps badges and every screen in agreement. */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [feed, setFeed] = useState<NotificationFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilterValue] = useState<NotificationFilter>('all');
  const [offset, setOffset] = useState(0);
  const generation = useRef(0);
  const blocked = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef<{
    generation: number;
    controller: AbortController;
    promise: Promise<void>;
    followUp?: Promise<void>;
  } | null>(null);
  const refresh = useCallback(
    async (changed = false): Promise<void> => {
      if (blocked.current) return;
      const gen = generation.current;
      const pending = inFlight.current;
      if (pending?.generation === gen) {
        if (!changed) return pending.promise;
        // Mutations and SSE changes may arrive after the server took its snapshot.
        // Preserve one trailing read; simple reconnect/resume signals share this one.
        pending.followUp ??= pending.promise.then(() => {
          if (generation.current === gen && !blocked.current) return refresh();
        });
        return pending.followUp;
      }
      const seq = ++sequence.current;
      const next = {
        generation: gen,
        controller: new AbortController(),
        promise: Promise.resolve(),
      };
      inFlight.current = next;
      next.promise = (async () => {
        try {
          const data = await readApiJson<NotificationFeed>(
            `/api/notifications?${new URLSearchParams({ filter, offset: String(offset), limit: '50' })}`,
            next.controller.signal,
          );
          if (gen !== generation.current || seq !== sequence.current || blocked.current) return;
          if (offset > 0 && offset >= data.total) {
            setOffset(Math.max(0, Math.floor((data.total - 1) / 50) * 50));
            return;
          }
          setFeed(data);
          setError(null);
          setLoading(false);
          void syncNotificationBadge(data.needsYou);
        } catch {
          if (gen !== generation.current || seq !== sequence.current || blocked.current) return;
          setError('Cannot load notifications. Try again.');
          setLoading(false);
        }
      })().finally(() => {
        if (inFlight.current === next) inFlight.current = null;
      });
      return next.promise;
    },
    [filter, offset],
  );
  useEffect(() => {
    const lost = () => {
      inFlight.current?.controller.abort();
      generation.current++;
      blocked.current = true;
      setFeed(null);
      setError(null);
      setLoading(false);
    };
    const restored = () => {
      blocked.current = false;
      void refresh();
    };
    const nativeRefresh = () => {
      void refresh();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener(AUTH_LOST_EVENT, lost);
    window.addEventListener(AUTH_RESTORED_EVENT, restored);
    window.addEventListener(NOTIFICATIONS_REFRESH_EVENT, nativeRefresh);
    document.addEventListener('visibilitychange', visible);
    const unsubscribe = eventBus.on('notifications_changed', () => {
      void refresh(true);
    });
    const reconnected = eventBus.onConnectionChange((connected) => {
      if (connected) void refresh();
    });
    if (window.location.pathname !== '/login') void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 30000);
    return () => {
      inFlight.current?.controller.abort();
      generation.current++;
      clearInterval(timer);
      unsubscribe();
      reconnected();
      window.removeEventListener(AUTH_LOST_EVENT, lost);
      window.removeEventListener(AUTH_RESTORED_EVENT, restored);
      window.removeEventListener(NOTIFICATIONS_REFRESH_EVENT, nativeRefresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  const mutate = useCallback(
    async (path: string, body?: unknown, method = 'POST') => {
      const response = await apiFetch(`/api/notifications${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Cannot save this change. Try again.');
      }
      await refresh(true);
    },
    [refresh],
  );
  const setFilter = useCallback((value: NotificationFilter) => {
    setOffset(0);
    setFilterValue(value);
  }, []);
  return (
    <Context.Provider
      value={{ feed, error, loading, filter, offset, setFilter, setOffset, refresh, mutate }}
    >
      {children}
    </Context.Provider>
  );
}
