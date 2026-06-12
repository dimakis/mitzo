// Per-connection SSE stream registry for chat events (distinct from broadcast SseRegistry).

import type { Response } from 'express';
import { createLogger } from './logger.js';

const log = createLogger('session-sse');

const HEARTBEAT_INTERVAL_MS = 30_000; // 30s — keeps connection alive through proxies

export class SessionSseRegistry {
  private streams = new Map<string, Response>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Register an SSE response stream for a connection.
   */
  add(connectionId: string, res: Response): void {
    // Close any existing stream for this connection (e.g. stale reconnect)
    const existing = this.streams.get(connectionId);
    if (existing) {
      try {
        existing.end();
      } catch {
        // best effort
      }
    }

    this.streams.set(connectionId, res);
    log.info('SSE chat stream connected', { connectionId, total: this.streams.size });

    if (this.streams.size === 1) {
      this.startHeartbeat();
    }
  }

  /**
   * Remove and clean up an SSE stream.
   */
  remove(connectionId: string): void {
    if (!this.streams.has(connectionId)) return;
    this.streams.delete(connectionId);
    log.info('SSE chat stream disconnected', { connectionId, total: this.streams.size });

    if (this.streams.size === 0) {
      this.stopHeartbeat();
    }
  }

  /**
   * Send an SSE event to a specific connection.
   * Returns false if the connection doesn't exist or the write fails.
   *
   * @param connectionId - The connection to send to
   * @param data - Event payload (JSON-serialized)
   * @param id - Optional SSE `id:` field (EventStore seq number for replay)
   */
  sendTo(connectionId: string, data: Record<string, unknown>, id?: string | number): boolean {
    const res = this.streams.get(connectionId);
    if (!res) return false;

    try {
      const eventType = (data.type as string) || 'message';
      let frame = '';
      if (id !== undefined) {
        frame += `id: ${id}\n`;
      }
      frame += `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
      res.write(frame);
      return true;
    } catch (err) {
      log.warn('SSE chat sendTo failed', { connectionId, error: String(err) });
      this.remove(connectionId);
      return false;
    }
  }

  /**
   * Check if a connection has an open SSE stream.
   */
  isOpen(connectionId: string): boolean {
    const res = this.streams.get(connectionId);
    if (!res) return false;
    return !res.writableEnded;
  }

  get size(): number {
    return this.streams.size;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    log.info('Starting SSE chat heartbeat', { intervalMs: HEARTBEAT_INTERVAL_MS });
    this.heartbeatTimer = setInterval(() => {
      const failures: string[] = [];
      for (const [connectionId, res] of this.streams) {
        try {
          res.write(':heartbeat\n\n');
        } catch {
          failures.push(connectionId);
        }
      }
      for (const id of failures) {
        this.remove(id);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    log.info('Stopping SSE chat heartbeat');
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  destroy(): void {
    log.info('Destroying SessionSseRegistry', { streams: this.streams.size });
    this.stopHeartbeat();

    for (const [, res] of this.streams) {
      try {
        res.end();
      } catch {
        // best effort
      }
    }
    this.streams.clear();
  }
}
