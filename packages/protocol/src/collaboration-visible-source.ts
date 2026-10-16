import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  CollaborationContractError,
  CollaborationSnapshotMessageSchema,
} from './collaboration-conversation.js';

type Message = z.infer<typeof CollaborationSnapshotMessageSchema>;
type Boundary = { sequence: number; messageId: string | null };
type Pin = { artifactId: string; revision: number; sha256: string };
type Anchor = { seq: number; type: string; messageId: string };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const fail = (): never => {
  throw new CollaborationContractError('snapshot_changed');
};
const overflow = (): never => {
  throw new CollaborationContractError('capacity_refused');
};
const ordinary =
  "seat_id IS NULL AND symposium_provenance IS NULL AND json_extract(payload,'$.symposiumProvenance') IS NULL";
// Completed visible text only. No SDK history, tool I/O, reasoning or provider payload is read.
const anchors = `session_id=@session AND seq<=@through AND ${ordinary} AND
 (type='user_message' OR (type='message_end' AND EXISTS (
 SELECT 1 FROM events b WHERE b.session_id=events.session_id AND b.seq<events.seq
 AND b.type='block_start' AND b.seat_id IS NULL AND b.symposium_provenance IS NULL
 AND json_extract(b.payload,'$.messageId')=json_extract(events.payload,'$.messageId')
 AND json_extract(b.payload,'$.blockType')='text')))`;

/** Borrows EventStore's connection. This capability neither grants session access nor dispatches.
 * Read projections have explicit event/text bounds and never hydrate arbitrary JSON payloads.
 */
