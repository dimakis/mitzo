import { useCallback, useEffect, useState } from 'react';
import type { SessionLaunchRecord } from '@mitzo/protocol';
import { apiFetch, AUTH_LOST_EVENT } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';

export type SessionLaunchOriginData = { sessionId: string; title: string };
type LaunchList = { requests: SessionLaunchRecord[]; origin?: SessionLaunchOriginData };

/** One read owner for the transcript, launch receipts and Chat details. */
export function useSessionLaunch(sessionId: string | null | undefined, enabled = true) {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; data: LaunchList } | null>(null);
  const [revision, setRevision] = useState(0);
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
    void apiFetch(`/api/session-launch/requests?sessionId=${encodeURIComponent(sessionId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const data: LaunchList = await response.json();
        if (live && Array.isArray(data.requests)) setSnapshot({ sessionId, data });
      })
      .catch(() => {
        // A read cannot start work. Retain the last receipt during a disconnect.
      });
    const clear = () => {
      live = false;
      controller.abort();
      setSnapshot(null);
    };
    window.addEventListener(AUTH_LOST_EVENT, clear);
    return () => {
      live = false;
      controller.abort();
      window.removeEventListener(AUTH_LOST_EVENT, clear);
    };
  }, [sessionId, enabled, revision, refresh]);
  return {
    ...(enabled && snapshot !== null && snapshot.sessionId === sessionId
      ? snapshot.data
      : { requests: [] }),
    refresh,
  };
}
