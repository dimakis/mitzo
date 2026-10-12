import type Database from 'better-sqlite3';
import type {
  StoredEvent,
  SessionMeta,
  SessionState,
  ClientSessionState,
  ExecutionToken,
} from './types.js';
import type { ProviderAttemptRecord } from './execution-ledger.js';

export interface ConversationTextEvent {
  seq: number;
  kind: 'user' | 'assistant_delta' | 'assistant_end';
  messageId: string;
  text: string;
}

/** One transactionally consistent durable boundary used by reconnect delivery. */
export interface ReconnectState {
  session: SessionMeta | null;
  clientState: ClientSessionState | null;
  events: StoredEvent[];
  /** Highest event sequence included in the durable boundary. */
  cursor: number;
  /** False when the client claims a sequence beyond this boundary. */
  cursorValid: boolean;
  providerAttempts: ProviderAttemptRecord[];
}

/** Borrow the EventStore connection, prepared reads and public dispatch hooks.
 * EventStore alone owns schema, migration, event decoding and close. */
export interface ConversationReplayOwner<Row> {
  database(): Database.Database | null;
  statements: {
    eventsAfter: Database.Statement;
    eventsAfterLimited: Database.Statement;
    sessionEvents: Database.Statement;
    recentConversationText: Database.Statement;
  };
  eventFromRow(row: Row): StoredEvent;
  getSession(id: string): SessionMeta | null;
  getSessionClientState(id: string): ClientSessionState | null;
  getProviderAttempts(token: ExecutionToken): ProviderAttemptRecord[];
  toClientState(state: SessionState): ClientSessionState;
}

/** Read projections and one transactionally consistent reconnect boundary. */
export class ConversationReplayStore<Row> {
  constructor(private readonly owner: ConversationReplayOwner<Row>) {}
  private get db() {
    return this.owner.database();
  }
  private get stmts() {
    return this.owner.statements;
  }

  getEventsAfter(sessionId: string, afterSeq: number, limit?: number): StoredEvent[] {
    const rows =
      limit != null
        ? this.stmts.eventsAfterLimited.all(sessionId, afterSeq, limit)
        : this.stmts.eventsAfter.all(sessionId, afterSeq);
    return (rows as Row[]).map((row) => this.owner.eventFromRow(row));
  }

