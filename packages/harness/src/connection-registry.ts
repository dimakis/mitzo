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
 * - Periodic sync retries events beyond cursor (handles WS races, iOS kills)
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

/** Event store interface for periodic sync — injected to avoid circular deps */
export interface EventStoreAdapter {
  getEventsAfter(
    sessionId: string,
    afterSeq: number,
    limit?: number,
  ): Array<{
    seq: number;
    payload: Record<string, unknown>;
  }>;
}

// Periodic sync fires every 5s to retry missed events
const SYNC_INTERVAL_MS = 5000;
// Limit events per sync round per connection to avoid overwhelming slow clients
const SYNC_BATCH_LIMIT = 50;

export class ConnectionRegistry {
  private connections = new Map<string, Connection>();
  // Per-connection per-session cursors: last successfully delivered seq
  private cursors = new Map<string, Map<string, number>>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private eventStore: EventStoreAdapter | null = null;

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

  /**
   * Set the EventStore adapter for periodic sync.
   * Must be called before starting periodic sync.
   */
  setEventStore(eventStore: EventStoreAdapter): void {
    this.eventStore = eventStore;
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
   * so periodic sync can retry failures.
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
        // Cursor not updated → periodic sync will retry
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
   * Start periodic sync — retries missed events for all connections.
   * Runs every SYNC_INTERVAL_MS, bounded by SYNC_BATCH_LIMIT per connection.
   * Call this once during server startup after setEventStore().
   */
  startPeriodicSync(): void {
    if (this.syncTimer) {
      log.warn('periodic sync already running');
      return;
    }
    if (!this.eventStore) {
      log.error('cannot start periodic sync: EventStore not set');
      return;
    }

    log.info('starting periodic sync', { intervalMs: SYNC_INTERVAL_MS });

    this.syncTimer = setInterval(() => {
      if (!this.eventStore) return;

      for (const [connectionId, conn] of this.connections.entries()) {
        if (!conn.transport.isOpen()) continue;

        const connCursors = this.cursors.get(connectionId);
        if (!connCursors) continue;

        for (const sessionId of conn.watchedSessions) {
          const cursor = connCursors.get(sessionId) ?? 0;

          // Fetch missed events from EventStore
          let missedEvents: Array<{ seq: number; payload: Record<string, unknown> }>;
          try {
            missedEvents = this.eventStore.getEventsAfter(sessionId, cursor, SYNC_BATCH_LIMIT);
          } catch (err) {
            log.warn('periodic sync: EventStore fetch failed', {
              connectionId,
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
            continue;
          }

          if (missedEvents.length === 0) continue;

          log.info('periodic sync: retrying missed events', {
            connectionId,
            sessionId,
            cursor,
            missedCount: missedEvents.length,
          });

          // Retry delivery
          for (const evt of missedEvents) {
            try {
              conn.transport.send({ ...evt.payload, seq: evt.seq });
              // Update cursor on success
              const current = connCursors.get(sessionId) ?? 0;
              if (evt.seq > current) {
                connCursors.set(sessionId, evt.seq);
              }
            } catch {
              // Still failing — stop here, retry next sync round
              log.warn('periodic sync: retry failed, stopping batch', {
                connectionId,
                sessionId,
                failedSeq: evt.seq,
              });
              break;
            }
          }
        }
      }
    }, SYNC_INTERVAL_MS);
  }

  /**
   * Stop periodic sync and clean up timer. Call during graceful shutdown.
   */
  stopPeriodicSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
      log.info('periodic sync stopped');
    }
  }

  /**
   * Dispose: stop sync, clear all state. Used for graceful shutdown.
   */
  dispose(): void {
    this.stopPeriodicSync();
    this.connections.clear();
    this.cursors.clear();
  }
}
