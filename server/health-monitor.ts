// Periodic health monitor for upstream services (Yapper, ContexGin).
// Broadcasts a `health` SSE event when status changes.

import type { SseRegistry } from '@mitzo/harness';
import type { ServiceHealthPayload, ServiceHealthStatus } from '@mitzo/protocol';
import { createLogger } from './logger.js';

const log = createLogger('health-monitor');

const POLL_INTERVAL_MS = 30_000;
const CHECK_TIMEOUT_MS = 3_000;

interface ServiceCheck {
  name: string;
  url: string;
  parseDetail?: (data: unknown) => Record<string, unknown> | undefined;
}

const SERVICES: ServiceCheck[] = [
  {
    name: 'yapper',
    url: process.env.YAPPER_PROXY_TARGET || 'http://localhost:8700',
    parseDetail: (data) => {
      const d = data as { models?: { stt?: boolean; tts?: boolean } };
      return d.models ? { stt: !!d.models.stt, tts: !!d.models.tts } : undefined;
    },
  },
  {
    name: 'contexgin',
    url: process.env.CONTEXGIN_URL || 'http://localhost:8321',
  },
];

export class HealthMonitor {
  private sseRegistry: SseRegistry;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPayload: ServiceHealthPayload | null = null;

  constructor(sseRegistry: SseRegistry) {
    this.sseRegistry = sseRegistry;
  }

  start(): void {
    if (this.timer) return;
    log.info('Starting health monitor', { intervalMs: POLL_INTERVAL_MS });
    // Initial check immediately
    this.check();
    this.timer = setInterval(() => this.check(), POLL_INTERVAL_MS);
  }

  getSnapshot(): ServiceHealthPayload {
    return this.lastPayload ?? { services: [], checkedAt: 0 };
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info('Health monitor destroyed');
  }

  private async check(): Promise<void> {
    const results = await Promise.all(SERVICES.map((s) => this.checkService(s)));
    const payload: ServiceHealthPayload = {
      services: results,
      checkedAt: Date.now(),
    };

    if (this.hasChanged(payload)) {
      log.info('Service health changed', {
        services: results.map((s) => `${s.name}=${s.ok ? 'ok' : 'down'}`).join(', '),
      });
      this.lastPayload = payload;
      this.sseRegistry.broadcast('health', payload);
    } else {
      this.lastPayload = payload;
    }
  }

  private async checkService(service: ServiceCheck): Promise<ServiceHealthStatus> {
    try {
      const res = await fetch(`${service.url}/health`, {
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (!res.ok) return { name: service.name, ok: false };

      const data = await res.json();
      const isReady = data.status === 'ready' || data.status === 'ok' || data.status === 'healthy';
      return {
        name: service.name,
        ok: isReady,
        detail: service.parseDetail?.(data),
      };
    } catch {
      return { name: service.name, ok: false };
    }
  }

  private hasChanged(next: ServiceHealthPayload): boolean {
    if (!this.lastPayload) return true;
    const prev = this.lastPayload.services;
    if (prev.length !== next.services.length) return true;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i].ok !== next.services[i].ok) return true;
      if (JSON.stringify(prev[i].detail) !== JSON.stringify(next.services[i].detail)) return true;
    }
    return false;
  }
}
