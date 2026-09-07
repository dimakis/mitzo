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

import { SendOutbox } from './send-outbox.js';
import type { ConnectionListener } from './connection.js';
import type { ChatConnection } from './chat-connection.js';

export interface SseConnectionConfig {
  /** Base URL for API endpoints (e.g. "https://host:3100"). No trailing slash. */
  baseUrl: string;
  /** fetch implementation — allows the store to inject apiFetch with auth headers. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Factory for EventSource — allows injection for testing. */
  createEventSource?: (url: string) => EventSource;
  /** Builds the EventSource URL for each attempt so refreshed credentials are used. */
  buildEventUrl?: () => string;
  reconnectDelayMs?: number;
  /** URL for the sendBeacon suspend fallback. */
  suspendUrl?: string;
  outboxStorage?: Pick<Storage, 'getItem' | 'setItem'>;
}

const MAX_PENDING_SENDS = 100;

export class SseConnection implements ChatConnection {
  private es: EventSource | null = null;
  private _connectionId: string | null = null;
  private _connected = false;
  private sendScope = Date.now();
  private replayRequest: {
    es: EventSource | null;
    connectionId: string;
    dirty: boolean;
  } | null = null;
  private outbox: SendOutbox;
  private foregroundProbe: { nonce: string; cancel: () => void } | null = null;
  private probeCounter = 0;
  private listener: ConnectionListener | null = null;
  private seqBySession = new Map<string, number>();
  private pendingSends: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private boundOnVisibility: (() => void) | null = null;
  private boundOnPageShow: ((e: PageTransitionEvent) => void) | null = null;
  private boundOnPageHide: (() => void) | null = null;
  private config: Required<Omit<SseConnectionConfig, 'outboxStorage'>> &
    Pick<SseConnectionConfig, 'outboxStorage'>;

  constructor(config: SseConnectionConfig) {
    this.config = {
      createEventSource: (url: string) => new EventSource(url),
      buildEventUrl: () => `${config.baseUrl}/api/chat/events`,
      reconnectDelayMs: 500,
      suspendUrl: '',
      ...config,
    };
    this.outbox = new SendOutbox({
      url: `${config.baseUrl}/api/chat/send`,
      fetch: config.fetch,
      storage: config.outboxStorage,
      headers: (): Record<string, string> =>
        this._connectionId ? { 'X-Connection-ID': this._connectionId } : {},
      notify: (event) => {
        this.listener?.(event);
        if (event.type === '_send_accepted' && typeof event.sessionId === 'string') {
          const sessionId = event.sessionId as string;
          if (!this.seqBySession.has(sessionId)) {
            this.seqBySession.set(sessionId, 0);
            // Include acknowledgements arriving during the welcome replay too.
            if (
              this.es &&
              this._connectionId &&
              (this._connected ||
                (this.replayRequest?.es === this.es &&
                  this.replayRequest.connectionId === this._connectionId))
            )
              void this.doReconnectPost(this._connectionId, this.es);
          }
        }
      },
    });
  }

  connect(): void {
    this.outbox.start();
    this.doConnect();
    this.addBrowserListeners();
  }

