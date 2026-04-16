/**
 * WebSocket connection pool — transport-agnostic.
 *
 * Extracted from frontend/src/lib/ws-pool.ts. The key difference:
 * the WebSocket constructor and URL builder are injected, so this
 * works in both browser and Theia RPC environments.
 */

import type { WsMsg } from './server-messages.js';
import { WS_READY_STATE } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type MsgListener = (msg: WsMsg) => void;

export interface WsPoolConfig {
  /** Build the WebSocket URL from the pool key. */
  buildUrl(): string;

  /** WebSocket constructor — `new ctor(url)`. */
  createWebSocket(url: string): WebSocketLike;

  /** Delay before first reconnect attempt (ms). Default: 500 */
  reconnectDelayMs?: number;

  /** Interval for heartbeat reconnect polling (ms). Default: 5000 */
  reconnectPollMs?: number;
}

/** Minimal WebSocket interface — matches browser WebSocket. */
export interface WebSocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

/**
 * Cap on the number of payloads queued per pool entry while the socket is
 * unavailable. Sized generously enough to survive a short outage on mobile
 * without memory growth running away during a long one.
 */
const MAX_PENDING_SENDS = 100;

// ─── Pool entry ──────────────────────────────────────────────────────────────

interface PoolEntry {
  ws: WebSocketLike | null;
  clientId: string | null;
  prevClientId: string | null;
  wasRunning: boolean;
  lastSeq: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  listeners: Set<MsgListener>;
  /**
   * Messages issued via send() while the socket was still CONNECTING.
   * Flushed in-order once the socket transitions to OPEN. This covers the
   * new-session flow where the store subscribes and immediately tries to
   * send the first user prompt — without this queue the first send would
   * silently drop because readyState !== OPEN.
   */
  pendingSends: string[];
}

// ─── Pool ────────────────────────────────────────────────────────────────────

export class WsPool {
  private pool = new Map<string, PoolEntry>();
  private config: Required<WsPoolConfig>;
  private visibilityCleanup: (() => void) | null = null;

  constructor(config: WsPoolConfig) {
    this.config = {
      reconnectDelayMs: 500,
      reconnectPollMs: 5_000,
      ...config,
    };
  }

  /** Start listening for visibility/focus events to trigger reconnects. */
  startVisibilityMonitor(): void {
    if (typeof document === 'undefined') return;

    const reconnectAll = () => this.reconnectAll();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') reconnectAll();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', reconnectAll);
    window.addEventListener('focus', reconnectAll);

    const interval = setInterval(reconnectAll, this.config.reconnectPollMs);

