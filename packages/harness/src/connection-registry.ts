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

  register(connectionId: string, transport: SessionTransport): void {
    this.connections.set(connectionId, {
      connectionId,
      transport,
      watchedSessions: new Set(),
      activeSession: null,
    });
  }

  get(connectionId: string): Connection | undefined {
    return this.connections.get(connectionId);
  }

  remove(connectionId: string): void {
    this.connections.delete(connectionId);
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
   * Send a message to all open connections watching a session.
   * Catches send errors to prevent one failing transport from
   * aborting the broadcast loop.
   */
  broadcast(sessionId: string, data: Record<string, unknown>): void {
    for (const conn of this.connections.values()) {
      if (!conn.watchedSessions.has(sessionId)) continue;
      if (!conn.transport.isOpen()) continue;
      try {
        conn.transport.send(data);
      } catch {
        log.warn('broadcast send failed', {
          connectionId: conn.connectionId,
          sessionId,
        });
      }
    }
  }
}
