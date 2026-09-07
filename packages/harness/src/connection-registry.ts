/**
 * ConnectionRegistry — tracks WebSocket connections and their relationship
 * to sessions, separate from SessionRegistry which tracks SDK sessions.
 *
 * Each browser tab has one WS connection (connectionId). A connection can
 * watch multiple sessions (receiving events for each) and has one active
 * session (the session currently in the foreground for that tab).
 *
 * Part of the v2 single-WS protocol — replaces the per-session WsPool
 * model where each session had its own socket.
 *
 * Delivery Guarantee:
 * - Tracks per-connection per-session cursors (last delivered seq)
 * - broadcast() updates cursor on successful send
 * - Reconnect replays missed events via EventStore cursor on welcome
 * - Reconnect resets cursor to client's lastSeq to prevent duplicate replay
 */

import type { SessionTransport } from './session-transport.js';
import { createLogger } from './logger.js';

const log = createLogger('connection-registry');

export interface Connection {
  connectionId: string;
  transport: SessionTransport;
  watchedSessions: Set<string>;
  activeSession: string | null;
}

export class ConnectionRegistry {
  private connections = new Map<string, Connection>();
  // Per-connection per-session cursors: last successfully delivered seq
  private cursors = new Map<string, Map<string, number>>();

  register(connectionId: string, transport: SessionTransport): void {
    this.connections.set(connectionId, {
      connectionId,
      transport,
      watchedSessions: new Set(),
      activeSession: null,
    });
    // Initialize cursor map for this connection
    this.cursors.set(connectionId, new Map());
  }

  get(connectionId: string): Connection | undefined {
    return this.connections.get(connectionId);
  }

  remove(connectionId: string): void {
    this.connections.delete(connectionId);
    // Clean up cursors for this connection
    this.cursors.delete(connectionId);
  }

  watch(connectionId: string, sessionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    conn.watchedSessions.add(sessionId);
  }

  unwatch(connectionId: string, sessionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    conn.watchedSessions.delete(sessionId);
    if (conn.activeSession === sessionId) {
      conn.activeSession = null;
    }
  }

  setActive(connectionId: string, sessionId: string | null): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    if (sessionId) {
      conn.watchedSessions.add(sessionId);
    }
    conn.activeSession = sessionId;
  }

  /**
   * Get all connections watching a given session.
   * When filterOpen is true, only connections with an open transport are returned.
   */
  getConnectionsWatching(
    sessionId: string,
    filterOpen = false,
  ): Array<{ connectionId: string; transport: SessionTransport }> {
    const result: Array<{ connectionId: string; transport: SessionTransport }> = [];
    for (const conn of this.connections.values()) {
      if (!conn.watchedSessions.has(sessionId)) continue;
      if (filterOpen && !conn.transport.isOpen()) continue;
      result.push({ connectionId: conn.connectionId, transport: conn.transport });
    }
    return result;
  }

  /**
   * Check if at least one open connection is watching the given session.
   * Short-circuits on the first match — no array allocation.
   */
  hasOpenWatchers(sessionId: string): boolean {
    for (const conn of this.connections.values()) {
      if (conn.watchedSessions.has(sessionId) && conn.transport.isOpen()) return true;
    }
    return false;
  }

  /**
   * Send a message to all open connections watching a session.
   * Catches send errors to prevent one failing transport from
   * aborting the broadcast loop. Updates delivery cursor on success
   * so reconnect replay covers the correct range.
   */
  broadcast(sessionId: string, data: Record<string, unknown>): void {
    const seq = data.seq as number | undefined;
    for (const { connectionId, transport } of this.getConnectionsWatching(sessionId, true)) {
      try {
        transport.send(data);
        // Update cursor on successful delivery (if event has seq)
        if (seq !== undefined) {
          const connCursors = this.cursors.get(connectionId);
          if (connCursors) {
            const current = connCursors.get(sessionId) ?? 0;
            // Only advance cursor forward (handle out-of-order delivery)
            if (seq > current) {
              connCursors.set(sessionId, seq);
            }
          }
        }
      } catch {
        log.warn('broadcast send failed', { connectionId, sessionId, seq });
        // Cursor not updated — reconnect replay will cover the gap
      }
    }
  }

  /**
   * Send a message to every open connection regardless of watched sessions.
   * Used for global events (update_available, inbox_updated, task state).
   */
  broadcastAll(data: Record<string, unknown>): void {
    for (const conn of this.connections.values()) {
      if (!conn.transport.isOpen()) continue;
      try {
        conn.transport.send(data);
      } catch {
        log.warn('broadcastAll send failed', {
          connectionId: conn.connectionId,
        });
      }
    }
  }

  /**
   * Reset the cursor for a connection+session pair to the client's lastSeq.
   * Called on reconnect to sync cursor with client state and prevent
   * duplicate replay (EventStore handles the gap).
   */
  resetCursor(connectionId: string, sessionId: string, clientLastSeq: number): void {
    const connCursors = this.cursors.get(connectionId);
    if (!connCursors) return;
    connCursors.set(sessionId, clientLastSeq);
    log.info('cursor reset on reconnect', { connectionId, sessionId, cursor: clientLastSeq });
  }

  /**
   * Dispose: clear all state. Used for graceful shutdown.
   */
  dispose(): void {
    this.connections.clear();
    this.cursors.clear();
  }
}
