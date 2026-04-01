/**
 * Module-level WebSocket connection pool.
 *
 * Connections are keyed by session key ("session:<id>" or "new:<uid>").
 * They survive React component unmount/remount so navigating between
 * sessions does not kill in-flight agent runs.
 */

export type WsMsg = Record<string, unknown>;
export type MsgListener = (msg: WsMsg) => void;

const BUFFERABLE_TYPES = new Set([
  'text',
  'text_delta',
  'tool_call',
  'tool_result',
  'done',
  'error',
  'session_id',
  'session_info',
  'permission_request',
  'permission_timeout',
  'reattached',
  'reattach_failed',
  'mode_changed',
]);

export const MAX_BUFFER_SIZE = 500;

interface PoolEntry {
  ws: WebSocket | null;
  clientId: string | null;
  prevClientId: string | null;
  wasRunning: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  listeners: Set<MsgListener>;
  messageBuffer: WsMsg[];
}

const pool = new Map<string, PoolEntry>();

function broadcast(entry: PoolEntry, msg: WsMsg) {
  if (entry.listeners.size === 0) {
    if (BUFFERABLE_TYPES.has(msg.type as string)) {
      if (entry.messageBuffer.length < MAX_BUFFER_SIZE) {
        entry.messageBuffer.push(msg);
      }
    }
    return;
  }
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
      return;
    }

    if (msg.type === 'client_id') {
      // Save current as prev BEFORE overwriting — prev is what the server
      // knows us by and what we need to send in the reattach request.
      entry.prevClientId = entry.clientId;
      entry.clientId = msg.clientId as string;
      if (entry.wasRunning && entry.prevClientId) {
        ws.send(JSON.stringify({ type: 'reattach', clientId: entry.prevClientId }));
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
    }

    if (msg.type === 'done' || msg.type === 'error') {
      entry.wasRunning = false;
    }

    // When a new session gets assigned a sessionId, also register the
    // entry under "session:<id>" so navigating to /chat/:id finds it.
    const assignedId =
      (msg.type === 'session_id' || msg.type === 'done') && msg.sessionId
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
    entry.reconnectTimer = setTimeout(() => connectEntry(key, entry), 2000 + Math.random() * 2000);
  };

  ws.onerror = () => {};
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
}

function getOrCreate(key: string): PoolEntry {
  let entry = pool.get(key);
  if (!entry) {
    entry = {
      ws: null,
      clientId: null,
      prevClientId: null,
      wasRunning: false,
      reconnectTimer: null,
      listeners: new Set(),
      messageBuffer: [],
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

/** Drain and return all buffered messages, clearing the buffer. */
export function wsDrainBuffer(key: string): WsMsg[] {
  const entry = pool.get(key);
  if (!entry || entry.messageBuffer.length === 0) return [];
  const msgs = entry.messageBuffer.slice();
  entry.messageBuffer.length = 0;
  return msgs;
}
