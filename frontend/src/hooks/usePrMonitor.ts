import { useCallback, useEffect, useRef, useState } from 'react';
import type { PrMonitorInventory } from '@mitzo/protocol';
import { apiFetch, AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../lib/api-fetch';
import { eventBus } from '../lib/event-bus-singleton';
import { changePrMonitor, readPrMonitors } from '../lib/pr-monitor-api';

/** Mounted view reads only retained state. The backend owns observation scheduling. */
export function usePrMonitor(sessionId: string) {
  const [data, setData] = useState<PrMonitorInventory | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const current = useRef<AbortController | null>(null);
  const mutating = useRef(false);
  const authBlocked = useRef(false);

  const refresh = useCallback(async () => {
    if (mutating.current || authBlocked.current) return;
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setBusy(true);
    const timeout = setTimeout(() => {
      controller.abort();
      if (current.current === controller) {
        setBusy(false);
        setError('PR status timed out. Retained evidence may be stale.');
      }
    }, 15000);
    try {
      const result = await readPrMonitors(sessionId, controller.signal);
      if (controller.signal.aborted || current.current !== controller) return;
      setData(result);
      setCheckedAt(Date.now());
      setNow(Date.now());
      setError('');
    } catch (cause) {
      if (!controller.signal.aborted && current.current === controller)
        setError(cause instanceof Error ? cause.message : 'PR status is unavailable.');
    } finally {
      clearTimeout(timeout);
      if (current.current === controller) setBusy(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    const invalidate = () => {
      current.current?.abort();
      current.current = null;
      mutating.current = false;
      authBlocked.current = true;
      setData(null);
      setBusy(false);
      setCheckedAt(0);
      setError('Sign in and refresh PR status. Authentication changed.');
    };
    const restored = () => {
      invalidate();
      authBlocked.current = false;
    };
    const disconnected = () => {
      // Observation can continue on the host; this browser has no current proof.
      setCheckedAt(0);
      setError('Disconnected. Retained evidence may be stale. Reconnect and refresh PR status.');
      if (!mutating.current) {
        current.current?.abort();
        setBusy(false);
      }
    };
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const unsubscribe = eventBus.onConnectionChange((connected) =>
      connected ? void refresh() : disconnected(),
    );
    const clock = setInterval(() => setNow(Date.now()), 5000);
    window.addEventListener(AUTH_LOST_EVENT, invalidate);
    window.addEventListener(AUTH_RESTORED_EVENT, restored);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', disconnected);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      current.current?.abort();
      current.current = null;
      clearInterval(clock);
      unsubscribe();
      window.removeEventListener(AUTH_LOST_EVENT, invalidate);
      window.removeEventListener(AUTH_RESTORED_EVENT, restored);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', disconnected);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);

  const change = async (path: string, body: object, passphrase?: string): Promise<boolean> => {
    if (mutating.current || authBlocked.current) return false;
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    mutating.current = true;
    setBusy(true);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          let csrf: string | undefined;
          if (passphrase !== undefined) {
            const response = await apiFetch('/api/connections/reauthorize', {
              method: 'POST',
              signal: controller.signal,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ passphrase }),
            });
            if (!response.ok) throw Error('Reauthorization failed');
            const proof = await response.json();
            if (typeof proof.csrf !== 'string' || proof.expiresAt <= Date.now())
              throw Error('Reauthorization expired');
            csrf = proof.csrf;
          }
          if (controller.signal.aborted || current.current !== controller) throw Error('Retired');
          await changePrMonitor(
            sessionId,
            path,
            { ...body, ...(csrf ? { csrf } : {}) },
            controller.signal,
          );
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(Error('Timed out'));
          }, 15000);
        }),
      ]);
      if (controller.signal.aborted || current.current !== controller) return false;
      mutating.current = false;
      await refresh();
      return true;
    } catch {
      if (current.current === controller)
        setError('Change not confirmed. Refresh PR status to check retained evidence.');
      return false;
    } finally {
      clearTimeout(timeout);
      if (current.current === controller) {
        mutating.current = false;
        setBusy(false);
      }
    }
  };
  return { data, error, busy, refresh, change, now, stale: !checkedAt || now - checkedAt > 30000 };
}