    this.visibilityCleanup = () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', reconnectAll);
      window.removeEventListener('focus', reconnectAll);
    };
  }

  /** Stop visibility monitoring. */
  stopVisibilityMonitor(): void {
    this.visibilityCleanup?.();
    this.visibilityCleanup = null;
  }

  /** Subscribe to messages for a pool key. Returns unsubscribe function. */
  subscribe(key: string, listener: MsgListener): () => void {
    const entry = this.getOrCreate(key);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  /**
   * Send a message on the connection for this key.
   * If the socket is still CONNECTING (or closed with a reconnect pending),
   * the payload is queued and flushed in order once the socket opens.
   * Returns false only when there is no entry or the socket is already
   * closed/closing with no reconnect attempt queued.
   */
  send(key: string, msg: unknown): boolean {
    const entry = this.pool.get(key);
    if (!entry) return false;
    const payload = JSON.stringify(msg);
    const state = entry.ws?.readyState;
    if (state === WS_READY_STATE.OPEN && entry.ws) {
      entry.ws.send(payload);
      return true;
    }
    if (state === WS_READY_STATE.CONNECTING || entry.reconnectTimer) {
      // Bound the queue so a long outage doesn't grow memory without limit.
      // When we hit the cap we drop the oldest payload — matches the
      // "keep the most recent intent" preference users typically have on
      // mobile, and matches how the server's message buffer behaves.
      if (entry.pendingSends.length >= MAX_PENDING_SENDS) {
        entry.pendingSends.shift();
      }
      entry.pendingSends.push(payload);
      return true;
    }
    return false;
  }

  /** True if the connection for this key is currently open. */
  isOpen(key: string): boolean {
    const entry = this.pool.get(key);
    return entry?.ws?.readyState === WS_READY_STATE.OPEN;
  }

  /** Mark a session as running/not-running for reattach purposes. */
  setRunning(key: string, running: boolean): void {
    const entry = this.pool.get(key);
    if (entry) entry.wasRunning = running;
  }

  /** Remove a pool entry if idle (not running, no listeners). */
  removeIfIdle(key: string): boolean {
    const entry = this.pool.get(key);
    if (!entry) return false;
    if (entry.wasRunning || entry.listeners.size > 0) return false;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    if (entry.ws) {
      entry.ws.onclose = null;
      entry.ws.close();
    }
    this.pool.delete(key);
    return true;
  }

  /** Close all connections and clear the pool. */
  destroy(): void {
    this.stopVisibilityMonitor();
    for (const entry of this.pool.values()) {
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      if (entry.ws) {
        entry.ws.onclose = null;
        entry.ws.close();
      }
    }
    this.pool.clear();
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private broadcast(entry: PoolEntry, msg: WsMsg): void {
    entry.listeners.forEach((l) => l(msg));
  }

  private reconnectAll(): void {
    this.pool.forEach((entry, key) => {
      if (!entry.ws || entry.ws.readyState > WS_READY_STATE.OPEN) {
        this.connectEntry(key, entry);
      }
    });
  }

  private getOrCreate(key: string): PoolEntry {
    let entry = this.pool.get(key);
    if (!entry) {
      entry = {
        ws: null,
        clientId: null,
        prevClientId: null,
        wasRunning: false,
        lastSeq: 0,
        reconnectTimer: null,
        listeners: new Set(),
        pendingSends: [],
      };
      this.pool.set(key, entry);
      this.connectEntry(key, entry);
    }
    return entry;
  }

  private connectEntry(key: string, entry: PoolEntry): void {
    if (
      entry.ws?.readyState === WS_READY_STATE.OPEN ||
      entry.ws?.readyState === WS_READY_STATE.CONNECTING
    )
      return;

    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }

    const url = this.config.buildUrl();
    const ws = this.config.createWebSocket(url);
    entry.ws = ws;

    ws.onopen = () => {
      // Flush queued messages BEFORE broadcasting _open. Listeners react
      // to _open by marking connection='connected' and often by firing
      // follow-up sends of their own; if we broadcast first, those fresh
      // sends could interleave in front of the queued ones and change
      // the server-visible order. The flush is synchronous on the same
      // WebSocket, so once _open fans out the queued payloads have
      // already been written to the wire.
      //
      // Guard each send: if one throws (browser extension closing the
      // socket mid-flush, a misbehaving mock, etc.), we requeue the
      // remaining payloads onto pendingSends so the next reconnect picks
      // them up, and we still broadcast _open so listeners transition
      // into the connected state.
      if (entry.pendingSends.length > 0) {
        const toFlush = entry.pendingSends;
        entry.pendingSends = [];
        for (let i = 0; i < toFlush.length; i++) {
          try {
            ws.send(toFlush[i]);
          } catch {
            entry.pendingSends.unshift(...toFlush.slice(i));
            break;
          }
        }
      }
      this.broadcast(entry, { type: '_open' });
    };

    ws.onmessage = (e: { data: string }) => {
      let msg: WsMsg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }

      // Track lastSeq
      const msgAny = msg as unknown as Record<string, unknown>;
      if (typeof msgAny.seq === 'number') {
        entry.lastSeq = msgAny.seq as number;
      }

      if (msg.type === 'client_id') {
        entry.prevClientId = entry.clientId;
        entry.clientId = (msg as Record<string, unknown>).clientId as string;
        if (entry.wasRunning && entry.prevClientId) {
          ws.send(
            JSON.stringify({
              type: 'reattach',
              clientId: entry.prevClientId,
              lastSeq: entry.lastSeq,
            }),
          );
          return;
        }
        const sessionPrefix = 'session:';
        if (key.startsWith(sessionPrefix)) {
          const sessionId = key.slice(sessionPrefix.length);
          ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
          return;
        }
        this.broadcast(entry, { type: '_open' });
        return;
      }

      if (msg.type === 'reattached') {
        entry.wasRunning = true;
        this.broadcast(entry, { type: '_open' });
      }

      if (msg.type === 'reattach_failed') {
        entry.wasRunning = false;
        this.broadcast(entry, { type: '_open' });
      }

      if (msg.type === 'subscribed') {
        if ((msg as Record<string, unknown>).running) entry.wasRunning = true;
        this.broadcast(entry, { type: '_open' });
      }

      if (msg.type === 'session_end' || msg.type === 'error') {
        entry.wasRunning = false;
      }

      // Register session key alias
      const assignedId =
        (msg.type === 'session_id' || msg.type === 'session_end') &&
        (msg as Record<string, unknown>).sessionId
          ? ((msg as Record<string, unknown>).sessionId as string)
          : null;
      if (assignedId) {
        const sessionKey = `session:${assignedId}`;
        if (!this.pool.has(sessionKey)) {
          this.pool.set(sessionKey, entry);
        }
      }

      this.broadcast(entry, msg);
    };

    ws.onclose = () => {
      entry.ws = null;
      this.broadcast(entry, { type: '_close' });
      entry.reconnectTimer = setTimeout(
        () => this.connectEntry(key, entry),
        this.config.reconnectDelayMs,
      );
    };

    ws.onerror = () => {
      // Error events always precede close — reconnect handled in onclose
    };
  }
}
