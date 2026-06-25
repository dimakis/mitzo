/**
 * SseConnection — SSE + HTTP POST transport for the v2 protocol.
 *
 * Drop-in replacement for MitzoConnection. Same public interface, different
 * wire transport:
 *   - Server→client: EventSource (SSE) on GET /api/chat/events
 *   - Client→server: fetch POST to /api/chat/{send,stop,interrupt,...}
 *
 * Eliminates the iOS WebSocket reconnection bug class. EventSource auto-
 * reconnects natively — no heartbeat hack, no readyState staleness, no
 * silent kills without onclose firing.
 *
 * The server runs both transports in parallel during the migration period.
 */

import type { ConnectionListener } from './connection.js';
import type { ChatConnection } from './chat-connection.js';

export interface SseConnectionConfig {
  /** Base URL for API endpoints (e.g. "https://host:3100"). No trailing slash. */
  baseUrl: string;
  /** fetch implementation — allows the store to inject apiFetch with auth headers. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Factory for EventSource — allows injection for testing. */
  createEventSource?: (url: string) => EventSource;
  reconnectDelayMs?: number;
  /** URL for the sendBeacon suspend fallback. */
  suspendUrl?: string;
}

const MAX_PENDING_SENDS = 100;
const MAX_SEND_RETRIES = 3;

interface PendingSend {
  endpoint: string;
  body: Record<string, unknown>;
  retries: number;
}

