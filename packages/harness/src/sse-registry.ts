import type { Response } from 'express';
import { createLogger } from './logger.js';

const log = createLogger('sse');

const HEARTBEAT_INTERVAL_MS = 30_000; // 30s — keeps connection alive through proxies

export interface SseClient {
  id: string;
  res: Response;
}

export class SseRegistry {
  private clients = new Map<string, SseClient>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  add(id: string, res: Response): void {
    this.clients.set(id, { id, res });
    log.info('SSE client connected', { id, total: this.clients.size });

    if (this.clients.size === 1) {
      this.startHeartbeat();
    }
  }

  remove(id: string): void {
    if (!this.clients.has(id)) return;

    this.clients.delete(id);
    log.info('SSE client disconnected', { id, total: this.clients.size });

    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }
  }

  broadcast(event: string, data: unknown): void {
    if (this.clients.size === 0) return;

    const payload = this.formatEvent(event, data);
    let sent = 0;
    const failures: string[] = [];

    for (const [id, client] of this.clients) {
      try {
        client.res.write(payload);
        sent++;
      } catch (err) {
        failures.push(id);
        log.warn('SSE broadcast write failed', { id, event, error: String(err) });
      }
    }

    log.debug('SSE broadcast', { event, sent, failures: failures.length });

    // Clean up dead connections
    for (const id of failures) {
      this.remove(id);
    }
  }

  sendTo(clientId: string, event: string, data: unknown): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;

    const payload = this.formatEvent(event, data);
    try {
      client.res.write(payload);
      return true;
    } catch (err) {
      log.warn('SSE sendTo failed', { clientId, event, error: String(err) });
      this.remove(clientId);
      return false;
    }
  }

  get size(): number {
    return this.clients.size;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private formatEvent(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    log.info('Starting SSE heartbeat', { intervalMs: HEARTBEAT_INTERVAL_MS });
    this.heartbeatTimer = setInterval(() => {
      const payload = ':heartbeat\n\n'; // SSE comment line — ignored by EventSource
      for (const [, client] of this.clients) {
        try {
          client.res.write(payload);
        } catch {
          // Write failed — clean up dead connection immediately
          this.remove(client.id);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;

    log.info('Stopping SSE heartbeat');
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  destroy(): void {
    log.info('Destroying SSE registry', { clients: this.clients.size });
    this.stopHeartbeat();

    for (const [, client] of this.clients) {
      try {
        client.res.end();
      } catch {
        // Best effort
      }
    }

    this.clients.clear();
  }
}
