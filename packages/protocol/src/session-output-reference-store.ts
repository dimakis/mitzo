import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { SymposiumProvenanceSchema } from './symposium.js';
import {
  SessionOutputRegisterInputSchema,
  type SessionOutputCandidate,
  type SessionOutputReference,
  type SessionOutputSource,
} from './session-output-reference.js';

const MAX_SOURCE_EVENTS = 4096;
const MAX_SOURCE_BYTES = 256 * 1024;
type EventRow = {
  seq: number;
  type: string;
  payload: string;
  seat_id: string | null;
  symposium_provenance: string | null;
};
type OutputRow = {
  output_id: string;
  session_id: string;
  title: string;
  message_id: string;
  block_id: string;
  message_end_seq: number;
  sha256: string;
  provenance: string | null;
  created_at: number;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Uses the existing EventStore owner's connection and backup lifecycle. No standalone database. */
export class SessionOutputReferenceStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_output_references (
      output_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      title TEXT NOT NULL, message_id TEXT NOT NULL, block_id TEXT NOT NULL,
      message_end_seq INTEGER NOT NULL, sha256 TEXT NOT NULL, provenance TEXT, created_at INTEGER NOT NULL,
      UNIQUE(session_id, message_id, block_id, message_end_seq, sha256));
      CREATE TABLE IF NOT EXISTS session_output_register_requests (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        output_id TEXT NOT NULL REFERENCES session_output_references(output_id) ON DELETE CASCADE,
        PRIMARY KEY(session_id, request_id));
      CREATE INDEX IF NOT EXISTS idx_session_outputs ON session_output_references(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_session_output_message_events
        ON events(session_id, json_extract(payload,'$.messageId'), seq);`);
  }

  private source(sessionId: string, selection: Omit<SessionOutputSource, 'sha256'>) {
    const starts = this.db
      .prepare(
        `SELECT seq,type,payload,seat_id,symposium_provenance FROM events
      WHERE session_id=? AND type IN ('message_start','user_message') AND json_extract(payload,'$.messageId')=?
      ORDER BY seq LIMIT 2`,
      )
      .all(sessionId, selection.messageId) as EventRow[];
    if (starts.length > 1) throw new Error('Source message identity is ambiguous');
    const start = starts[0];
    const end = this.db
      .prepare(
        'SELECT seq,type,payload,seat_id,symposium_provenance FROM events WHERE session_id=? AND seq=?',
      )
      .get(sessionId, selection.messageEndSeq) as EventRow | undefined;
    if (
      !start ||
      start.type !== 'message_start' ||
      !end ||
      end.type !== 'message_end' ||
      JSON.parse(end.payload).messageId !== selection.messageId ||
      end.seq <= start.seq ||
      end.seat_id !== start.seat_id ||
      end.symposium_provenance !== start.symposium_provenance
    )
      throw new Error('Source must be an exact finalized assistant message');
    if (start.symposium_provenance) {
      const provenance = SymposiumProvenanceSchema.safeParse(
        JSON.parse(start.symposium_provenance),
      );
      if (!provenance.success || provenance.data.seatId !== start.seat_id)
        throw new Error('Source provenance is invalid');
    } else if (start.seat_id) throw new Error('Source seat attribution has no provenance');
    const rows = this.db
      .prepare(
        `SELECT seq,type,payload,seat_id,symposium_provenance FROM events
      WHERE session_id=? AND seq>? AND seq<? AND json_extract(payload,'$.messageId')=?
        AND (json_extract(payload,'$.blockId')=? OR type='message_end')
      ORDER BY seq LIMIT ?`,
      )
      .all(
        sessionId,
        start.seq,
        end.seq,
        selection.messageId,
        selection.blockId,
        MAX_SOURCE_EVENTS + 1,
      ) as EventRow[];
    if (rows.length > MAX_SOURCE_EVENTS) throw new Error('Source exceeds bounded event limit');
    let opened = false;
    let closed = false;
    let content = '';
    let bytes = 0;
    for (const row of rows) {
      if (row.seat_id !== start.seat_id || row.symposium_provenance !== start.symposium_provenance)
        throw new Error('Source block attribution changed');
      const payload = JSON.parse(row.payload);
      if (row.type === 'message_end') throw new Error('Source message finalization is ambiguous');
      if (row.type === 'block_start') {
        if (opened || payload.blockType !== 'text')
          throw new Error('Source must be one finalized text block');
        opened = true;
      } else if (row.type === 'block_delta') {
        if (
          !opened ||
          closed ||
          typeof payload.delta !== 'string' ||
          (payload.blockType !== undefined && payload.blockType !== 'text')
        )
          throw new Error('Source must be one finalized text block');
        bytes += Buffer.byteLength(payload.delta, 'utf8');
        if (bytes > MAX_SOURCE_BYTES) throw new Error('Source text exceeds 256 KB');
        content += payload.delta;
      } else if (row.type === 'block_end') {
        if (!opened || closed || payload.blockType !== 'text')
          throw new Error('Source must be one finalized text block');
        closed = true;
      }
    }
    if (!opened || !closed || !content.trim())
      throw new Error('Source must be one finalized nonempty text block');
    return { content, sha256: hash(content), provenance: start.symposium_provenance };
  }

  private metadata(row: OutputRow): SessionOutputReference {
    let available = false;
    try {
      const source = this.source(row.session_id, {
        messageId: row.message_id,
        blockId: row.block_id,
        messageEndSeq: row.message_end_seq,
      });
      available = source.sha256 === row.sha256 && source.provenance === row.provenance;
    } catch {
      /* Missing source never becomes independently retained content. */
    }
    return {
      outputId: row.output_id,
      sessionId: row.session_id,
      title: row.title,
      revision: 1,
      kind: 'inline_draft',
      durability: 'reference_registered',
      label: 'In conversation',
      sourceAvailability: available ? 'available' : 'unavailable',
      source: {
        sessionId: row.session_id,
        messageId: row.message_id,
        blockId: row.block_id,
        messageEndSeq: row.message_end_seq,
        sha256: row.sha256,
      },
      provenance: row.provenance
        ? SymposiumProvenanceSchema.parse(JSON.parse(row.provenance))
        : null,
      createdAt: row.created_at,
    };
  }

  register(sessionId: string, raw: unknown): SessionOutputReference {
    const input = SessionOutputRegisterInputSchema.parse(raw);
    const fingerprint = hash(JSON.stringify(input));
    return this.db
      .transaction(() => {
        const prior = this.db
          .prepare(
            'SELECT fingerprint,output_id FROM session_output_register_requests WHERE session_id=? AND request_id=?',
          )
          .get(sessionId, input.requestId) as
          { fingerprint: string; output_id: string } | undefined;
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new Error('Output request identity reused with different input');
          return this.get(sessionId, prior.output_id)!;
        }
        const source = this.source(sessionId, input.source);
        if (source.sha256 !== input.source.sha256) throw new Error('Source content hash changed');
        let row = this.db
          .prepare(
            `SELECT * FROM session_output_references
        WHERE session_id=? AND message_id=? AND block_id=? AND message_end_seq=? AND sha256=?`,
          )
          .get(
            sessionId,
            input.source.messageId,
            input.source.blockId,
            input.source.messageEndSeq,
            source.sha256,
          ) as OutputRow | undefined;
        if (row && row.title !== input.title)
          throw new Error('Source already registered with a different title');
        if (!row) {
          row = {
            output_id: randomUUID(),
            session_id: sessionId,
            title: input.title,
            message_id: input.source.messageId,
            block_id: input.source.blockId,
            message_end_seq: input.source.messageEndSeq,
            sha256: source.sha256,
            provenance: source.provenance,
            created_at: Date.now(),
          };
          this.db
            .prepare('INSERT INTO session_output_references VALUES (?,?,?,?,?,?,?,?,?)')
            .run(
              row.output_id,
              row.session_id,
              row.title,
              row.message_id,
              row.block_id,
              row.message_end_seq,
              row.sha256,
              row.provenance,
              row.created_at,
            );
          this.db
            .prepare(
              'INSERT INTO events (session_id,type,payload,seat_id,symposium_provenance) VALUES (?,?,?,?,?)',
            )
            .run(
              sessionId,
              'session_output_registered',
              JSON.stringify({
                outputId: row.output_id,
                revision: 1,
                source: { ...input.source, sessionId },
                durability: 'reference_registered',
              }),
              null,
              null,
            );
        }
        this.db
          .prepare('INSERT INTO session_output_register_requests VALUES (?,?,?,?)')
          .run(sessionId, input.requestId, fingerprint, row.output_id);
        return this.metadata(row);
      })
      .immediate();
  }
  get(sessionId: string, outputId: string): SessionOutputReference | null {
    const row = this.db
      .prepare('SELECT * FROM session_output_references WHERE session_id=? AND output_id=?')
      .get(sessionId, outputId) as OutputRow | undefined;
    return row ? this.metadata(row) : null;
  }
  list(sessionId: string, limit = 50): SessionOutputReference[] {
    this.limit(limit);
    const rows = this.db
      .prepare(
        'SELECT * FROM session_output_references WHERE session_id=? ORDER BY created_at DESC,output_id LIMIT ?',
      )
      .all(sessionId, limit) as OutputRow[];
    return rows.map((row) => this.metadata(row));
  }
  read(sessionId: string, outputId: string): { output: SessionOutputReference; content: string } {
    // Availability and selected content must share one SQLite read snapshot.
    return this.db.transaction(() => {
      const output = this.get(sessionId, outputId);
      if (!output) throw new Error('Session output not found');
      if (output.sourceAvailability !== 'available')
        throw new Error('Session output source is unavailable');
      return { output, content: this.source(sessionId, output.source).content };
    })();
  }
  candidates(sessionId: string, limit = 10): SessionOutputCandidate[] {
    this.limit(limit);
    const rows = this.db
      .prepare(
        `SELECT seq,type,payload,seat_id,symposium_provenance FROM events
      WHERE session_id=? AND type='message_end' ORDER BY seq DESC LIMIT ?`,
      )
      .all(sessionId, Math.min(limit * 10, 100)) as EventRow[];
    const candidates: SessionOutputCandidate[] = [];
    for (const row of rows) {
      const messageId = JSON.parse(row.payload).messageId;
      if (typeof messageId !== 'string') continue;
      const blocks = this.db
        .prepare(
          `SELECT DISTINCT json_extract(payload,'$.blockId') AS block_id
        FROM events WHERE session_id=? AND type='block_start' AND seq<?
          AND json_extract(payload,'$.messageId')=? AND json_extract(payload,'$.blockType')='text' LIMIT 100`,
        )
        .all(sessionId, row.seq, messageId) as { block_id: unknown }[];
      for (const { block_id: blockId } of blocks) {
        if (typeof blockId !== 'string') continue;
        try {
          const source = this.source(sessionId, { messageId, blockId, messageEndSeq: row.seq });
          candidates.push({
            source: { messageId, blockId, messageEndSeq: row.seq, sha256: source.sha256 },
            content: source.content,
          });
        } catch {
          continue;
        }
        if (candidates.length === limit) return candidates;
      }
    }
    return candidates;
  }
  private limit(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Output limit must be between 1 and 100');
  }
}
