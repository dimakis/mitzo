/**
 * MitzoConnection — single multiplexed WebSocket for the v2 protocol.
 *
 * Replaces the per-session WsPool. One WebSocket connection handles all
 * sessions via sessionId-tagged messages. Manages hello/welcome handshake,
 * reconnect with per-session seq replay, and pending send queue.
 */

import type { WebSocketLike } from './ws-connection.js';
import { WS_READY_STATE } from './types.js';

export interface MitzoConnectionConfig {
  buildUrl(): string;
  createWebSocket(url: string): WebSocketLike;
  reconnectDelayMs?: number;
}

export type ConnectionListener = (msg: Record<string, unknown>) => void;

const MAX_PENDING_SENDS = 100;

export class MitzoConnection {
  private ws: WebSocketLike | null = null;
  private _connectionId: string | null = null;
  private _connected = false;
  private _isReconnect = false;
  private listener: ConnectionListener | null = null;
  private seqBySession = new Map<string, number>();
  private pendingSends: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private config: Required<MitzoConnectionConfig>;

  constructor(config: MitzoConnectionConfig) {
    this.config = {
      reconnectDelayMs: 500,
      ...config,
    };
  }

  connect(): void {
    this.doConnect();
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  send(msg: Record<string, unknown>): boolean {
    const payload = JSON.stringify(msg);
    if (this._connected && this.ws?.readyState === WS_READY_STATE.OPEN) {
      this.ws.send(payload);
      return true;
    }
    if (
      this.ws?.readyState === WS_READY_STATE.CONNECTING ||
      this.reconnectTimer ||
      (this.ws?.readyState === WS_READY_STATE.OPEN && !this._connected)
    ) {
      if (this.pendingSends.length >= MAX_PENDING_SENDS) {
        this.pendingSends.shift();
      }
      this.pendingSends.push(payload);
      return true;
    }
    return false;
  }

  onMessage(listener: ConnectionListener): void {
    this.listener = listener;
  }

  isConnected(): boolean {
    return this._connected;
  }

  getConnectionId(): string | null {
    return this._connectionId;
  }

  trackSeq(sessionId: string, seq: number): void {
    this.seqBySession.set(sessionId, seq);
  }

  getLastSeq(sessionId: string): number {
    return this.seqBySession.get(sessionId) ?? 0;
  }

  clearSession(sessionId: string): void {
    this.seqBySession.delete(sessionId);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private doConnect(): void {
    if (
      this.ws?.readyState === WS_READY_STATE.OPEN ||
      this.ws?.readyState === WS_READY_STATE.CONNECTING
    ) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const url = this.config.buildUrl();
    const ws = this.config.createWebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2 }));
    };

    ws.onmessage = (e: { data: string }) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      if (msg.type === 'welcome') {
        this._connectionId = msg.connectionId as string;
        this._connected = true;

        if (this._isReconnect && this.seqBySession.size > 0) {
          const sessions = Array.from(this.seqBySession.entries()).map(([sessionId, lastSeq]) => ({
            sessionId,
            lastSeq,
          }));
          ws.send(JSON.stringify({ type: 'reconnect', sessions }));
        }
        this._isReconnect = true;

        this.flushPendingSends();
        this.listener?.({ type: '_open' });
        return;
      }

      // Track seq for reconnect replay
      if (typeof msg.seq === 'number' && typeof msg.sessionId === 'string') {
        this.seqBySession.set(msg.sessionId as string, msg.seq as number);
      }

      this.listener?.(msg);
    };

    ws.onclose = () => {
      this.ws = null;
      this._connected = false;
      this.listener?.({ type: '_close' });
      this.reconnectTimer = setTimeout(() => this.doConnect(), this.config.reconnectDelayMs);
    };

    ws.onerror = () => {
      // Intentionally empty — error events always precede close, and
      // reconnect is handled in onclose. Nothing actionable here.
    };
  }

  private flushPendingSends(): void {
    if (this.pendingSends.length === 0 || !this.ws) return;
    const toFlush = this.pendingSends;
    this.pendingSends = [];
    for (let i = 0; i < toFlush.length; i++) {
      try {
        this.ws.send(toFlush[i]);
      } catch {
        this.pendingSends.unshift(...toFlush.slice(i));
        break;
      }
    }
  }
}
