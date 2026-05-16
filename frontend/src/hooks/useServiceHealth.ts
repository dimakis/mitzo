// SSE-driven service health with REST polling fallback.
// iOS WebKit can't establish SSE over self-signed HTTPS, so we poll /api/service-health too.

import { useState, useEffect, useMemo, useRef } from 'react';
import { eventBus } from '../lib/event-bus-singleton';
import { apiFetch } from '../lib/api-fetch';
import type { ServiceHealthPayload, ServiceHealthStatus } from '@mitzo/protocol';

const POLL_INTERVAL_MS = 30_000;
const SSE_FALLBACK_DELAY_MS = 2_000; // Reduced from 5s for faster iOS fallback
const CACHE_KEY = 'mitzo:service-health';

export interface UseServiceHealthReturn {
  services: ServiceHealthStatus[];
  yapper: ServiceHealthStatus | null;
  contexgin: ServiceHealthStatus | null;
  checkedAt: number;
}

// Load cached health on boot for instant mic button availability
function getCachedHealth(): ServiceHealthPayload {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      return JSON.parse(cached) as ServiceHealthPayload;
    }
  } catch {
    // ignore parse errors
  }
  return { services: [], checkedAt: 0 };
}

export function useServiceHealth(): UseServiceHealthReturn {
  const [payload, setPayload] = useState<ServiceHealthPayload>(getCachedHealth);
  const gotSseEvent = useRef(false);

  // SSE listener (primary — works on Chrome, may fail on iOS)
  useEffect(() => {
    return eventBus.on('health', (data) => {
      gotSseEvent.current = true;
      const healthData = data as ServiceHealthPayload;
      setPayload(healthData);
      // Cache for next session
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(healthData));
      } catch {
        // ignore quota errors
      }
    });
  }, []);

  // REST polling fallback — kicks in if SSE hasn't delivered after 2s
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await apiFetch('/api/service-health');
        if (res.ok && !cancelled) {
          const data = (await res.json()) as ServiceHealthPayload;
          setPayload(data);
          // Cache for next session
          try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(data));
          } catch {
            // ignore quota errors
          }
        }
      } catch {
        // ignore — server unreachable
      }
    };

    // Wait 2s, then check if SSE has delivered. If not, start polling.
    const startup = setTimeout(() => {
      if (cancelled) return;
      if (!gotSseEvent.current) {
        poll(); // immediate first poll
        timer = setInterval(poll, POLL_INTERVAL_MS);
      }
    }, SSE_FALLBACK_DELAY_MS);

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
