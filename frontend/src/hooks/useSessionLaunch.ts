import { useCallback, useEffect, useState } from 'react';
import {
  SessionChatLinkSchema,
  type SessionLaunchRecord,
  type SessionChatLink,
} from '@mitzo/protocol';
import { apiFetch, AUTH_LOST_EVENT } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';

export type SessionLaunchOriginData = { sessionId: string; title: string };
export type SessionLinksData = {
  requests: SessionLaunchRecord[];
  origin?: SessionLaunchOriginData;
  links?: SessionChatLink[];
  refresh(): void;
  error?: string | null;
  /** Advances only after a successful authoritative list read, including an empty list. */
  readRevision?: number;
};
type LaunchList = Omit<SessionLinksData, 'refresh' | 'error' | 'readRevision'>;

/** One read owner for the transcript, launch receipts and Chat details. */
export function useSessionLaunch(sessionId: string | null | undefined, enabled = true) {
  const [snapshot, setSnapshot] = useState<{
    sessionId: string;
    data: LaunchList;
    readRevision: number;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const [failure, setFailure] = useState<{ sessionId: string; cause: unknown } | null>(null);
  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  const activeRequests =
    snapshot !== null &&
    snapshot.sessionId === sessionId &&
    snapshot.data.requests.some((request) =>
      ['pending', 'starting', 'created', 'uncertain'].includes(request.state),
    );
  const pollInterval = activeRequests ? 5000 : 30000;
  useEffect(() => {
    if (!sessionId || !enabled) return;
    const offChanged = eventBus.on('session_launch_changed', (data) => {
      if (data && typeof data === 'object' && 'sessionId' in data && data.sessionId === sessionId)
        refresh();
    });
    const offConnection = eventBus.onConnectionChange((connected) => {
      if (connected) refresh();
    });
    const visible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const timer = window.setInterval(refresh, pollInterval);
    document.addEventListener('visibilitychange', visible);
    return () => {
      offChanged();
      offConnection();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [sessionId, enabled, refresh, pollInterval]);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    let live = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    void apiFetch(`/api/session-launch/requests?sessionId=${encodeURIComponent(sessionId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`session_launch_read_http_${response.status}`);
        const data: LaunchList = await response.json();
        if (!Array.isArray(data.requests)) throw new Error('session_launch_read_invalid');
        if (data.links) data.links = data.links.map((link) => SessionChatLinkSchema.parse(link));
        if (live && !controller.signal.aborted) {
          setSnapshot((previous) => ({
            sessionId,
            data,
            readRevision: previous?.sessionId === sessionId ? previous.readRevision + 1 : 1,
          }));
          setFailure(null);
        }
      })
      .catch((cause: unknown) => {
        if (!live) return; // Unmount/session change explicitly cancels this read.
        setFailure({ sessionId, cause });
        console.warn('Session links could not be refreshed', {
          code: 'session_launch_read_failed',
          stage: 'read',
          sessionId,
          cause: cause instanceof Error ? cause.name : 'UnknownError',
        });
      })
      .finally(() => window.clearTimeout(timer));
    const clear = () => {
      live = false;
      controller.abort();
      setSnapshot(null);
      setFailure(null);
    };
    window.addEventListener(AUTH_LOST_EVENT, clear);
    return () => {
      live = false;
      controller.abort();
      window.clearTimeout(timer);
      window.removeEventListener(AUTH_LOST_EVENT, clear);
    };
  }, [sessionId, enabled, revision, refresh]);
  return {
    ...(enabled && snapshot !== null && snapshot.sessionId === sessionId
      ? snapshot.data
      : { requests: [] }),
    refresh,
    readRevision:
      enabled && snapshot !== null && snapshot.sessionId === sessionId ? snapshot.readRevision : 0,
    error:
      enabled && failure !== null && failure.sessionId === sessionId
        ? 'Links could not be refreshed. Showing the last observation; check again before acting.'
        : null,
  };
}