  /** Predecessor in this session's durable stream; global IDs need not be contiguous. */
  getSessionPredecessorSeq(sessionId: string, seq: number): number {
    if (!Number.isSafeInteger(seq) || seq < 0)
      throw new Error('Event sequence must be a non-negative safe integer');
    const row = this.db!.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS predecessor FROM events WHERE session_id = ? AND seq < ?',
    ).get(sessionId, seq) as { predecessor: number };
    return row.predecessor;
  }

  getSessionEvents(sessionId: string): StoredEvent[] {
    const rows = this.stmts.sessionEvents.all(sessionId);
    return (rows as Row[]).map((row) => this.owner.eventFromRow(row));
  }

  /** Read the immutable transcript prefix belonging to a reconnect boundary. */
  getSessionEventsThroughCursor(sessionId: string, cursor: number): StoredEvent[] {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error('Reconnect cursor must be a non-negative safe integer');
    }
    const rows = this.db!.prepare(
      `SELECT seq, session_id, type, payload, created_at, seat_id, symposium_provenance
       FROM events WHERE session_id = ? AND seq <= ? ORDER BY seq`,
    ).all(sessionId, cursor) as Row[];
    return rows.map((row) => this.owner.eventFromRow(row));
  }

  /** Return only the bounded text projection needed to rebuild conversation
   * continuity. Images, tool I/O, reasoning and arbitrary event payload fields
   * never leave SQLite. Results are chronological. */
  getRecentConversationText(sessionId: string, limit = 8192): ConversationTextEvent[] {
    const rows = this.stmts.recentConversationText.all(sessionId, limit) as Array<{
      seq: number;
      type: 'user_message' | 'block_delta' | 'message_end';
      message_id: string | null;
      text: string | null;
    }>;
    const events: ConversationTextEvent[] = [];
    for (const row of rows.reverse()) {
      if (!row.message_id) continue;
      if (row.type === 'user_message' && typeof row.text === 'string')
        events.push({ seq: row.seq, kind: 'user', messageId: row.message_id, text: row.text });
      else if (row.type === 'block_delta' && typeof row.text === 'string')
        events.push({
          seq: row.seq,
          kind: 'assistant_delta',
          messageId: row.message_id,
          text: row.text,
        });
      if (row.type === 'message_end')
        events.push({
          seq: row.seq,
          kind: 'assistant_end',
          messageId: row.message_id,
          text: '',
        });
    }
    return events;
  }

  /** Only ordinary user-attached sources, independent of the recent dialogue window.
   * Iterate distinct bounded JSON values rather than hydrating tool/permission payloads. */
  getConversationSourceSnapshots(sessionId: string): unknown[] {
    const metadataBytes = Buffer.byteLength(
      JSON.stringify([
        { kind: 'briefing', date: '0000-00-00', revision: '0'.repeat(64), content: '' },
      ]),
      'utf8',
    );
    const maxRecordBytes = 6 * 2 * 1024 * 1024 + metadataBytes;
    const rows = this.db!.prepare(
      `SELECT CASE WHEN length(CAST(json_extract(payload, '$.sourceSnapshots') AS BLOB)) <= ?
        THEN json_extract(payload, '$.sourceSnapshots') ELSE NULL END AS sources
        FROM events WHERE session_id=? AND type='user_message'
        AND seat_id IS NULL AND symposium_provenance IS NULL
        AND json_type(payload, '$.sourceSnapshots') IS NOT NULL
        GROUP BY sources ORDER BY MIN(seq)`,
    ).iterate(maxRecordBytes, sessionId);
    const snapshots: unknown[] = [];
    let bytes = 0;
    for (const row of rows as Iterable<{ sources: unknown }>) {
      if (typeof row.sources !== 'string') throw new Error('Invalid saved source snapshot');
      bytes += Buffer.byteLength(row.sources, 'utf8');
      // JSON escaping can expand a valid 2 MiB text by at most six times.
      if (bytes > 6 * 2 * 1024 * 1024 + 64 * metadataBytes || snapshots.length >= 64)
        throw new Error('Saved source snapshot projection exceeds bounds');
      snapshots.push(JSON.parse(row.sources));
    }
    return snapshots;
  }

  /** Transport attachment does not start another turn. Recover the last durable turn signal. */
  getSessionClientState(sessionId: string): ClientSessionState | null {
    const session = this.owner.getSession(sessionId);
    if (!session?.state) return null;
    if (!['ACTIVE', 'STARTING', 'DETACHED', 'SUSPENDED'].includes(session.state))
      return this.owner.toClientState(session.state);
    const turn = this.db!.prepare(
      `SELECT type, json_extract(payload, '$.clientState') AS client_state FROM events
       WHERE session_id = ?
         AND type IN ('user_message', 'message_start', 'session_end', 'execution_state_changed')
         AND seat_id IS NULL
         AND json_extract(payload, '$.symposiumProvenance') IS NULL
       ORDER BY seq DESC LIMIT 1`,
    ).get(sessionId) as { type: string; client_state: ClientSessionState | null } | undefined;
    if (turn?.type === 'execution_state_changed' && turn.client_state) return turn.client_state;
    if (turn?.type === 'session_end') return 'idle';
    if (turn) return 'running';
    return this.owner.toClientState(session.state);
  }

  /** Capture aggregate state and its replay suffix in one SQLite read transaction. */
  captureReconnectState(sessionId: string, afterSeq: number, includeEvents = true): ReconnectState {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new Error('Reconnect cursor must be a non-negative safe integer');
    }
    return this.db!.transaction((): ReconnectState => {
      const session = this.owner.getSession(sessionId);
      if (!session)
        return {
          session: null,
          clientState: null,
          events: [],
          cursor: 0,
          cursorValid: afterSeq === 0,
          providerAttempts: [],
        };
      const highWater = this.db!.prepare(
        'SELECT COALESCE(MAX(seq), 0) AS cursor FROM events WHERE session_id = ?',
      ).get(sessionId) as { cursor: number };
      const cursor = Number(highWater.cursor);
      const cursorValid = afterSeq <= cursor;
      const events =
        cursorValid && includeEvents
          ? (
              this.db!.prepare(
                `SELECT seq, session_id, type, payload, created_at, seat_id, symposium_provenance
             FROM events WHERE session_id = ? AND seq > ? AND seq <= ? ORDER BY seq`,
              ).all(sessionId, afterSeq, cursor) as Row[]
            ).map((row) => this.owner.eventFromRow(row))
          : [];
      const providerAttempts =
        session?.executionId && session.executionGeneration > 0
          ? this.owner.getProviderAttempts({
              sessionId,
              executionId: session.executionId,
              generation: session.executionGeneration,
            })
          : [];
      return {
        session,
        clientState: this.owner.getSessionClientState(sessionId),
        events,
        cursor,
        cursorValid,
        providerAttempts,
      };
    })();
  }
}
