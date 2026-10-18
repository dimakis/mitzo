import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  CollaborationContractError,
  COLLABORATION_DURABLE_TRANSCRIPT_MAX_MATERIAL_BYTES,
  CollaborationDurableTranscriptSchema,
  CollaborationSnapshotMessageSchema,
} from './collaboration-conversation.js';
import { SymposiumProvenanceSchema } from './symposium.js';

type Message = z.infer<typeof CollaborationSnapshotMessageSchema>;
type Boundary = { sequence: number; messageId: string | null };
type Pin = { artifactId: string; revision: number; sha256: string };
type Anchor = { seq: number; type: string; messageId: string };
const maxBytes = COLLABORATION_DURABLE_TRANSCRIPT_MAX_MATERIAL_BYTES;
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
function decodeSourceText(value: unknown): string {
  if (!Buffer.isBuffer(value)) fail();
  try {
    // SQLite can extract unsupported surrogate encodings from escaped JSON.
    // Decode exact scalar bytes, never silently replace them or undercharge.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
  } catch {
    fail();
  }
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

/** Capture from retained events only. The highwater and completed anchor belong
 * to the same SQLite read transaction as every bounded visible-text projection.
 * No lifecycle recovery, SDK discovery, provider payload or event replay is used. */
export function captureCollaborationDurableTranscript(
  db: Database.Database,
  session: string,
  initialPrompt?: string | null,
) {
  CollaborationDurableTranscriptSchema.shape.sourceConversationId.parse(session);
  return db.transaction(() => {
    const { through } = db
      .prepare('SELECT MAX(seq) AS through FROM events WHERE session_id=?')
      .get(session) as { through: number | null };
    if (through === null || !Number.isSafeInteger(through) || through < 1) fail();
    const args = { session, through };
    // Native seat rows are never ordinary context. Before excluding them,
    // validate their retained mapping like canonical replay; no payload is read.
    const attributed = `session_id=@session AND seq<=@through
      AND (seat_id IS NOT NULL OR symposium_provenance IS NOT NULL)`;
    const inventory = db
      .prepare(
        `SELECT count(*) AS n,
          COALESCE(sum(length(CAST(seat_id AS BLOB))+length(CAST(symposium_provenance AS BLOB))),0) AS bytes,
          COALESCE(sum(CASE WHEN typeof(seat_id)!='text' OR typeof(symposium_provenance)!='text'
            OR length(seat_id) NOT BETWEEN 1 AND 200 OR length(CAST(seat_id AS BLOB))>800
            THEN 1 ELSE 0 END),0) AS invalid
         FROM events WHERE ${attributed}`,
      )
      .get(args) as { n: number; bytes: number; invalid: number };
    if (inventory.invalid) fail();
    if (!Number.isSafeInteger(inventory.bytes) || inventory.bytes > maxBytes) overflow();
    let remaining = maxBytes;
    let afterMapping = 0;
    let observed = 0;
    while (observed < inventory.n) {
      // Seq-keyset scalar metadata only: no DISTINCT/raw-JSON sort and no
      // unbounded list or provenance hydration before aggregate admission.
      const page = db
        .prepare(
          `SELECT seq,length(CAST(seat_id AS BLOB)) AS seatBytes,
            length(CAST(symposium_provenance AS BLOB)) AS bytes
           FROM events WHERE ${attributed} AND seq>@after ORDER BY seq LIMIT 50`,
        )
        .all({ ...args, after: afterMapping }) as Array<{
        seq: number;
        seatBytes: number;
        bytes: number;
      }>;
      if (!page.length) fail();
      for (const item of page) {
        if (item.bytes + item.seatBytes > remaining) overflow();
        const mapping = db
          .prepare(
            `SELECT CAST(${boundedId('seat_id')} AS BLOB) AS seat,
              CASE WHEN length(CAST(symposium_provenance AS BLOB))<=@remaining
                THEN CAST(symposium_provenance AS BLOB) END AS provenance
             FROM events WHERE session_id=@session AND seq=@seq`,
          )
          .get({ session, seq: item.seq, remaining: remaining - item.seatBytes }) as
          | {
              seat: unknown;
              provenance: unknown;
            }
          | undefined;
        if (!mapping) fail();
        const seat = decodeSourceText(mapping.seat);
        const provenance = decodeSourceText(mapping.provenance);
        let raw: unknown;
        try {
          raw = JSON.parse(provenance);
        } catch {
          fail();
        }
        const parsed = SymposiumProvenanceSchema.safeParse(raw);
        if (!parsed.success || parsed.data.seatId !== seat) fail();
        remaining -= item.bytes + item.seatBytes;
        afterMapping = item.seq;
        if (++observed > inventory.n) fail();
      }
    }
    const last = db
      .prepare(
        `SELECT ${messageIdProjection} AS messageId FROM events WHERE ${anchors} ORDER BY seq DESC LIMIT 1`,
      )
      .get(args) as { messageId: unknown } | undefined;
    if (!last || typeof last.messageId !== 'string') fail();
    const boundary = { sequence: through, messageId: last.messageId };
    const source = openCollaborationVisibleSource(db, session, boundary, initialPrompt);
    // Enforce full-prefix count and aggregate byte bounds before paging, so
    // neither an empty result nor truncation can qualify an incomplete source.
    source.readPrefixWitness();
    const messages: Message[] = [];
    let after = 0;
    for (;;) {
      const page = source.readPage(after, 50);
      messages.push(...page.messages);
      if (!page.hasMore) break;
      after = page.throughSequence;
    }
    const result = { sourceConversationId: session, boundary, messages };
    if (Buffer.byteLength(JSON.stringify(messages)) > maxBytes) overflow();
    return CollaborationDurableTranscriptSchema.parse(result);
  })();
}

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
        `SELECT type,CAST(${messageIdProjection} AS BLOB) AS messageId FROM events WHERE ${anchors} AND seq=@seq`,
      )
      .get({ ...args, seq: anchor.seq }) as { type: string; messageId: unknown } | undefined;
    if (
      !exact ||
      exact.type !== anchor.type ||
      decodeSourceText(exact.messageId) !== anchor.messageId
    )
      fail();
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
      const blockId = `user-${anchor.messageId}`;
      charge(Buffer.byteLength(JSON.stringify({ blockId, content: '', sha256: '0'.repeat(64) })));
      const row = db
        .prepare(
          `SELECT length(CAST(json_quote(json_extract(payload,'$.text')) AS BLOB))-2 AS bytes,
        CASE WHEN json_type(payload,'$.text')='text'
          AND length(CAST(json_quote(json_extract(payload,'$.text')) AS BLOB))-2<=?
        THEN CAST(json_extract(payload,'$.text') AS BLOB) END AS text
        FROM events WHERE session_id=? AND seq=? AND ${ordinary()}`,
        )
        .get(remainingBytes - bytes, session, anchor.seq) as
        { text: unknown; bytes: number } | undefined;
      if (!row) fail();
      if (row.bytes > remainingBytes - bytes) overflow();
      const text = decodeSourceText(row.text);
      charge(Buffer.byteLength(JSON.stringify(text)) - 2);
      blocks.push({
        blockId,
        content: text,
        sha256: hash(text),
      });
    } else {
      const start = db
        .prepare(
          `SELECT seq FROM events WHERE session_id=? AND seq<? AND type='message_start'
        AND ${ordinary()} AND json_extract(payload,'$.messageId')=? ORDER BY seq DESC LIMIT 1`,
        )
        .get(session, anchor.seq, anchor.messageId) as { seq: number } | undefined;
      if (!start) fail();
      type Row = {
        seq: number;
        type: string;
        blockId: unknown;
        blockType: unknown;
        deltaType: unknown;
        deltaBytes: number;
      };
      const rows = db
        .prepare(
          `SELECT seq,type,CAST(${boundedId("json_extract(payload,'$.blockId')")} AS BLOB) AS blockId,
        ${boundedId("json_extract(payload,'$.blockType')")} AS blockType,
        json_type(payload,'$.delta') AS deltaType,
        length(CAST(json_quote(json_extract(payload,'$.delta')) AS BLOB))-2 AS deltaBytes
        FROM events WHERE session_id=? AND seq>? AND seq<? AND ${ordinary()}
        AND json_extract(payload,'$.messageId')=? AND type IN ('block_start','block_delta','block_end')
        ORDER BY seq LIMIT 20001`,
        )
        .iterate(session, start.seq, anchor.seq, anchor.messageId) as IterableIterator<Row>;
      const opened = new Map<string, { content: string; closed: boolean; visible: boolean }>();
      let eventCount = 0;
      let visibleBlocks = 0;
      for (const row of rows) {
        if (++eventCount > 20000) overflow();
        const blockId = decodeSourceText(row.blockId);
        if (row.type === 'block_start') {
          if (typeof row.blockType !== 'string') fail();
          if (opened.has(blockId)) fail();
          if (row.blockType === 'text')
            charge(
              Buffer.byteLength(
                JSON.stringify({
                  blockId,
                  content: '',
                  sha256: '0'.repeat(64),
                }),
              ) + (visibleBlocks++ ? 1 : 0),
            );
          opened.set(blockId, {
            content: '',
            closed: false,
            visible: row.blockType === 'text',
          });
        } else {
          const block = opened.get(blockId);
          if (!block || block.closed) fail();
          if (row.type === 'block_end') block.closed = true;
          else if (block.visible) {
            if (row.deltaType !== 'text') fail();
            if (row.deltaBytes > remainingBytes - bytes) overflow();
            const projected = db
              .prepare(
                `SELECT CASE WHEN json_type(payload,'$.delta')='text'
                AND length(CAST(json_quote(json_extract(payload,'$.delta')) AS BLOB))-2<=?
                THEN CAST(json_extract(payload,'$.delta') AS BLOB) END AS delta
               FROM events WHERE session_id=? AND seq=? AND type='block_delta' AND ${ordinary()}
                AND json_extract(payload,'$.messageId')=? AND json_extract(payload,'$.blockId')=?`,
              )
              .get(remainingBytes - bytes, session, row.seq, anchor.messageId, blockId) as
              { delta: unknown } | undefined;
            if (!projected) fail();
            const delta = decodeSourceText(projected.delta);
            charge(Buffer.byteLength(JSON.stringify(delta)) - 2);
            block.content += delta;
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