  disconnect(): void {
    this.foregroundProbe?.cancel();
    this.outbox.stop();
    this.clearPendingSends();
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
   * Prompts enter the acknowledged outbox regardless of SSE readiness.
   * Control messages wait for replay readiness. False means the request
   * could not be queued; true is local acceptance, not server delivery.
   */
  send(msg: Record<string, unknown>): boolean {
    if (msg.type === 'send') return this.outbox.enqueue(msg, this.sendScope);
    const endpoint = this.messageTypeToEndpoint(msg.type as string);
    if (!endpoint) return false;

    if (this._connected && this._connectionId) {
      this.doPost(endpoint, msg);
      return true;
    }

    // Queue if reconnecting
    if (this.reconnectTimer || this.es) {
      if (this.pendingSends.length >= MAX_PENDING_SENDS) {
        this.pendingSends.shift();
      }
      this.pendingSends.push({ endpoint, body: msg });
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

  // Navigation discards stale controls, not submitted prompts. Scope prevents
  // pending prompts in a different draft from inheriting an earlier receipt.
  clearPendingSends(): void {
    this.sendScope++;
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
    if (force) this.outbox.start();
    this.foregroundProbe?.cancel();
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
    const url = this.config.buildEventUrl();

    const es = this.config.createEventSource(url);
    this.es = es;

    // Welcome event — server sends connectionId
    es.addEventListener('welcome', (e: MessageEvent) => {
      if (this.es !== es) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      this._connectionId = msg.connectionId as string;

      // Control messages wait for replay readiness. Prompt delivery uses
      // its independent HTTP outbox and never waits for this handshake.
      // Capture both connectionId and ES instance for the staleness guard.
      const welcomeConnectionId = this._connectionId;
      const welcomeEs = this.es;
      if (this.seqBySession.size > 0) {
        this.doReconnectPost(welcomeConnectionId, welcomeEs);
      } else {
        this._connected = true;
        this.flushPendingSends();
        this.listener?.({ type: '_open' });
      }
    });

    // Catch-all for session events. Server sends all non-welcome events as
    // `event: message`, so es.onmessage handles everything — no allowlist needed.
    es.onmessage = (e: MessageEvent) => {
      if (this.es !== es) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      if (msg.type === 'auth_expired') {
        this.handleAuthLoss();
        return;
      }

      if (msg.type === '_probe') {
        if (this.foregroundProbe && msg.nonce === this.foregroundProbe.nonce) {
          this.foregroundProbe.cancel();
          // Backgrounding suspended the sessions even if the stream survived.
          if (this._connectionId && this.seqBySession.size)
            void this.doReconnectPost(this._connectionId, es);
        }
        return;
      }

      if (typeof msg.seq === 'number' && typeof msg.sessionId === 'string') {
        this.seqBySession.set(msg.sessionId as string, msg.seq as number);
      }

      this.listener?.(msg);
    };

    es.onerror = () => {
      if (this.es !== es) return;
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

  private handleAuthLoss(): void {
    this.foregroundProbe?.cancel();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.es?.close();
    this.es = null;
    this._connected = false;
    this.pendingSends = [];
    this.outbox.rejectAll('Authentication expired. Sign in again to retry.');
    this.listener?.({ type: '_auth_lost' });
  }

  /**
   * Send the reconnect POST and only mark connected on success.
   *
   * On failure the client stays disconnected — the next EventSource
   * auto-reconnect will trigger a fresh welcome + retry. This prevents
   * flushing control messages before the server has run
   * handleReconnect (no watch, no reattach, no replay).
   */
  private async doReconnectPost(
    welcomeConnectionId: string,
    welcomeEs: EventSource | null,
  ): Promise<void> {
    if (
      this.replayRequest?.es === welcomeEs &&
      this.replayRequest.connectionId === welcomeConnectionId
    ) {
      this.replayRequest.dirty = true;
      return;
    }
    const request = { es: welcomeEs, connectionId: welcomeConnectionId, dirty: false };
    this.replayRequest = request;
    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        this.config.fetch(`${this.config.baseUrl}/api/chat/reconnect`, {
          method: 'POST',
          signal: abort.signal,
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
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            abort.abort();
            reject(new Error('Reconnect timed out'));
          }, 15000);
        }),
      ]);

      // Guard: bail if disconnect() was called, a newer welcome arrived,
      // or checkAndReconnect replaced the EventSource while in-flight.
      if (!this.es || this.es !== welcomeEs || this._connectionId !== welcomeConnectionId) return;

      if (res.ok) {
        if (request.dirty) return;
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
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.replayRequest === request) {
        this.replayRequest = null;
        if (
          request.dirty &&
          this.es &&
          this.es === welcomeEs &&
          this._connectionId === welcomeConnectionId
        )
          void this.doReconnectPost(welcomeConnectionId, welcomeEs);
      }
    }
  }

  /** Tear down and reconnect after a delay to avoid tight retry loops. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this._connected) {
      this._connected = false;
      this.listener?.({ type: '_close' });
    }
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.config.reconnectDelayMs);
  }

  private async doPost(endpoint: string, body: Record<string, unknown>): Promise<void> {
    if (!this._connectionId) return;
    const scope =
      typeof body.sessionId === 'string' && body.sessionId ? { sessionId: body.sessionId } : {};
    try {
      const res = await this.config.fetch(`${this.config.baseUrl}/api/chat/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Connection-ID': this._connectionId },
        body: JSON.stringify(body),
      });
      if (!res.ok)
        this.listener?.({
          type: 'error',
          ...scope,
          error: `Could not ${endpoint} (${res.status}). Please retry.`,
        });
    } catch {
      this.listener?.({ type: 'error', ...scope, error: `Could not ${endpoint}. Please retry.` });
    }
  }

  private flushPendingSends(): void {
    if (this.pendingSends.length === 0) return;
    const toFlush = this.pendingSends;
    this.pendingSends = [];
    for (const { endpoint, body } of toFlush) {
      this.doPost(endpoint, body);
    }
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

  private probeForeground(): void {
    if (!this._connected || !this.es || !this._connectionId) {
      this.checkAndReconnect();
      return;
    }
    if (this.foregroundProbe) return;
    const es = this.es;
    const connectionId = this._connectionId;
    const nonce = String(++this.probeCounter);
    const abort = new AbortController();
    const cancel = () => {
      clearTimeout(timer);
      abort.abort();
      if (this.foregroundProbe?.nonce === nonce) this.foregroundProbe = null;
    };
    const fail = () => {
      if (this.foregroundProbe?.nonce !== nonce) return;
      cancel();
      if (this.es === es && this._connectionId === connectionId) this.checkAndReconnect(true);
    };
    const timer = setTimeout(fail, 1000);
    this.foregroundProbe = { nonce, cancel };
    void this.config
      .fetch(`${this.config.baseUrl}/api/chat/probe`, {
        method: 'POST',
        signal: abort.signal,
        headers: { 'Content-Type': 'application/json', 'X-Connection-ID': connectionId },
        body: JSON.stringify({ nonce }),
      })
      .then((res) => {
        if (!res.ok) fail();
      }, fail);
  }

  private addBrowserListeners(): void {
    if (typeof globalThis.document === 'undefined') return;

    this.boundOnVisibility = () => {
      if (document.visibilityState === 'visible') {
        this.probeForeground();
        this.listener?.({ type: '_foreground' });
      } else if (document.visibilityState === 'hidden') {
        this.sendSuspend();
      }
    };

    this.boundOnPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) this.checkAndReconnect(true);
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
