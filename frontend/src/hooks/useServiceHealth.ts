// SSE-driven service health with REST polling fallback.
// iOS WebKit can't establish SSE over self-signed HTTPS, so we poll /api/service-health too.

import { useState, useEffect, useMemo, useRef } from 'react';
import { eventBus } from '../lib/event-bus-singleton';
import { apiFetch } from '../lib/api-fetch';
import type { ServiceHealthPayload, ServiceHealthStatus } from '@mitzo/protocol';

const POLL_INTERVAL_MS = 30_000;

export interface UseServiceHealthReturn {
  services: ServiceHealthStatus[];
  yapper: ServiceHealthStatus | null;
  contexgin: ServiceHealthStatus | null;
  checkedAt: number;
}

export function useServiceHealth(): UseServiceHealthReturn {
  const [payload, setPayload] = useState<ServiceHealthPayload>({ services: [], checkedAt: 0 });
  const gotSseEvent = useRef(false);

  // SSE listener (primary — works on Chrome, may fail on iOS)
  useEffect(() => {
    return eventBus.on('health', (data) => {
      gotSseEvent.current = true;
      setPayload(data as ServiceHealthPayload);
    });
  }, []);

  // REST polling fallback — kicks in if SSE hasn't delivered after 5s
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await apiFetch('/api/service-health');
        if (res.ok && !cancelled) {
          const data = await res.json();
          setPayload(data as ServiceHealthPayload);
        }
      } catch {
        // ignore — server unreachable
      }
    };

    // Wait 5s, then check if SSE has delivered. If not, start polling.
    const startup = setTimeout(() => {
      if (cancelled) return;
      if (!gotSseEvent.current) {
        poll(); // immediate first poll
        timer = setInterval(poll, POLL_INTERVAL_MS);
      }
    }, 5_000);

    return () => {
      cancelled = true;
      clearTimeout(startup);
      if (timer) clearInterval(timer);
    };
  }, []);

  const yapper = useMemo(
    () => payload.services.find((s) => s.name === 'yapper') ?? null,
    [payload],
  );
  const contexgin = useMemo(
    () => payload.services.find((s) => s.name === 'contexgin') ?? null,
    [payload],
  );

  return { services: payload.services, yapper, contexgin, checkedAt: payload.checkedAt };
}
