// SSE-driven service health — replaces per-hook polling for Yapper/ContexGin.

import { useState, useEffect, useMemo } from 'react';
import { eventBus } from '../lib/event-bus-singleton';
import type { ServiceHealthPayload, ServiceHealthStatus } from '@mitzo/protocol';

export interface UseServiceHealthReturn {
  services: ServiceHealthStatus[];
  yapper: ServiceHealthStatus | null;
  contexgin: ServiceHealthStatus | null;
  checkedAt: number;
}

export function useServiceHealth(): UseServiceHealthReturn {
  const [payload, setPayload] = useState<ServiceHealthPayload>({ services: [], checkedAt: 0 });

  useEffect(() => {
    return eventBus.on('health', (data) => {
      setPayload(data as ServiceHealthPayload);
    });
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
