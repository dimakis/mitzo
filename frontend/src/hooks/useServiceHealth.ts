// SSE-driven service health with REST polling fallback.
// iOS WebKit can't establish SSE over self-signed HTTPS, so we poll /api/service-health too.

import { useState, useEffect, useMemo } from 'react';
import { eventBus } from '../lib/event-bus-singleton';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../lib/api-fetch';
import { readApiJson } from '../lib/api-json-read';
import { APP_FOREGROUND_EVENT } from '../lib/app-lifecycle-events';
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

const subscribers = new Set<(payload: ServiceHealthPayload) => void>();
let stopHealth: (() => void) | null = null;

/** A single fallback belongs to all mounted consumers, including voice controls. */
function subscribeHealth(subscriber: (payload: ServiceHealthPayload) => void): () => void {
  subscribers.add(subscriber);
  if (!stopHealth) {
    let active = true;
    let receivedSse = false;
    let blocked = false;
    let pending: AbortController | null = null;
    const cancelRead = () => {
      pending?.abort();
      pending = null;
    };
    const publish = (data: ServiceHealthPayload) => {
      if (!active || blocked || !Array.isArray(data.services)) return;
      subscribers.forEach((listener) => listener(data));
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      } catch {
        /* Quota unavailable. */
      }
    };
    const poll = async (nativeForeground = false) => {
      if (
        !active ||
        blocked ||
        receivedSse ||
        pending ||
        (!nativeForeground && document.visibilityState !== 'visible')
      )
        return;
      const controller = new AbortController();
      pending = controller;
      try {
        const data = await readApiJson<ServiceHealthPayload>(
          '/api/service-health',
          controller.signal,
        );
        // A later SSE event is more current than an already-started fallback.
        if (!controller.signal.aborted && !receivedSse) publish(data);
      } catch {
        /* Retain the last observed health while the server is unreachable. */
      } finally {
        if (pending === controller) pending = null;
      }
    };
    const health = eventBus.on('health', (data) => {
      receivedSse = true;
      cancelRead();
      publish(data as ServiceHealthPayload);
    });
    const connection = eventBus.onConnectionChange((connected) => {
      if (!connected) {
        receivedSse = false;
        void poll();
      }
    });
    const visible = () => {
      if (document.visibilityState === 'visible') void poll();
      else cancelRead();
    };
    const foreground = () => void poll(true);
    const lost = () => {
      blocked = true;
      cancelRead();
    };
    const restored = () => {
      blocked = false;
      receivedSse = false;
      void poll();
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener(APP_FOREGROUND_EVENT, foreground);
    window.addEventListener(AUTH_LOST_EVENT, lost);
    window.addEventListener(AUTH_RESTORED_EVENT, restored);
    const startup = setTimeout(() => void poll(), SSE_FALLBACK_DELAY_MS);
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    stopHealth = () => {
      active = false;
      cancelRead();
      clearTimeout(startup);
      clearInterval(timer);
      health();
      connection();
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener(APP_FOREGROUND_EVENT, foreground);
      window.removeEventListener(AUTH_LOST_EVENT, lost);
      window.removeEventListener(AUTH_RESTORED_EVENT, restored);
    };
  }
  return () => {
    subscribers.delete(subscriber);
    if (!subscribers.size) {
      stopHealth?.();
      stopHealth = null;
    }
  };
}

export function useServiceHealth(): UseServiceHealthReturn {
  const [payload, setPayload] = useState<ServiceHealthPayload>(getCachedHealth);
  useEffect(() => subscribeHealth(setPayload), []);

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
