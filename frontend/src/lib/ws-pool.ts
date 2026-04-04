/**
 * Module-level WebSocket connection pool.
 *
 * Connections are keyed by session key ("session:<id>" or "new:<uid>").
 * They survive React component unmount/remount so navigating between
 * sessions does not kill in-flight agent runs.
 */

import { WS_RECONNECT_DELAY_MS, WS_RECONNECT_POLL_MS } from './constants';
import type { ServerMessage } from '../types/ws-messages';

interface PoolOpenEvent {
  type: '_open';
}
interface PoolCloseEvent {
  type: '_close';
}

export type WsMsg = ServerMessage | PoolOpenEvent | PoolCloseEvent;
export type MsgListener = (msg: WsMsg) => void;

interface PoolEntry {
  ws: WebSocket | null;
  clientId: string | null;
  prevClientId: string | null;
  wasRunning: boolean;
  lastSeq: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  listeners: Set<MsgListener>;
}

const pool = new Map<string, PoolEntry>();

function broadcast(entry: PoolEntry, msg: WsMsg) {
  entry.listeners.forEach((l) => l(msg));
}

function connectEntry(key: string, entry: PoolEntry) {
  if (entry.ws?.readyState === WebSocket.OPEN || entry.ws?.readyState === WebSocket.CONNECTING)
    return;

  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/chat`);
  entry.ws = ws;

  ws.onopen = () => broadcast(entry, { type: '_open' });

  ws.onmessage = (e) => {
    let msg: WsMsg;
    try {
      msg = JSON.parse(e.data as string);
    } catch {
      return; // Malformed JSON from server — drop message
    }

    // Track lastSeq from any message that carries a seq field
    const msgAny = msg as unknown as Record<string, unknown>;
    if (typeof msgAny.seq === 'number') {
      entry.lastSeq = msgAny.seq as number;
    }

    if (msg.type === 'client_id') {
      // Save current as prev BEFORE overwriting — prev is what the server
      // knows us by and what we need to send in the reattach request.
      entry.prevClientId = entry.clientId;
      entry.clientId = msg.clientId as string;
      if (entry.wasRunning && entry.prevClientId) {
        ws.send(
          JSON.stringify({
            type: 'reattach',
            clientId: entry.prevClientId,
            lastSeq: entry.lastSeq,
          }),
        );
        return; // wait for reattach/reattach_failed before broadcasting _open
      }
      broadcast(entry, { type: '_open' });
      return;
    }

    if (msg.type === 'reattached') {
      entry.wasRunning = true;
      broadcast(entry, { type: '_open' }); // signal connected to component
    }

    if (msg.type === 'reattach_failed') {
      entry.wasRunning = false;
      // Signal that the connection is live even though reattach failed —
      // without this, the component never learns the WS is open.
      broadcast(entry, { type: '_open' });
    }

    if (msg.type === 'session_end' || msg.type === 'error') {
      entry.wasRunning = false;
    }

    // When a new session gets assigned a sessionId, also register the
    // entry under "session:<id>" so navigating to /chat/:id finds it.
    const assignedId =
      (msg.type === 'session_id' || msg.type === 'session_end') && msg.sessionId
        ? (msg.sessionId as string)
        : null;
    if (assignedId) {
      const sessionKey = `session:${assignedId}`;
      if (!pool.has(sessionKey)) {
        pool.set(sessionKey, entry);
      }
    }

    broadcast(entry, msg);
  };

  ws.onclose = () => {
    entry.ws = null;
    broadcast(entry, { type: '_close' });
    // First reconnect attempt immediately; subsequent attempts back off slightly
    entry.reconnectTimer = setTimeout(() => connectEntry(key, entry), WS_RECONNECT_DELAY_MS);
  };

  ws.onerror = () => {
    // Error events always precede close events — reconnect handled in onclose
  };
}

// Reconnect all idle pool entries when the app becomes visible/active.
// visibilitychange alone is unreliable in iOS Safari PWA mode — pageshow
// and focus are needed to cover app-switch and lock/unlock scenarios.
function reconnectAll() {
  pool.forEach((entry, key) => {
    if (!entry.ws || entry.ws.readyState > WebSocket.OPEN) {
      connectEntry(key, entry);
    }
  });
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconnectAll();
  });
  window.addEventListener('pageshow', reconnectAll);
  window.addEventListener('focus', reconnectAll);

  // Client-side heartbeat: check every 5s and reconnect immediately if any
  // connection is dead. Catches silent drops that never fire a close event
  // (common on iOS Safari PWA when switching apps or locking the screen).
  setInterval(reconnectAll, WS_RECONNECT_POLL_MS);
}

function getOrCreate(key: string): PoolEntry {
  let entry = pool.get(key);
  if (!entry) {
    entry = {
      ws: null,
      clientId: null,
      prevClientId: null,
      wasRunning: false,
      lastSeq: 0,
      reconnectTimer: null,
      listeners: new Set(),
    };
    pool.set(key, entry);
    connectEntry(key, entry);
  }
  return entry;
}

/** Subscribe to messages from the pool entry for this key.
 *  Returns an unsubscribe function — does NOT close the connection. */
export function wsSubscribe(key: string, listener: MsgListener): () => void {
  const entry = getOrCreate(key);
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

/** Send a message on the pool connection for this key. */
export function wsSend(key: string, msg: unknown): boolean {
  const entry = pool.get(key);
  if (entry?.ws?.readyState === WebSocket.OPEN) {
    entry.ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

/** True if the connection for this key is currently open. */
export function wsIsOpen(key: string): boolean {
  const entry = pool.get(key);
  return entry?.ws?.readyState === WebSocket.OPEN;
}

/** Mark a session as running/not-running for reattach purposes. */
export function wsSetRunning(key: string, running: boolean) {
  const entry = pool.get(key);
  if (entry) entry.wasRunning = running;
}

/**
 * Remove a pool entry if it is idle (not running, no listeners).
 * Closes the WebSocket, clears reconnect timers, and deletes the entry.
 * Running sessions are kept alive — the pool exists to survive unmounts.
 */
export function wsRemoveIfIdle(key: string): boolean {
  const entry = pool.get(key);
  if (!entry) return false;
  if (entry.wasRunning || entry.listeners.size > 0) return false;
  if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
  if (entry.ws) {
    entry.ws.onclose = null;
    entry.ws.close();
  }
  pool.delete(key);
  return true;
}