export class SseConnection implements ChatConnection {
  private es: EventSource | null = null;
  private _connectionId: string | null = null;
  private _connected = false;
  private _isReconnect = false;
  private listener: ConnectionListener | null = null;
  private seqBySession = new Map<string, number>();
  private pendingSends: PendingSend[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private boundOnVisibility: (() => void) | null = null;
  private boundOnPageShow: ((e: PageTransitionEvent) => void) | null = null;
  private boundOnPageHide: (() => void) | null = null;
  private config: Required<SseConnectionConfig>;

  constructor(config: SseConnectionConfig) {
    this.config = {
      createEventSource: (url: string) => new EventSource(url),
      reconnectDelayMs: 500,
      suspendUrl: '',
      ...config,
    };
  }

  connect(): void {
    this.doConnect();
    this.addBrowserListeners();
  }

  disconnect(): void {
    this.removeBrowserListeners();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this._connected = false;
  }

  /**
   * Send a message to the server via HTTP POST.
   *
   * Maps message types to REST endpoints:
   *   { type: 'send', ... }      → POST /api/chat/send
   *   { type: 'stop', ... }      → POST /api/chat/stop
   *   { type: 'interrupt', ... } → POST /api/chat/interrupt
   *   etc.
   *
   * Returns true if the message was sent or queued, false if not connected
   * and not reconnecting.
   */
  send(msg: Record<string, unknown>): boolean {
    const endpoint = this.messageTypeToEndpoint(msg.type as string);
    if (!endpoint) return false;

    if (this._connected && this._connectionId) {
      this.doPost(endpoint, msg);
      return true;
    }

    // Queue if reconnecting
    if (this.reconnectTimer || this.es) {
      this.enqueuePending(endpoint, msg);
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

  clearPendingSends(): void {
    this.pendingSends = [];
  }

  getTrackedSessions(): string[] {
    return Array.from(this.seqBySession.keys());
  }

  /**
   * Signal the server that this client is about to be backgrounded.
   * Uses fetch POST first; falls back to sendBeacon.
   */
  sendSuspend(): void {
    if (this.seqBySession.size === 0) return;

    const sessions = Array.from(this.seqBySession.entries()).map(([sessionId, lastSeq]) => ({
      sessionId,
      lastSeq,
    }));

    // Try POST first
    if (this._connected && this._connectionId) {
      this.doPost('suspend', { type: 'session_suspend', sessions });
      return;
    }

    // sendBeacon fallback
    if (
      this.config.suspendUrl &&
      this._connectionId &&
      typeof globalThis.navigator?.sendBeacon === 'function'
    ) {
      const payload = JSON.stringify({ connectionId: this._connectionId, sessions });
      globalThis.navigator.sendBeacon(
        this.config.suspendUrl,
        new Blob([payload], { type: 'application/json' }),
      );
    }
  }

  /**
   * Force reconnect — close existing EventSource and reconnect.
   * Unlike WS, EventSource reconnects automatically, but force=true
   * tears down and rebuilds for iOS Capacitor lifecycle hooks.
   */
  checkAndReconnect(force = false): void {
    if (!force && this._connected) return;
    if (this.reconnectTimer) return;
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    const wasConnected = this._connected;
    this._connected = false;
    if (wasConnected) {
      this.listener?.({ type: '_close' });
    }
    this.doConnect();
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private doConnect(): void {
    if (this.es) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Always use the base URL — reconnect sessions are sent via POST in the
    // welcome handler. This avoids the bug where EventSource auto-reconnect
    // reuses the original URL (missing ?sessions=), and eliminates double
    // handleReconnect when doConnect() AND welcome both trigger it.
    const url = `${this.config.baseUrl}/api/chat/events`;

    const es = this.config.createEventSource(url);
    this.es = es;

    // Welcome event — server sends connectionId
    es.addEventListener('welcome', (e: MessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this._connectionId = msg.connectionId as string;

      // _connected deferred until doReconnectPost succeeds — prevents
      // external send() from bypassing the pending queue mid-reconnect.
      // Capture both connectionId and ES instance for the staleness guard.
      const welcomeConnectionId = this._connectionId;
      const welcomeEs = this.es;
      if (this._isReconnect && this.seqBySession.size > 0) {
        this.doReconnectPost(welcomeConnectionId, welcomeEs);
      } else {
        this._connected = true;
        this.flushPendingSends();
        this.listener?.({ type: '_open' });
      }
      this._isReconnect = true;
    });

    // Catch-all for session events. Server sends all non-welcome events as
    // `event: message`, so es.onmessage handles everything — no allowlist needed.
    es.onmessage = (e: MessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      if (typeof msg.seq === 'number' && typeof msg.sessionId === 'string') {
        this.seqBySession.set(msg.sessionId as string, msg.seq as number);
      }

      this.listener?.(msg);
    };

    es.onerror = () => {
      // EventSource auto-reconnects on error. We only need to update
      // our state and notify the listener.
      if (this._connected) {
        this._connected = false;
        this.listener?.({ type: '_close' });
      }
    };

    // EventSource fires 'open' when the connection is established,
    // but we wait for the 'welcome' event before marking as connected.
  }

  /**
   * Send the reconnect POST and only mark connected on success.
   *
   * On failure the client stays disconnected — the next EventSource
   * auto-reconnect will trigger a fresh welcome + retry. This prevents
   * flushing pending sends into the void when the server never ran
   * handleReconnect (no watch, no reattach, no replay).
   */
  private async doReconnectPost(
    welcomeConnectionId: string,
    welcomeEs: EventSource | null,
  ): Promise<void> {
    try {
      const res = await this.config.fetch(`${this.config.baseUrl}/api/chat/reconnect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Connection-ID': welcomeConnectionId,
        },
        body: JSON.stringify({
          type: 'reconnect',
          sessions: Array.from(this.seqBySession.entries()).map(([sessionId, lastSeq]) => ({
            sessionId,
            lastSeq,
          })),
        }),
      });

      // Guard: bail if disconnect() was called, a newer welcome arrived,
      // or checkAndReconnect replaced the EventSource while in-flight.
      if (!this.es || this.es !== welcomeEs || this._connectionId !== welcomeConnectionId) return;

      if (res.ok) {
        this._connected = true;
        this.flushPendingSends();
        this.listener?.({ type: '_open' });
      } else {
        console.warn('[SseConnection] reconnect POST returned', res.status);
        this.scheduleReconnect();
      }
    } catch (err) {
      if (!this.es || this.es !== welcomeEs || this._connectionId !== welcomeConnectionId) return;
      console.warn('[SseConnection] reconnect POST failed', err);
      this.scheduleReconnect();
    }
  }

  /** Tear down and reconnect after a delay to avoid tight retry loops. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.config.reconnectDelayMs);
  }

  private async doPost(
    endpoint: string,
    body: Record<string, unknown>,
    retries = 0,
  ): Promise<void> {
    if (!this._connectionId) return;
    try {
      const res = await this.config.fetch(`${this.config.baseUrl}/api/chat/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Connection-ID': this._connectionId,
        },
        body: JSON.stringify(body),
      });
      if (
        !res.ok &&
        endpoint === 'send' &&
        (res.status === 404 || res.status === 429 || res.status >= 500)
      ) {
        // Transient failure (404 = stale connectionId, 429 = rate limited,
        // 5xx = server error). Re-queue so it flushes on the next successful
        // reconnect. Non-transient errors (400 = invalid body) are not retried.
        console.warn(`[SseConnection] POST /${endpoint} returned ${res.status}, re-queuing`);
        this.enqueuePending(endpoint, body, retries + 1);
      }
    } catch {
      if (endpoint === 'send') {
        // Network error — re-queue for retry after reconnect.
        console.warn(`[SseConnection] POST /${endpoint} failed, re-queuing`);
        this.enqueuePending(endpoint, body, retries + 1);
      }
      // Non-send POST failures (stop, interrupt, etc.) are non-fatal.
    }
  }

  private async flushPendingSends(): Promise<void> {
    if (this.pendingSends.length === 0) return;
    const toFlush = this.pendingSends;
    this.pendingSends = [];
    // Sequential to preserve message ordering after reconnect.
    for (const { endpoint, body, retries } of toFlush) {
      await this.doPost(endpoint, body, retries);
    }
  }

  /** Enqueue a pending send with the same MAX_PENDING_SENDS cap as send(). */
  private enqueuePending(endpoint: string, body: Record<string, unknown>, retries = 0): void {
    if (retries >= MAX_SEND_RETRIES) {
      console.warn(`[SseConnection] dropping /${endpoint} after ${retries} retries`);
      return;
    }
    if (this.pendingSends.length >= MAX_PENDING_SENDS) {
      this.pendingSends.shift();
    }
    this.pendingSends.push({ endpoint, body, retries });
  }

  /**
   * Map v2 message types to REST endpoint names.
   * Returns null for unknown types.
   */
  private messageTypeToEndpoint(type: string): string | null {
    switch (type) {
      case 'send':
        return 'send';
      case 'stop':
        return 'stop';
      case 'interrupt':
        return 'interrupt';
      case 'permission_response':
        return 'permission';
      case 'set_mode':
        return 'mode';
      case 'watch':
        return 'watch';
      case 'unwatch':
        return 'unwatch';
      case 'switch_session':
        return 'switch';
      case 'session_suspend':
        return 'suspend';
      case 'session_close':
        return 'close';
      case 'reconnect':
        return 'reconnect';
      default:
        return null;
    }
  }

  // ─── Browser lifecycle ─────────────────────────────────────────────────────

  private addBrowserListeners(): void {
    if (typeof globalThis.document === 'undefined') return;

    this.boundOnVisibility = () => {
      if (document.visibilityState === 'visible') {
        this.checkAndReconnect();
        this.listener?.({ type: '_foreground' });
      } else if (document.visibilityState === 'hidden') {
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
}
