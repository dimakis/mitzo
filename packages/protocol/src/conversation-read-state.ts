import type Database from 'better-sqlite3';
import type { ConversationReadState } from './types.js';

// ECMAScript WhiteSpace + LineTerminator code points, matching String.trim().
const trimCharacters =
  'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
const visibleText = (column: string) =>
  `length(trim(json_extract(${column}, '$.delta'), ${trimCharacters}))>0`;

/** Operator presentation metadata; never changes execution or session recency. */
export class ConversationReadStore {
  constructor(private readonly database: () => Database.Database | null) {
    database()!.exec(`CREATE TABLE IF NOT EXISTS conversation_read_state (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      read_reply_seq INTEGER NOT NULL DEFAULT 0,
      marked_unread INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_events_visible_reply_message_v2
      ON events(session_id, json_extract(payload, '$.messageId'))
      WHERE type='block_delta' AND json_extract(payload, '$.blockType')='text'
      AND ${visibleText('payload')};
    DROP INDEX IF EXISTS idx_events_visible_reply_message`);
  }

  get(sessionId: string): ConversationReadState {
    const db = this.database()!;
    // A message boundary alone may contain only tools/thoughts. Only completed
    // messages with visible assistant text establish a reply watermark.
    const latest = db
      .prepare(
        `SELECT e.seq FROM events e
      WHERE e.session_id=? AND e.type='message_end' AND EXISTS (
        SELECT 1 FROM events t WHERE t.session_id=e.session_id AND t.type='block_delta'
        AND t.seq < e.seq
        AND t.seat_id IS e.seat_id AND t.symposium_provenance IS e.symposium_provenance
        AND json_extract(t.payload, '$.messageId')=json_extract(e.payload, '$.messageId')
        AND json_extract(t.payload, '$.blockType')='text'
        AND ${visibleText('t.payload')}
      ) ORDER BY e.seq DESC LIMIT 1`,
      )
      .get(sessionId) as { seq: number } | undefined;
    const saved = db
      .prepare(
        `SELECT read_reply_seq, marked_unread, revision
      FROM conversation_read_state WHERE session_id=?`,
      )
      .get(sessionId) as
      | {
          read_reply_seq: number;
          marked_unread: number;
          revision: number;
        }
      | undefined;
    return {
      latestReplySeq: latest?.seq ?? 0,
      readReplySeq: saved?.read_reply_seq ?? 0,
      markedUnread: !!saved?.marked_unread,
      revision: saved?.revision ?? 0,
    };
  }

  set(
    sessionId: string,
    update: ({ readReplySeq: number } | { markedUnread: true }) & { expectedRevision?: number },
  ) {
    const db = this.database()!;
    return db.transaction(() => {
      const visible = db
        .prepare(
          `SELECT session_id FROM sessions WHERE session_id=? AND is_hidden=0
        AND NOT EXISTS (SELECT 1 FROM internal_sdk_executions WHERE sdk_session_id=?)`,
        )
        .get(sessionId, sessionId);
      if (!visible) throw new Error('Conversation not found');
      const current = this.get(sessionId);
      if (update.expectedRevision !== undefined && update.expectedRevision !== current.revision)
        throw new Error('Read state changed');
      const seq = 'readReplySeq' in update ? update.readReplySeq : current.readReplySeq;
      if (
        !Number.isSafeInteger(seq) ||
        seq < 0 ||
        ('readReplySeq' in update && seq > current.latestReplySeq)
      )
        throw new Error('Invalid reply cursor');
      // A stale acknowledgement cannot clear a manual unread marker for a
      // newer reply. Already-observed cursors only advance monotonically.
      const markedUnread =
        'markedUnread' in update || (seq < current.latestReplySeq && current.markedUnread);
      db.prepare(
        `INSERT INTO conversation_read_state(session_id, read_reply_seq, marked_unread, revision)
        VALUES (?, ?, ?, 1) ON CONFLICT(session_id) DO UPDATE SET
        read_reply_seq=MAX(read_reply_seq, excluded.read_reply_seq),
        marked_unread=excluded.marked_unread, revision=revision+1`,
      ).run(sessionId, seq, Number(markedUnread));
      return this.get(sessionId);
    })();
  }
}
