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
import { AppliedDelivery } from './applied-delivery.js';

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
  requireDurableBriefings?: boolean;
}

const MAX_PENDING_SENDS = 100;
const CONNECTION_POST_TIMEOUT_MS = 10_000;
const LIVENESS_PROBE_INTERVAL_MS = 10_000;

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
  private foregroundProbe: { nonce: string; resumeSessions: boolean; cancel: () => void } | null =
    null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private probeCounter = 0;
  private lastStreamActivity = 0;
  private listener: ConnectionListener | null = null;
  private seqBySession = new Map<string, number>();
  private replayingSessions = new Set<string>();
  private replaySeenSeq = new Map<string, number>();
  private pendingSnapshots = new Map<string, { cursor: number; afterSeq: number }>();
  /** Events applied while a transcript restore is unacknowledged. */
  private unacknowledgedSeq = new Map<string, Set<number>>();
  private appliedAckChain: Promise<unknown> = Promise.resolve();
  private appliedDelivery = new AppliedDelivery({
    getCursor: (sessionId) => this.getLastSeq(sessionId),
    setCursor: (sessionId, seq) => this.seqBySession.set(sessionId, seq),
    deliver: (event) => this.listener?.(event),
    ackEvent: (sessionId, seq) =>
      this.sendAppliedAck('session-event-applied', {
        type: 'session_event_applied',
        sessionId,
        seq,
      }),
    ackSnapshot: (sessionId, cursor, offerId) =>
      this.sendSnapshotAck({
        type: 'reconnect_snapshot_applied',
        sessionId,
        cursor,
        offerId,
      }),
    resync: () => this.checkAndReconnect(true),
  });
  private switchIntent: Record<string, unknown> | null = null;
  private pendingSends: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authProbe: Promise<void> | null = null;
  private authBlocked = false;
  private boundOnVisibility: (() => void) | null = null;
  private boundOnPageShow: ((e: PageTransitionEvent) => void) | null = null;
  private boundOnPageHide: (() => void) | null = null;
  private config: Required<Omit<SseConnectionConfig, 'outboxStorage' | 'requireDurableBriefings'>> &
    Pick<SseConnectionConfig, 'outboxStorage' | 'requireDurableBriefings'>;

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
      requireDurableBriefings: config.requireDurableBriefings,
      headers: (): Record<string, string> =>
        this._connectionId ? { 'X-Connection-ID': this._connectionId } : {},
      notify: (event) => {
        // The store synchronously tracks an accepted session while selecting it.
        // Capture transport ownership first: local selection does not attach a
        // headerless send to the stream that welcomed during HTTP delivery.
        const acceptedSessionId =
          event.type === '_send_accepted' && typeof event.sessionId === 'string'
            ? event.sessionId
            : undefined;
        const needsReplay =
          acceptedSessionId !== undefined && !this.seqBySession.has(acceptedSessionId);
        this.listener?.(event);
        if (acceptedSessionId !== undefined && needsReplay) {
          if (!this.seqBySession.has(acceptedSessionId))
            this.seqBySession.set(acceptedSessionId, 0);
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
      },
    });
  }

  connect(): void {
    if (!this.authBlocked) this.outbox.start();
    this.doConnect();
    this.addBrowserListeners();
  }

  disconnect(): void {
    this.foregroundProbe?.cancel();
    this.appliedDelivery.clearPending();
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
    this._connectionId = null;
    this.appliedAckChain = Promise.resolve();
  }

  blockAuthentication(): void {
    this.authBlocked = true;
  }

  invalidateAuthentication(): void {
    this.handleAuthLoss(false);
  }

  restoreAuthentication(): void {
    this.authBlocked = false;
    this.startLivenessChecks();
    this.checkAndReconnect(true);
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
    if (this.authBlocked) return false;
    if (msg.type === 'send') return this.outbox.enqueue(msg, this.sendScope);
    const endpoint = this.messageTypeToEndpoint(msg.type as string);
    if (!endpoint) return false;
    if (endpoint === 'switch') this.switchIntent = msg;

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

  setRecoverySession(sessionId: string | null): void {
    this.switchIntent = { type: 'switch_session', sessionId };
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

  commitTranscriptCursor(sessionId: string, cursor: number): void {
    this.appliedDelivery.commitTranscript(sessionId, cursor);
  }

  getLastSeq(sessionId: string): number {
    return this.seqBySession.get(sessionId) ?? 0;
  }

  acknowledgeReconnectSnapshot(sessionId: string, cursor: number, offerId?: string): void {
    if (offerId) {
      if (this._connectionId)
        this.appliedDelivery.acknowledgeSnapshot(sessionId, cursor, offerId, this._connectionId);
      return;
    }
    const pending = this.pendingSnapshots.get(sessionId);
    if (!pending || pending.cursor !== cursor) return;
    this.seqBySession.set(sessionId, Math.max(cursor, pending.afterSeq));
    this.pendingSnapshots.delete(sessionId);
    this.unacknowledgedSeq.delete(sessionId);
    this.appliedDelivery.clearSession(sessionId);
  }

  clearSession(sessionId: string): void {
    this.seqBySession.delete(sessionId);
    this.replayingSessions.delete(sessionId);
    this.replaySeenSeq.delete(sessionId);
    this.pendingSnapshots.delete(sessionId);
    this.unacknowledgedSeq.delete(sessionId);
    this.appliedDelivery.clearSession(sessionId);
  }

  private sendAppliedAck(endpoint: string, body: Record<string, unknown>): void {
    const connectionId = this._connectionId;
    if (!connectionId) return;
    this.appliedAckChain = this.appliedAckChain
      .then(async () => {
        if (this._connectionId !== connectionId) return;
        const response = await this.postConnectionRequest(
          endpoint,
          body,
          connectionId,
          async (response) => response,
        );
        if (!response.ok) throw new Error('Applied event acknowledgement failed');
      })
      .catch(() => {
        // A failed ACK leaves the server cursor behind. Reconnect advertises
        // the locally applied cursor and releases any later queued ACKs.
        if (this._connectionId === connectionId) this.checkAndReconnect(true);
      });
  }

  private sendSnapshotAck(body: Record<string, unknown>): Promise<boolean> {
    const connectionId = this._connectionId;
    if (!connectionId) return Promise.resolve(false);
    // A snapshot is an authoritative prefix, fenced by its exact offer and
    // connection. The server rejects event ACKs while that offer is pending
    // and ignores older sequence numbers after confirmation. Waiting behind
    // unrelated event ACKs adds their network latency to foreground recovery.
    return this.postConnectionRequest(
      'reconnect-snapshot-applied',
      body,
      connectionId,
      async (response) => {
        if (!response.ok) return false;
        const result = (await response.json()) as { applied?: unknown };
        return result.applied === true;
      },
    )
      .then((applied) => applied && this._connectionId === connectionId)
      .catch(() => false);
  }

  private async postConnectionRequest<T>(
    endpoint: string,
    body: Record<string, unknown>,
    connectionId: string,
    readResponse: (response: Response) => Promise<T>,
  ): Promise<T> {
    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.config
          .fetch(`${this.config.baseUrl}/api/chat/${endpoint}`, {
            method: 'POST',
            signal: abort.signal,
            headers: { 'Content-Type': 'application/json', 'X-Connection-ID': connectionId },
            body: JSON.stringify(body),
            ...(endpoint === 'suspend' ? { keepalive: true } : {}),
          })
          .then(readResponse),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            abort.abort();
            reject(new Error('Connection request timed out'));
          }, CONNECTION_POST_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  // Navigation discards stale controls, not submitted prompts. Scope prevents
  // pending prompts in a different draft from inheriting an earlier receipt.
  clearPendingSends(): void {
    this.sendScope++;
    this.pendingSends = [];
    this.switchIntent = null;
  }

  getTrackedSessions(): string[] {
    return Array.from(this.seqBySession.keys());
  }

  /**
   * Signal the server that this client is about to be backgrounded.
   * Uses an authenticated keepalive POST while connected, or sendBeacon
   * when the stream is disconnected. Suspend is a best-effort lifecycle hint;
   * foreground reconnect restores sessions even if the hint was not delivered.
   */
  sendSuspend(): void {
    if (this.seqBySession.size === 0) return;

    const sessions = Array.from(this.seqBySession.entries()).map(([sessionId, lastSeq]) => ({
      sessionId,
      lastSeq,
    }));

    // Keep authentication headers on native iOS, where beacon cannot add them.
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
    if (this.authBlocked) return;
    if (!force && this._connected) return;
    if (force) this.outbox.start();
    this.foregroundProbe?.cancel();
    if (this.reconnectTimer) return;
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    const wasConnected = this._connected;
    this._connectionId = null;
    this.appliedAckChain = Promise.resolve();
    this._connected = false;
    if (wasConnected) {
      this.listener?.({ type: '_close' });
    }
    this.doConnect();
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private doConnect(): void {
    if (this.authBlocked) return;
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

      this.lastStreamActivity = Date.now();
      this._connectionId = msg.connectionId as string;
      // An unresponsive ACK from the previous transport must not fence this one.
      this.appliedAckChain = Promise.resolve();
      this.appliedDelivery.clearPending();

      // A delivered welcome proves connectivity, even while replay is pending.
      // Saved prompts retain their independent, acknowledged HTTP delivery.
      this.outbox.wake();

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

      this.lastStreamActivity = Date.now();
      if (msg.type === 'auth_expired') {
        this.handleAuthLoss();
        return;
      }

      if (msg.type === '_probe') {
        if (this.foregroundProbe && msg.nonce === this.foregroundProbe.nonce) {
          const resumeSessions = this.foregroundProbe.resumeSessions;
          this.foregroundProbe.cancel();
          this.outbox.wake();
          // Backgrounding suspended the sessions even if the stream survived.
          if (resumeSessions && this._connectionId && this.seqBySession.size)
            void this.doReconnectPost(this._connectionId, es);
        }
        return;
      }

      if (
        msg.type === 'session_reconnect_snapshot' &&
        typeof msg.sessionId === 'string' &&
        typeof msg.offerId === 'string' &&
        typeof msg.cursor === 'number' &&
        this._connectionId
      ) {
        this.replayingSessions.delete(msg.sessionId);
        this.replaySeenSeq.delete(msg.sessionId);
        this.appliedDelivery.offerSnapshot(
          msg.sessionId,
          msg.cursor,
          msg.offerId,
          this._connectionId,
        );
        try {
          if (this.listener?.(msg) === false) this.checkAndReconnect(true);
        } catch {
          this.checkAndReconnect(true);
        }
        return;
      }
      // Older servers finish replay without an authoritative snapshot.
      const completedReplaySessions =
        msg.type === 'reconnected'
          ? [...this.replayingSessions]
          : msg.type === 'session_resumed' && typeof msg.sessionId === 'string'
            ? [msg.sessionId]
            : [];
      for (const sessionId of completedReplaySessions) {
        this.replayingSessions.delete(sessionId);
        this.replaySeenSeq.delete(sessionId);
        // Keep chained delivery fenced until its authoritative snapshot.
      }
      if (msg.type === 'session_reconnect_snapshot' && typeof msg.sessionId === 'string')
        this.appliedDelivery.releaseReplay(msg.sessionId);
      if (
        typeof msg.sessionId === 'string' &&
        this.replayingSessions.has(msg.sessionId) &&
        typeof msg.prevSessionSeq === 'number'
      )
        this.appliedDelivery.holdReplay(msg.sessionId);
      // A legacy server may sequence a live takeover. Only a takeover received
      // within this session's reconnect replay boundary is historical.
      if (msg.type === 'session_takeover' && typeof msg.sessionId === 'string')
        msg.replayed = typeof msg.seq === 'number' && this.replayingSessions.has(msg.sessionId);
      if (this.appliedDelivery.receive(msg)) return;

      const sequencedSessionId =
        typeof msg.seq === 'number' &&
        Number.isSafeInteger(msg.seq) &&
        typeof msg.sessionId === 'string'
          ? msg.sessionId
          : undefined;
      const applied = sequencedSessionId
        ? this.unacknowledgedSeq.get(sequencedSessionId)
        : undefined;
      const duplicate = applied?.has(msg.seq as number) ?? false;

      if (
        msg.type === 'session_reconnect_snapshot' &&
        typeof msg.sessionId === 'string' &&
        typeof msg.cursor === 'number' &&
        Number.isSafeInteger(msg.cursor) &&
        msg.cursor >= 0
      ) {
        this.replayingSessions.delete(msg.sessionId);
        const seen = this.replaySeenSeq.get(msg.sessionId) ?? 0;
        this.replaySeenSeq.delete(msg.sessionId);
        this.pendingSnapshots.set(msg.sessionId, {
          cursor: msg.cursor,
          afterSeq: seen > msg.cursor ? seen : 0,
        });
      }

      if (duplicate) return;
      try {
        if (this.listener?.(msg) === false) {
          this.checkAndReconnect(true);
          return;
        }
      } catch {
        this.checkAndReconnect(true);
        return;
      }

      // Legacy unchained envelopes retain their historical void-listener
      // compatibility, but an explicit reducer refusal must not move any
      // delivery or replay cursor.
      if (sequencedSessionId) {
        if (this.replayingSessions.has(sequencedSessionId)) {
          this.replaySeenSeq.set(
            sequencedSessionId,
            Math.max(this.replaySeenSeq.get(sequencedSessionId) ?? 0, msg.seq as number),
          );
        } else {
          const pending = this.pendingSnapshots.get(sequencedSessionId);
          if (pending) pending.afterSeq = Math.max(pending.afterSeq, msg.seq as number);
          else
            this.seqBySession.set(
              sequencedSessionId,
              Math.max(this.getLastSeq(sequencedSessionId), msg.seq as number),
            );
        }
      }
      if (applied && sequencedSessionId) applied.add(msg.seq as number);
    };

    es.onerror = () => {
      if (this.es !== es) return;
      // EventSource auto-reconnects on error. We only need to update
      // our state and notify the listener.
      if (this._connected) {
        this._connected = false;
        this.listener?.({ type: '_close' });
      }
      this.probeAuthAfterStreamError(es);
    };

    // EventSource fires 'open' when the connection is established,
    // but we wait for the 'welcome' event before marking as connected.
  }

  private probeAuthAfterStreamError(es: EventSource): void {
    if (this.authProbe) return;
    this.authProbe = this.config
      .fetch(`${this.config.baseUrl}/api/auth/check`, { method: 'GET' })
      .then((response) => {
        if (this.es === es && response.status === 401) this.handleAuthLoss();
      })
      .catch(() => {
        // A network error is not proof of auth loss; EventSource may keep retrying.
      })
      .finally(() => {
        this.authProbe = null;
      });
  }

  private handleAuthLoss(notify = true): void {
    this.authBlocked = true;
    this.stopLivenessChecks();
    this.appliedDelivery.clearPending();
    this.foregroundProbe?.cancel();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.es?.close();
    this.es = null;
    this._connectionId = null;
    this._connected = false;
    this.clearPendingSends();
    this.outbox.rejectAll('Authentication expired. Sign in again to retry.');
    if (notify) this.listener?.({ type: '_auth_lost' });
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
    // This exact request owns only these sessions, even if navigation changes
    // the tracked set while its response is in flight.
    const sessions = Array.from(this.seqBySession.entries()).map(([sessionId, lastSeq]) => ({
      sessionId,
      lastSeq,
    }));
    for (const { sessionId } of sessions) {
      this.replayingSessions.add(sessionId);
      this.replaySeenSeq.delete(sessionId);
      this.pendingSnapshots.delete(sessionId);
      if (!this.unacknowledgedSeq.has(sessionId)) this.unacknowledgedSeq.set(sessionId, new Set());
    }
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
            supportsAppliedCursor: true,
            sessions,
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
        this.flushPendingSends(new Set(sessions.map(({ sessionId }) => sessionId)));
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
    this._connectionId = null;
    this.appliedAckChain = Promise.resolve();
    // Background recovery belongs to the next foreground transition. Replaying
    // suspend against a successor would incorrectly suspend the resumed owner.
    if (globalThis.document?.visibilityState === 'hidden') return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (globalThis.document?.visibilityState !== 'hidden') this.doConnect();
    }, this.config.reconnectDelayMs);
  }

  private async doPost(endpoint: string, body: Record<string, unknown>): Promise<void> {
    const connectionId = this._connectionId;
    const es = this.es;
    const sendScope = this.sendScope;
    if (!connectionId) return;
    const current = () =>
      !this.authBlocked && this.es === es && this._connectionId === connectionId;
    const visible = () =>
      current() &&
      this.sendScope === sendScope &&
      (endpoint !== 'switch' || this.switchIntent === body);
    const transportFailure = (error: string) => {
      // Lifecycle failures must never enter the terminal provider-error reducer.
      if (visible())
        this.listener?.({
          type: '_control_error',
          operation: endpoint,
          ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
          error,
        });
    };
    const scope =
      typeof body.sessionId === 'string' && body.sessionId ? { sessionId: body.sessionId } : {};
    const control = ['stop', 'interrupt', 'close'].includes(endpoint) ? endpoint : undefined;
    const controlFailure = (error: string, code?: string, clientMsgId?: string) => {
      if (!control || !scope.sessionId) return false;
      this.listener?.({
        type: 'session_control_rejected',
        ...scope,
        control,
        error,
        ...(code !== undefined ? { code } : {}),
        ...(clientMsgId !== undefined ? { clientMsgId } : {}),
      });
      return true;
    };
    try {
      const { res, rejected } = await this.postConnectionRequest(
        endpoint,
        body,
        connectionId,
        async (res) => {
          let rejected: Record<string, unknown> | undefined;
          if (!res.ok && endpoint !== 'suspend') {
            try {
              rejected = await res.json();
            } catch {
              /* A status alone cannot prove expiry. */
            }
          }
          return { res, rejected };
        },
      );
      if (!res.ok) {
        // Background hints recover on foreground and never become chat errors.
        if (endpoint === 'suspend') return;
        if (!control && !visible()) return;
        const expired =
          res.status === 404 &&
          (rejected?.code === 'connection_expired' ||
            rejected?.error === 'Connection not registered' ||
            rejected?.error === 'No SSE stream for this connection');
        if (res.status === 401 && current()) {
          this.handleAuthLoss();
          return;
        }
        if (expired && current()) this.scheduleReconnect();
        if (expired && !control && endpoint !== 'permission') return;
        if (control && scope.sessionId) {
          let error = `Could not ${endpoint} (${res.status}). Please retry.`;
          let code: string | undefined;
          let clientMsgId: string | undefined;
          try {
            if (
              rejected?.type === 'session_control_rejected' &&
              rejected.sessionId === scope.sessionId &&
              rejected.control === control &&
              typeof rejected.error === 'string'
            ) {
              error = rejected.error;
              if (typeof rejected.code === 'string') code = rejected.code;
              if (typeof body.clientMsgId === 'string' && rejected.clientMsgId === body.clientMsgId)
                clientMsgId = body.clientMsgId;
            }
          } catch {
            // A lost or unreadable response cannot confirm cancellation.
          }
          controlFailure(error, code, clientMsgId);
          return;
        }
        if (endpoint === 'permission' && typeof body.permId === 'string') {
          try {
            if (
              rejected?.type === 'permission_response_rejected' &&
              rejected.permId === body.permId &&
              rejected.sessionId === scope.sessionId &&
              typeof rejected.error === 'string'
            ) {
              this.listener?.({
                type: 'permission_response_rejected',
                ...scope,
                permId: body.permId,
                error: rejected.error,
                ...(Array.isArray(rejected.pendingPermissions)
                  ? { pendingPermissions: rejected.pendingPermissions }
                  : {}),
              });
              return;
            }
          } catch {
            // An unreadable response cannot authoritatively clear a pending card.
          }
          this.listener?.({
            type: 'permission_response_rejected',
            ...scope,
            permId: body.permId,
            error: `Could not submit the permission response (${res.status}). Review the prompt and try again.`,
          });
          return;
        }
        transportFailure(`Could not ${endpoint} (${res.status}). Please retry.`);
      }
    } catch {
      // A late beacon or retry could suspend the resumed foreground owner.
      if (endpoint === 'suspend') return;
      if (!control && !visible()) return;
      if (current()) this.scheduleReconnect();
      if (endpoint === 'switch') return;
      if (controlFailure(`Could not ${endpoint}. Please retry.`)) return;
      if (endpoint === 'permission' && typeof body.permId === 'string')
        this.listener?.({
          type: 'permission_response_rejected',
          ...scope,
          permId: body.permId,
          error: 'Could not submit the permission response. Review the prompt and try again.',
        });
      else transportFailure(`Could not ${endpoint}. Please retry.`);
    }
  }

  private flushPendingSends(reconnectedSessions: ReadonlySet<string> = new Set()): void {
    const toFlush = this.pendingSends.filter(({ endpoint }) => endpoint !== 'switch');
    if (this.switchIntent) {
      const selection = { ...this.switchIntent };
      // Preserve a newly opened chat's REST boundary if it was absent from the
      // replay request. For covered chats, resetting would invalidate its offer.
      if (typeof selection.sessionId === 'string' && reconnectedSessions.has(selection.sessionId))
        delete selection.historyCursor;
      this.switchIntent = selection;
      toFlush.unshift({ endpoint: 'switch', body: selection });
    }
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

  private startLivenessChecks(): void {
    if (this.livenessTimer || this.authBlocked || typeof globalThis.document === 'undefined')
      return;
    // Comment heartbeats are invisible to EventSource. Verify the complete
    // POST → server → SSE path even when the visible tab never changes focus.
    this.livenessTimer = setInterval(() => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - this.lastStreamActivity >= LIVENESS_PROBE_INTERVAL_MS
      )
        this.probeForeground(false);
    }, LIVENESS_PROBE_INTERVAL_MS);
  }

  private stopLivenessChecks(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
  }

  private probeForeground(resumeSessions = true): void {
    if (!this._connected || !this.es || !this._connectionId) {
      this.checkAndReconnect();
      return;
    }
    if (this.foregroundProbe) {
      this.foregroundProbe.resumeSessions ||= resumeSessions;
      return;
    }
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
    this.foregroundProbe = { nonce, resumeSessions, cancel };
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
    if (typeof globalThis.document === 'undefined' || this.boundOnVisibility) return;
    this.startLivenessChecks();

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
    this.stopLivenessChecks();
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
