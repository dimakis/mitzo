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
const maxBytes = 512 * 1024;
// Bound SQL scalar projections before SQLite transfers them into JavaScript.
const boundedId = (expression: string) => `CASE WHEN typeof(${expression})='text'
 AND length(CAST(${expression} AS BLOB))<=800 AND length(${expression}) BETWEEN 1 AND 200
 THEN ${expression} END`;
const messageIdProjection = boundedId("json_extract(payload,'$.messageId')");
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fail(): never {
  throw new CollaborationContractError('snapshot_changed');
}
function overflow(): never {
  throw new CollaborationContractError('capacity_refused');
}
// Presence, including explicit JSON null, must match the canonical renderer's attribution fence.
const ordinary = (alias = '') => {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}seat_id IS NULL AND ${prefix}symposium_provenance IS NULL
    AND json_type(${prefix}payload,'$.seatId') IS NULL
    AND json_type(${prefix}payload,'$.symposiumProvenance') IS NULL`;
};
// Completed visible text only. No SDK history, tool I/O, reasoning or provider payload is read.
const anchors = `session_id=@session AND seq<=@through AND ${ordinary()} AND
 (type='user_message' OR (type='message_end' AND EXISTS (
 SELECT 1 FROM events b WHERE b.session_id=events.session_id AND b.seq<events.seq
 AND b.type='block_start' AND ${ordinary('b')}
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
    // Canonical replay rejects any payload attribution without verified column provenance.
    // The two host bookkeeping records name recipients, not transcript authors.
    const unverified = db
      .prepare(
        `SELECT 1 FROM events WHERE session_id=@session AND seq<=@through
      AND seat_id IS NULL AND symposium_provenance IS NULL AND (
        json_type(payload,'$.symposiumProvenance') IS NOT NULL OR
        (json_type(payload,'$.seatId') IS NOT NULL AND type NOT IN
          ('symposium_delivery_dispatched','symposium_thread_migrated'))) LIMIT 1`,
      )
      .get(args);
    if (unverified) fail();
    // Replay inserts an assistant at message_start, whereas frozen pins use message_end.
    // Refuse the unsupported interleaving globally, including empty/artifact-only selections.
    const interleaved = db
      .prepare(
        `SELECT 1 FROM events s WHERE s.session_id=@session
      AND s.seq<=@through AND s.type='message_start' AND ${ordinary('s')}
      AND EXISTS (SELECT 1 FROM events e WHERE e.session_id=s.session_id AND e.seq>s.seq
        AND e.seq<=@through AND e.type='message_end' AND ${ordinary('e')}
        AND json_extract(e.payload,'$.messageId')=json_extract(s.payload,'$.messageId')
        AND EXISTS (SELECT 1 FROM events t WHERE t.session_id=s.session_id
          AND t.seq>s.seq AND t.seq<e.seq AND t.type IN ('user_message','message_start')
          AND ${ordinary('t')})) LIMIT 1`,
      )
      .get(args);
    if (interleaved) fail();
    if (initialPrompt) {
      const prompt = db
        .prepare(
          `SELECT seq FROM events WHERE session_id=? AND seq<=? AND ${ordinary()}
        AND type='user_message' AND json_extract(payload,'$.text')=? ORDER BY seq LIMIT 1`,
        )
        .get(session, through, initialPrompt) as { seq: number } | undefined;
      const first = db
        .prepare(`SELECT seq FROM events WHERE ${anchors} ORDER BY seq LIMIT 1`)
        .get(args) as { seq: number } | undefined;
      // Legacy replay hoists delayed initial prompts. That ordering is not qualified by this reader.
      if (!prompt || prompt.seq !== first?.seq) fail();
    }
    const last = db
      .prepare(
        `SELECT ${messageIdProjection} AS messageId FROM events WHERE ${anchors} ORDER BY seq DESC LIMIT 1`,
      )
      .get(args) as { messageId: unknown } | undefined;
    if (
      (last && typeof last.messageId !== 'string') ||
      (last?.messageId ?? null) !== boundary.messageId
    )
      fail();
    // An active partial turn cannot be presented as a complete frozen conversation.
    const active = db
      .prepare(
        `SELECT 1 FROM events s WHERE s.session_id=@session AND s.seq<=@through
      AND s.type='message_start' AND ${ordinary('s')}
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id=s.session_id AND e.seq>s.seq AND e.seq<=@through
      AND e.type='message_end' AND ${ordinary('e')}
      AND json_extract(e.payload,'$.messageId')=json_extract(s.payload,'$.messageId')) LIMIT 1`,
      )
      .get(args);
    if (active) fail();
    const duplicate = db
      .prepare(
        `SELECT 1 FROM events WHERE session_id=@session AND seq<=@through AND ${ordinary()}
      AND type IN ('user_message','message_start') GROUP BY json_extract(payload,'$.messageId') HAVING count(*)>1 LIMIT 1`,
      )
      .get(args);
    if (duplicate) fail();
  }
  validateBoundary();
  const sourceIdentity = hash(JSON.stringify(['ordinary-visible-text-v1', session, boundary]));
  const observations = new Map<string, { anchor: Anchor; sha256: string }>();
  let witnessed: { messageCount: number; messagesSha256: string; artifactPins: Pin[] } | undefined;
  function read(anchor: Anchor, remainingBytes: number): Message {
    if (typeof anchor.messageId !== 'string' || !anchor.messageId) fail();
    const exact = db
      .prepare(
        `SELECT type,${messageIdProjection} AS messageId FROM events WHERE ${anchors} AND seq=@seq`,
      )
      .get({ ...args, seq: anchor.seq }) as { type: string; messageId: string } | undefined;
    if (!exact || exact.type !== anchor.type || exact.messageId !== anchor.messageId) fail();
    const blocks: Message['blocks'] = [];
    const envelope = {
      conversationId: session,
      messageId: anchor.messageId,
      sequence: anchor.seq,
      author: anchor.type === 'user_message' ? ('operator' as const) : { sessionId: session },
      source: null,
      blocks,
    };
    let bytes = Buffer.byteLength(JSON.stringify(envelope));
    const charge = (size: number) => {
      bytes += size;
      if (bytes > remainingBytes) overflow();
    };
    charge(0);
    if (anchor.type === 'user_message') {
      const row = db
        .prepare(
          `SELECT length(CAST(json_extract(payload,'$.text') AS BLOB)) AS bytes,
        CASE WHEN length(CAST(json_extract(payload,'$.text') AS BLOB))<=?
        THEN json_extract(payload,'$.text') END AS text FROM events WHERE session_id=? AND seq=? AND ${ordinary()}`,
        )
        .get(remainingBytes - bytes, session, anchor.seq) as { text: unknown; bytes: number };
      if (row.bytes > remainingBytes - bytes) overflow();
      if (typeof row.text !== 'string') fail();
      blocks.push({
        blockId: `user-${anchor.messageId}`,
        content: row.text,
        sha256: hash(row.text),
      });
    } else {
      const start = db
        .prepare(
          `SELECT seq FROM events WHERE session_id=? AND seq<? AND type='message_start'
        AND ${ordinary()} AND json_extract(payload,'$.messageId')=? ORDER BY seq DESC LIMIT 1`,
        )
        .get(session, anchor.seq, anchor.messageId) as { seq: number } | undefined;
      if (!start) fail();
      type Row = { type: string; blockId: unknown; blockType: unknown; delta: unknown };
      const rows = db
        .prepare(
          `SELECT type,${boundedId("json_extract(payload,'$.blockId')")} AS blockId,
        ${boundedId("json_extract(payload,'$.blockType')")} AS blockType,
        length(CAST(json_extract(payload,'$.delta') AS BLOB)) AS deltaBytes,
        CASE WHEN EXISTS (SELECT 1 FROM events text_block WHERE text_block.session_id=events.session_id
          AND text_block.seq>? AND text_block.seq<events.seq AND text_block.type='block_start'
          AND ${ordinary('text_block')}
          AND json_extract(text_block.payload,'$.messageId')=json_extract(events.payload,'$.messageId')
          AND json_extract(text_block.payload,'$.blockId')=json_extract(events.payload,'$.blockId')
          AND json_extract(text_block.payload,'$.blockType')='text')
        AND length(CAST(json_extract(payload,'$.delta') AS BLOB))<=524288 THEN json_extract(payload,'$.delta') END AS delta
        FROM events WHERE session_id=? AND seq>? AND seq<? AND ${ordinary()}
        AND json_extract(payload,'$.messageId')=? AND type IN ('block_start','block_delta','block_end')
        ORDER BY seq LIMIT 20001`,
        )
        .iterate(start.seq, session, start.seq, anchor.seq, anchor.messageId) as IterableIterator<
        Row & { deltaBytes: number }
      >;
      const opened = new Map<string, { content: string; closed: boolean; visible: boolean }>();
      let eventCount = 0;
      let visibleBlocks = 0;
      for (const row of rows) {
        if (++eventCount > 20000) overflow();
        if (typeof row.blockId !== 'string') fail();
        if (row.type === 'block_start') {
          if (typeof row.blockType !== 'string') fail();
          if (opened.has(row.blockId)) fail();
          if (row.blockType === 'text')
            charge(
              Buffer.byteLength(
                JSON.stringify({
                  blockId: row.blockId,
                  content: '',
                  sha256: '0'.repeat(64),
                }),
              ) + (visibleBlocks++ ? 1 : 0),
            );
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
            if (row.deltaBytes > remainingBytes - bytes) overflow();
            if (typeof row.delta !== 'string') fail();
            charge(Buffer.byteLength(JSON.stringify(row.delta)) - 2);
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
    if (Buffer.byteLength(JSON.stringify(envelope)) > remainingBytes) overflow();
    return CollaborationSnapshotMessageSchema.parse(envelope);
  }
  function pinList(after = 0, before = through): Pin[] {
    const rows = db
      .prepare(
        `SELECT ${boundedId('output_id')} AS artifactId,1 AS revision,
        CASE WHEN length(CAST(sha256 AS BLOB))=64 THEN sha256 END AS sha256 FROM session_output_references
      WHERE session_id=? AND message_end_seq>? AND message_end_seq<=? AND provenance IS NULL ORDER BY output_id LIMIT 101`,
      )
      .all(session, after, before) as Pin[];
    if (rows.length > 100) overflow();
    for (const row of rows)
      if (typeof row.artifactId !== 'string' || typeof row.sha256 !== 'string') fail();
    return rows;
  }
  function remember(messages: Message[]) {
    if (
      new Set([...observations.keys(), ...messages.map((message) => message.messageId)]).size > 500
    )
      overflow();
    for (const message of messages)
      observations.set(message.messageId, {
        anchor: {
          seq: message.sequence,
          type: message.author === 'operator' ? 'user_message' : 'message_end',
          messageId: message.messageId,
        },
        sha256: hash(JSON.stringify(message)),
      });
    return messages;
  }
  function collect(rows: Iterable<Anchor>) {
    const messages: Message[] = [];
    let bytes = 2;
    for (const row of rows) {
      const message = read(row, maxBytes - bytes - (messages.length ? 1 : 0));
      bytes += Buffer.byteLength(JSON.stringify(message)) + (messages.length ? 1 : 0);
      messages.push(message);
    }
    return messages;
  }
  const witness = db.transaction(() => {
    validateBoundary();
    const count = db.prepare(`SELECT count(*) AS n FROM events WHERE ${anchors}`).get(args) as {
      n: number;
    };
    if (count.n > 500) overflow();
    const rows = db
      .prepare(
        `SELECT seq,type,${messageIdProjection} AS messageId FROM events WHERE ${anchors} ORDER BY seq`,
      )
      .all(args) as Anchor[];
    const messages = collect(rows);
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
      validateBoundary();
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
          `SELECT seq,type,${messageIdProjection} AS messageId FROM events WHERE ${anchors}
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
        messages: remember(collect(selected)),
        artifacts: pinList(afterSequence, throughSequence),
      };
    },
    readSelected(ids: string[]) {
      validateBoundary();
      if (ids.length > 500 || new Set(ids).size !== ids.length) fail();
      const selected = ids
        .map((messageId) => {
          const rows = db
            .prepare(
              `SELECT seq,type,${messageIdProjection} AS messageId FROM events WHERE ${anchors}
          AND json_extract(payload,'$.messageId')=@messageId ORDER BY seq LIMIT 2`,
            )
            .all({ ...args, messageId }) as Anchor[];
          if (rows.length !== 1) fail();
          return rows[0];
        })
        .sort((a, b) => a.seq - b.seq);
      return remember(collect(selected));
    },
    assertCurrent() {
      validateBoundary();
      if (witnessed && !isDeepStrictEqual(witness(), witnessed)) fail();
      let bytes = 2;
      let count = 0;
      for (const observation of observations.values()) {
        const separator = count++ ? 1 : 0;
        const serialized = JSON.stringify(read(observation.anchor, maxBytes - bytes - separator));
        bytes += Buffer.byteLength(serialized) + separator;
        if (hash(serialized) !== observation.sha256) fail();
      }
    },
  };
}