export function openCollaborationVisibleSource(
  db: Database.Database,
  session: string,
  boundary: Boundary,
  initialPrompt?: string | null,
) {
  const through = boundary.sequence;
  if (!Number.isSafeInteger(through) || through < 0) fail();
  const args = { session, through };
  function validateBoundary() {
    if (
      through &&
      !db.prepare('SELECT 1 FROM events WHERE session_id=? AND seq=?').get(session, through)
    )
      fail();
    if (
      initialPrompt &&
      !db
        .prepare(
          `SELECT 1 FROM events WHERE session_id=? AND seq<=? AND ${ordinary}
      AND type='user_message' AND json_extract(payload,'$.text')=? LIMIT 1`,
        )
        .get(session, through, initialPrompt)
    )
      fail();
    const last = db
      .prepare(
        `SELECT json_extract(payload,'$.messageId') AS messageId FROM events WHERE ${anchors} ORDER BY seq DESC LIMIT 1`,
      )
      .get(args) as { messageId: unknown } | undefined;
    if ((last?.messageId ?? null) !== boundary.messageId) fail();
    // An active partial turn cannot be presented as a complete frozen conversation.
    const active = db
      .prepare(
        `SELECT 1 FROM events s WHERE s.session_id=@session AND s.seq<=@through
      AND s.type='message_start' AND s.seat_id IS NULL AND s.symposium_provenance IS NULL
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id=s.session_id AND e.seq>s.seq AND e.seq<=@through
      AND e.type='message_end' AND e.seat_id IS NULL AND e.symposium_provenance IS NULL
      AND json_extract(e.payload,'$.messageId')=json_extract(s.payload,'$.messageId')) LIMIT 1`,
      )
      .get(args);
    if (active) fail();
    const duplicate = db
      .prepare(
        `SELECT 1 FROM events WHERE session_id=@session AND seq<=@through AND ${ordinary}
      AND type IN ('user_message','message_start') GROUP BY json_extract(payload,'$.messageId') HAVING count(*)>1 LIMIT 1`,
      )
      .get(args);
    if (duplicate) fail();
  }
  validateBoundary();
  const sourceIdentity = hash(JSON.stringify(['ordinary-visible-text-v1', session, boundary]));
  const observations = new Map<string, Message>();
  let witnessed: { messageCount: number; messagesSha256: string; artifactPins: Pin[] } | undefined;
  function read(anchor: Anchor): Message {
    if (typeof anchor.messageId !== 'string' || !anchor.messageId) fail();
    const exact = db
      .prepare(
        `SELECT type,json_extract(payload,'$.messageId') AS messageId FROM events WHERE ${anchors} AND seq=@seq`,
      )
      .get({ ...args, seq: anchor.seq }) as { type: string; messageId: string } | undefined;
    if (!exact || exact.type !== anchor.type || exact.messageId !== anchor.messageId) fail();
    const blocks: Message['blocks'] = [];
    if (anchor.type === 'user_message') {
      const row = db
        .prepare(
          `SELECT CASE WHEN length(CAST(json_extract(payload,'$.text') AS BLOB))<=524288
        THEN json_extract(payload,'$.text') END AS text FROM events WHERE session_id=? AND seq=?`,
        )
        .get(session, anchor.seq) as { text: unknown };
      if (typeof row.text !== 'string') fail();
      blocks.push({ blockId: anchor.messageId, content: row.text, sha256: hash(row.text) });
    } else {
      const start = db
        .prepare(
          `SELECT seq FROM events WHERE session_id=? AND seq<? AND type='message_start'
        AND ${ordinary} AND json_extract(payload,'$.messageId')=? ORDER BY seq DESC LIMIT 1`,
        )
        .get(session, anchor.seq, anchor.messageId) as { seq: number } | undefined;
      if (!start) fail();
      type Row = { type: string; blockId: unknown; blockType: unknown; delta: unknown };
      const rows = db
        .prepare(
          `SELECT type,json_extract(payload,'$.blockId') AS blockId,
        json_extract(payload,'$.blockType') AS blockType,
        CASE WHEN EXISTS (SELECT 1 FROM events text_block WHERE text_block.session_id=events.session_id
          AND text_block.seq>? AND text_block.seq<events.seq AND text_block.type='block_start'
          AND text_block.seat_id IS NULL AND text_block.symposium_provenance IS NULL
          AND json_extract(text_block.payload,'$.messageId')=json_extract(events.payload,'$.messageId')
          AND json_extract(text_block.payload,'$.blockId')=json_extract(events.payload,'$.blockId')
          AND json_extract(text_block.payload,'$.blockType')='text')
        AND length(CAST(json_extract(payload,'$.delta') AS BLOB))<=524288 THEN json_extract(payload,'$.delta') END AS delta
        FROM events WHERE session_id=? AND seq>? AND seq<? AND ${ordinary}
        AND json_extract(payload,'$.messageId')=? AND type IN ('block_start','block_delta','block_end')
        ORDER BY seq LIMIT 20001`,
        )
        .all(start.seq, session, start.seq, anchor.seq, anchor.messageId) as Row[];
      if (rows.length > 20000) overflow();
      const opened = new Map<string, { content: string; closed: boolean; visible: boolean }>();
      let bytes = 0;
      for (const row of rows) {
        if (typeof row.blockId !== 'string') fail();
        if (row.type === 'block_start') {
          if (opened.has(row.blockId)) fail();
          opened.set(row.blockId, {
            content: '',
            closed: false,
            visible: row.blockType === 'text',
          });
        } else {
          const block = opened.get(row.blockId);
          if (!block || block.closed) fail();
          if (row.type === 'block_end') block.closed = true;
          else if (block.visible) {
            if (typeof row.delta !== 'string') fail();
            bytes += Buffer.byteLength(row.delta);
            if (bytes > 512 * 1024) overflow();
            block.content += row.delta;
          }
        }
      }
      for (const [blockId, block] of opened)
        if (block.visible) {
          if (!block.closed) fail();
          blocks.push({ blockId, content: block.content, sha256: hash(block.content) });
        }
      if (!blocks.length) fail();
    }
    return CollaborationSnapshotMessageSchema.parse({
      conversationId: session,
      messageId: anchor.messageId,
      sequence: anchor.seq,
      author: anchor.type === 'user_message' ? 'operator' : { sessionId: session },
      source: null,
      blocks,
    });
  }
  function pinList(after = 0, before = through): Pin[] {
    const rows = db
      .prepare(
        `SELECT output_id AS artifactId,1 AS revision,sha256 FROM session_output_references
      WHERE session_id=? AND message_end_seq>? AND message_end_seq<=? AND provenance IS NULL ORDER BY output_id LIMIT 101`,
      )
      .all(session, after, before) as Pin[];
    if (rows.length > 100) overflow();
    return rows;
  }
  function remember(message: Message) {
    observations.set(message.messageId, message);
    return message;
  }
  const witness = db.transaction(() => {
    const count = db.prepare(`SELECT count(*) AS n FROM events WHERE ${anchors}`).get(args) as {
      n: number;
    };
    if (count.n > 500) overflow();
    const rows = db
      .prepare(
        `SELECT seq,type,json_extract(payload,'$.messageId') AS messageId FROM events WHERE ${anchors} ORDER BY seq`,
      )
      .all(args) as Anchor[];
    const messages: Message[] = [];
    let bytes = 2;
    for (const row of rows) {
      const message = read(row);
      bytes += Buffer.byteLength(JSON.stringify(message)) + (messages.length ? 1 : 0);
      if (bytes > 512 * 1024) overflow();
      messages.push(message);
    }
    return {
      messageCount: count.n,
      messagesSha256: hash(JSON.stringify(messages)),
      artifactPins: pinList(),
    };
  });
  return {
    sourceIdentity,
    sourceConversationId: session,
    boundary: structuredClone(boundary),
    readPrefixWitness() {
      const current = witness();
      if (witnessed && !isDeepStrictEqual(current, witnessed)) fail();
      witnessed = current;
      return structuredClone(witnessed);
    },
    readPage(afterSequence: number, limit: number) {
      if (
        !Number.isSafeInteger(afterSequence) ||
        afterSequence < 0 ||
        afterSequence > through ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 50
      )
        fail();
      const rows = db
        .prepare(
          `SELECT seq,type,json_extract(payload,'$.messageId') AS messageId FROM events WHERE ${anchors}
        AND seq>@after ORDER BY seq LIMIT @limit`,
        )
        .all({ ...args, after: afterSequence, limit: limit + 1 }) as Anchor[];
      const hasMore = rows.length > limit;
      const selected = rows.slice(0, limit);
      const throughSequence = hasMore ? selected.at(-1)!.seq : through;
      return {
        sourceIdentity,
        afterSequence,
        throughSequence,
        hasMore,
        messages: selected.map(read).map(remember),
        artifacts: pinList(afterSequence, throughSequence),
      };
    },
    readSelected(ids: string[]) {
      if (ids.length > 500 || new Set(ids).size !== ids.length) fail();
      return ids
        .map((messageId) => {
          const rows = db
            .prepare(
              `SELECT seq,type,json_extract(payload,'$.messageId') AS messageId FROM events WHERE ${anchors}
          AND json_extract(payload,'$.messageId')=@messageId ORDER BY seq LIMIT 2`,
            )
            .all({ ...args, messageId }) as Anchor[];
          if (rows.length !== 1) fail();
          return remember(read(rows[0]));
        })
        .sort((a, b) => a.sequence - b.sequence);
    },
    assertCurrent() {
      validateBoundary();
      if (witnessed && !isDeepStrictEqual(witness(), witnessed)) fail();
      for (const message of observations.values())
        if (
          !isDeepStrictEqual(
            read({
              seq: message.sequence,
              type: message.author === 'operator' ? 'user_message' : 'message_end',
              messageId: message.messageId,
            }),
            message,
          )
        )
          fail();
    },
  };
}
