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
import { storedEventToClientMessage, type StoredEvent } from '@mitzo/protocol';

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
  ): Array<
    Pick<StoredEvent, 'seq' | 'payload'> &
      Partial<Pick<StoredEvent, 'sessionId' | 'type' | 'seatId' | 'symposiumProvenance'>> & {
        prevSessionSeq?: number;
      }
  >;
  /** Optional: check if a session is still active. When provided, periodic sync
   *  skips ended sessions to avoid unnecessary EventStore queries. */
  isSessionActive?(sessionId: string): boolean;
  getSessionPredecessorSeq?(sessionId: string, seq: number): number;
}

// Periodic sync fires every 5s to retry missed events
const SYNC_INTERVAL_MS = 5000;
// Limit events per sync round per connection to avoid overwhelming slow clients
const SYNC_BATCH_LIMIT = 50;

export class ConnectionRegistry {
  private connections = new Map<string, Connection>();
  // Per-connection per-session cursors: last successfully delivered seq
  private cursors = new Map<string, Map<string, number>>();
  // A successful write is not an application ACK. Track it separately only
  // to avoid rereading already-forwarded predecessors on every live delta.
  private forwarded = new Map<string, Map<string, number>>();
  private retryBoundaries = new Map<string, Map<string, number>>();
  private appliedSessions = new Map<string, Set<string>>();
  private snapshotOffers = new Map<string, Map<string, { cursor: number; offerId: string }>>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private eventStore: EventStoreAdapter | null = null;
  private readonly watchListeners = new Set<() => void>();
  /** Lifecycle observers can cancel controller approvals when a watch disappears. */
  onWatchChange(listener: () => void): () => void {
    this.watchListeners.add(listener);
    return () => this.watchListeners.delete(listener);
  }
  private notifyWatchChange() {
    for (const listener of this.watchListeners) listener();
  }

  register(connectionId: string, transport: SessionTransport): void {
    this.connections.set(connectionId, {
      connectionId,
      transport,
      watchedSessions: new Set(),
      activeSession: null,
    });
    // Initialize cursor map for this connection
    this.cursors.set(connectionId, new Map());
    this.forwarded.set(connectionId, new Map());
    this.retryBoundaries.set(connectionId, new Map());
    this.appliedSessions.set(connectionId, new Set());
    this.snapshotOffers.set(connectionId, new Map());
    this.notifyWatchChange();
  }

  get(connectionId: string): Connection | undefined {
    return this.connections.get(connectionId);
  }

  remove(connectionId: string): void {
    this.connections.delete(connectionId);
    // Clean up cursors for this connection
    this.cursors.delete(connectionId);
    this.forwarded.delete(connectionId);
    this.retryBoundaries.delete(connectionId);
    this.appliedSessions.delete(connectionId);
    this.snapshotOffers.delete(connectionId);
    this.notifyWatchChange();
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
    this.notifyWatchChange();
  }

  unwatch(connectionId: string, sessionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    conn.watchedSessions.delete(sessionId);
    this.forwarded.get(connectionId)?.delete(sessionId);
    this.retryBoundaries.get(connectionId)?.delete(sessionId);
    this.appliedSessions.get(connectionId)?.delete(sessionId);
    this.snapshotOffers.get(connectionId)?.delete(sessionId);
    if (conn.activeSession === sessionId) {
      conn.activeSession = null;
    }
    this.notifyWatchChange();
  }

