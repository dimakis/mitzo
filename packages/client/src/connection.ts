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
  /** URL for the sendBeacon suspend fallback (POST /api/sessions/suspend). */
  suspendUrl?: string;
}

export type ConnectionListener = (msg: Record<string, unknown>) => void;

const MAX_PENDING_SENDS = 100;
const HEARTBEAT_INTERVAL_MS = 5_000;

export class MitzoConnection {
  private ws: WebSocketLike | null = null;
  private _connectionId: string | null = null;
  private _connected = false;
  private _isReconnect = false;
  private listener: ConnectionListener | null = null;
  private seqBySession = new Map<string, number>();
  private pendingSends: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private boundOnVisibility: (() => void) | null = null;
  private boundOnPageShow: ((e: PageTransitionEvent) => void) | null = null;
  private boundOnPageHide: (() => void) | null = null;
  private config: Required<MitzoConnectionConfig>;

  constructor(config: MitzoConnectionConfig) {
    this.config = {
      reconnectDelayMs: 500,
      suspendUrl: '',
      ...config,
    };
  }

  connect(): void {
    this.doConnect();
    this.startHeartbeat();
    this.addBrowserListeners();
  }

  disconnect(): void {
    this.stopHeartbeat();
    this.removeBrowserListeners();
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

  getTrackedSessions(): string[] {
    return Array.from(this.seqBySession.keys());
  }

  /**
   * Signal the server that this client is about to be backgrounded (iOS).
   * Sends via WS if open, and also fires sendBeacon as a belt-and-suspenders
   * fallback since iOS may kill the socket before the WS send completes.
   */
  sendSuspend(): void {
    if (this.seqBySession.size === 0) return;

    const sessions = Array.from(this.seqBySession.entries()).map(([sessionId, lastSeq]) => ({
      sessionId,
      lastSeq,
    }));

    const wsPayload = { type: 'session_suspend', sessions };

    // Try WS first (may already be dying)
    if (this.ws?.readyState === WS_READY_STATE.OPEN) {
      try {
        this.ws.send(JSON.stringify(wsPayload));
      } catch {
        // Socket may be transitioning — sendBeacon fallback below
      }
    }

    // sendBeacon fallback — works even after visibilitychange:hidden
    if (
      this.config.suspendUrl &&
      this._connectionId &&
      typeof globalThis.navigator?.sendBeacon === 'function'
    ) {
      const beaconPayload = JSON.stringify({
        connectionId: this._connectionId,
        sessions,
      });
      globalThis.navigator.sendBeacon(
        this.config.suspendUrl,
        new Blob([beaconPayload], { type: 'application/json' }),
      );
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Detach handlers from the old WS so its delayed onclose can't overwrite
   * `this.ws` / `this._connected` after a new WS has been created.
   */
  private defuseOldWs(): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws = null;
    }
  }

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

  // ─── iOS reconnect resilience ─────────────────────────────────────────────
  // iOS Safari silently kills WebSocket connections when the app is backgrounded
  // or the screen is locked. The onclose event may never fire. These listeners
  // detect when the app returns to the foreground and force a reconnect if the
  // socket is dead.

  private startHeartbeat(): void {
    if (typeof globalThis.setInterval === 'undefined') return;
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState !== WS_READY_STATE.OPEN && !this.reconnectTimer) {
        this.defuseOldWs();
        this._connected = false;
        this.listener?.({ type: '_close' });
        this.doConnect();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private addBrowserListeners(): void {
    if (typeof globalThis.document === 'undefined') return;

    this.boundOnVisibility = () => {
      if (document.visibilityState === 'visible') {
        this.checkAndReconnect();
        // Notify the store so it can re-hydrate messages if the page was
        // evicted from memory (iOS bfcache discard) and state was lost.
        this.listener?.({ type: '_foreground' });
      } else if (document.visibilityState === 'hidden') {
        // Proactive suspend: signal the server BEFORE iOS kills the WS
        this.sendSuspend();
      }
    };

    this.boundOnPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) this.checkAndReconnect();
    };

    this.boundOnPageHide = () => {
      this.sendSuspend();
    };

    document.addEventListener('visibilitychange', this.boundOnVisibility);
    globalThis.addEventListener('pageshow', this.boundOnPageShow);
    globalThis.addEventListener('pagehide', this.boundOnPageHide);
  }

  private removeBrowserListeners(): void {
    if (this.boundOnVisibility) {
      document.removeEventListener('visibilitychange', this.boundOnVisibility);
      this.boundOnVisibility = null;
    }
    if (this.boundOnPageShow) {
      globalThis.removeEventListener('pageshow', this.boundOnPageShow);
      this.boundOnPageShow = null;
    }
    if (this.boundOnPageHide) {
      globalThis.removeEventListener('pagehide', this.boundOnPageHide);
      this.boundOnPageHide = null;
    }
  }

  /** Force a reconnect check — call from native lifecycle hooks (e.g. Capacitor appStateChange). */
  checkAndReconnect(): void {
    if (!this.ws || this.ws.readyState !== WS_READY_STATE.OPEN) {
      if (this.reconnectTimer) return;
      this.defuseOldWs();
      this._connected = false;
      this.listener?.({ type: '_close' });
      this.doConnect();
    }
  }
}