  setActive(connectionId: string, sessionId: string | null): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    if (sessionId) {
      conn.watchedSessions.add(sessionId);
    }
    conn.activeSession = sessionId;
    this.notifyWatchChange();
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
    const outgoing = this.decorateSequencedEvent(sessionId, data);
    for (const { connectionId, transport } of this.getConnectionsWatching(sessionId, true)) {
      // The snapshot replaces this backlog. Resume durable delivery from its
      // confirmed cursor once the client has applied it.
      if (seq !== undefined && this.snapshotOffers.get(connectionId)?.has(sessionId)) continue;
      const pendingBoundary = this.retryBoundaries.get(connectionId)?.get(sessionId);
      if (seq !== undefined && pendingBoundary !== undefined && seq > pendingBoundary) continue;
      const previous = outgoing.prevSessionSeq;
      const forwarded = this.forwarded.get(connectionId)?.get(sessionId) ?? 0;
      if (
        this.appliedSessions.get(connectionId)?.has(sessionId) &&
        typeof previous === 'number' &&
        previous > forwarded
      ) {
        // Internal durable events need not have their own live broadcast.
        // Forward their redacted prefix now, rather than making the client
        // buffer the first response until the five-second retry interval.
        this.retryDelivery(connectionId, sessionId, forwarded);
        continue;
      }
      try {
        transport.send(outgoing);
        if (seq !== undefined)
          this.forwarded.get(connectionId)?.set(sessionId, Math.max(forwarded, seq));
        // Update cursor on successful delivery (if event has seq)
        if (seq !== undefined && !this.appliedSessions.get(connectionId)?.has(sessionId)) {
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
    this.retryBoundaries.get(connectionId)?.delete(sessionId);
    connCursors.set(sessionId, clientLastSeq);
    this.forwarded.get(connectionId)?.set(sessionId, clientLastSeq);
    log.info('cursor reset on reconnect', { connectionId, sessionId, cursor: clientLastSeq });
  }

  decorateSequencedEvent(
    sessionId: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const seq = data.seq;
    if (
      !Number.isSafeInteger(seq) ||
      (seq as number) < 0 ||
      !this.eventStore?.getSessionPredecessorSeq
    )
      return data;
    return {
      ...data,
      prevSessionSeq: this.eventStore.getSessionPredecessorSeq(sessionId, seq as number),
    };
  }

  enableAppliedCursor(connectionId: string, sessionId: string, appliedSeq: number): void {
    if (!this.connections.get(connectionId)?.watchedSessions.has(sessionId)) return;
    this.appliedSessions.get(connectionId)?.add(sessionId);
    this.snapshotOffers.get(connectionId)?.delete(sessionId);
    this.resetCursor(connectionId, sessionId, appliedSeq);
  }

  offerSnapshot(connectionId: string, sessionId: string, cursor: number, offerId: string): void {
    if (!this.appliedSessions.get(connectionId)?.has(sessionId)) return;
    this.snapshotOffers.get(connectionId)?.set(sessionId, { cursor, offerId });
  }

  ackAppliedSnapshot(
    connectionId: string,
    sessionId: string,
    cursor: number,
    offerId: string,
  ): boolean {
    if (!this.appliedSessions.get(connectionId)?.has(sessionId)) return false;
    if (!this.connections.get(connectionId)?.watchedSessions.has(sessionId)) return false;
    const offer = this.snapshotOffers.get(connectionId)?.get(sessionId);
    if (!offer || offer.cursor !== cursor || offer.offerId !== offerId) return false;
    this.cursors.get(connectionId)?.set(sessionId, cursor);
    this.forwarded.get(connectionId)?.set(sessionId, cursor);
    this.snapshotOffers.get(connectionId)?.delete(sessionId);
    this.retryDelivery(connectionId, sessionId);
    return true;
  }

  /** Atomically acknowledge an exact durable prefix; duplicates only reassert an applied prefix. */
  ackAppliedEvents(connectionId: string, sessionId: string, sequences: number[]): boolean {
    if (!this.appliedSessions.get(connectionId)?.has(sessionId)) return false;
    if (!this.connections.get(connectionId)?.watchedSessions.has(sessionId)) return false;
    if (this.snapshotOffers.get(connectionId)?.has(sessionId)) return false;
    if (
      !sequences.length ||
      sequences.length > SYNC_BATCH_LIMIT ||
      sequences.some(
        (seq, i) => !Number.isSafeInteger(seq) || seq <= 0 || (i > 0 && seq <= sequences[i - 1]),
      )
    )
      return false;
    const cursor = this.cursors.get(connectionId)?.get(sessionId) ?? 0;
    const unapplied = sequences.filter((seq) => seq > cursor);
    if (!unapplied.length) return true;
    const next = this.eventStore?.getEventsAfter(sessionId, cursor, unapplied.length);
    if (
      !next ||
      next.length !== unapplied.length ||
      next.some((event, i) => event.seq !== unapplied[i])
    )
      return false;
    const last = unapplied[unapplied.length - 1];
    this.cursors.get(connectionId)?.set(sessionId, last);
    const boundary = this.retryBoundaries.get(connectionId)?.get(sessionId);
    if (boundary !== undefined && last >= boundary) {
      this.retryBoundaries.get(connectionId)?.delete(sessionId);
      this.retryDelivery(connectionId, sessionId);
    }
    return true;
  }

  ackAppliedEvent(connectionId: string, sessionId: string, seq: number): boolean {
    if (!this.appliedSessions.get(connectionId)?.has(sessionId)) return false;
    if (!this.connections.get(connectionId)?.watchedSessions.has(sessionId)) return false;
    if (this.snapshotOffers.get(connectionId)?.has(sessionId)) return false;
    const current = this.cursors.get(connectionId)?.get(sessionId) ?? 0;
    if (!Number.isSafeInteger(seq) || seq <= current) return false;
    const next = this.eventStore?.getEventsAfter(sessionId, current, 1)[0];
    if (next?.seq !== seq) return false;
    this.cursors.get(connectionId)?.set(sessionId, seq);
    if (this.retryBoundaries.get(connectionId)?.get(sessionId) === seq) {
      this.retryBoundaries.get(connectionId)?.delete(sessionId);
      this.retryDelivery(connectionId, sessionId);
    }
    return true;
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
      for (const [connectionId, conn] of this.connections) {
        for (const sessionId of conn.watchedSessions) this.retryDelivery(connectionId, sessionId);
      }
    }, SYNC_INTERVAL_MS);
  }

  /** Retry a bounded suffix, including events withheld during transcript restore. */
  private retryDelivery(connectionId: string, sessionId: string, afterSeq?: number): void {
    const conn = this.connections.get(connectionId);
    const connCursors = this.cursors.get(connectionId);
    if (!this.eventStore || !conn || !conn.transport.isOpen() || !connCursors) return;
    if (this.snapshotOffers.get(connectionId)?.has(sessionId)) return;
    if (
      this.eventStore.isSessionActive &&
      !this.eventStore.isSessionActive(sessionId) &&
      !this.appliedSessions.get(connectionId)?.has(sessionId)
    )
      return;
    const cursor = afterSeq ?? connCursors.get(sessionId) ?? 0;
    let missedEvents: ReturnType<EventStoreAdapter['getEventsAfter']>;
    try {
      missedEvents = this.eventStore.getEventsAfter(sessionId, cursor, SYNC_BATCH_LIMIT);
    } catch (err) {
      log.warn('delivery retry: EventStore fetch failed', {
        connectionId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // Continue full catch-up batches only after their last event is applied.
    // This bounds each delivery burst while avoiding another timer interval.
    const boundary = this.retryBoundaries.get(connectionId);
    boundary?.delete(sessionId);
    if (
      missedEvents.length === SYNC_BATCH_LIMIT &&
      this.appliedSessions.get(connectionId)?.has(sessionId)
    )
      boundary?.set(sessionId, missedEvents[missedEvents.length - 1].seq);
    if (missedEvents.length === 0) return;
    log.info('delivery retry: retrying missed events', {
      connectionId,
      sessionId,
      cursor,
      missedCount: missedEvents.length,
    });
    for (const evt of missedEvents) {
      try {
        conn.transport.send(
          storedEventToClientMessage({
            ...evt,
            sessionId: evt.sessionId ?? sessionId,
            ...(this.eventStore.getSessionPredecessorSeq
              ? {
                  prevSessionSeq: this.eventStore.getSessionPredecessorSeq(sessionId, evt.seq),
                }
              : {}),
          }),
        );
        const forwarded = this.forwarded.get(connectionId);
        forwarded?.set(sessionId, Math.max(forwarded.get(sessionId) ?? 0, evt.seq));
        const current = connCursors.get(sessionId) ?? 0;
        if (evt.seq > current && !this.appliedSessions.get(connectionId)?.has(sessionId))
          connCursors.set(sessionId, evt.seq);
      } catch {
        log.warn('delivery retry failed, stopping batch', {
          connectionId,
          sessionId,
          failedSeq: evt.seq,
        });
        break;
      }
    }
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
    this.notifyWatchChange();
    this.watchListeners.clear();
    this.cursors.clear();
    this.forwarded.clear();
    this.retryBoundaries.clear();
    this.appliedSessions.clear();
    this.snapshotOffers.clear();
  }
}
