import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventStore } from '../src/event-store.js';
import {
  CollaborationContractError,
  CollaborationDurableTranscriptSchema,
} from '../src/collaboration-conversation.js';
import { SessionCollaborationError } from '../src/session-collaboration.js';
import { captureCollaborationDurableTranscript } from '../src/collaboration-visible-source.js';

let store: EventStore, db: Database.Database, directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'durable-visible-'));
  const path = join(directory, 'events.db');
  store = new EventStore(path);
  db = new Database(path);
  store.upsertSession({ sessionId: 'one', conversationSource: 'mitzo' });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
function user(messageId = 'question', text = 'Question') {
  return store.append('one', 'user_message', { messageId, text, credential: 'PRIVATE' });
}
function assistant(messageId = 'answer', text = 'Visible answer') {
  store.append('one', 'message_start', { messageId, providerTurnId: 'PRIVATE' });
  for (const [blockId, blockType, content] of [
    ['reasoning', 'thinking', 'PRIVATE'],
    ['tool', 'tool_use', 'PRIVATE'],
    ['text', 'text', text],
  ]) {
    store.append('one', 'block_start', { messageId, blockId, blockType, rawInput: 'PRIVATE' });
    store.append('one', 'block_delta', { messageId, blockId, delta: content });
    store.append('one', 'block_end', { messageId, blockId, toolResult: 'PRIVATE' });
  }
  return store.append('one', 'message_end', { messageId, provider: 'PRIVATE' });
}
function refuses(code: 'snapshot_changed' | 'capacity_refused') {
  expect(() => store.getDurableSessionTranscript('one')).toThrowError(CollaborationContractError);
  expect(() => store.getDurableSessionTranscript('one')).toThrowError(code);
}

it('captures actual session highwater and completed anchor with only public visible text and no effects', () => {
  user();
  const completed = assistant();
  const highwater = store.append('one', 'ordinary_reply_source', {
    version: 1,
    messageId: 'answer',
    commandId: 'PRIVATE',
    providerTurnId: 'PRIVATE',
  });
  store.append('other', 'user_message', { messageId: 'other', text: 'PRIVATE' });
  const before = db.prepare('SELECT total_changes() AS n').get();
  const rows = db.prepare('SELECT * FROM events').all();
  const replay = vi.spyOn(store, 'getSessionEvents').mockImplementation(() => {
    throw Error('Full replay forbidden');
  });
  const result = store.getDurableSessionTranscript('one');
  expect(result).toMatchObject({
    sourceConversationId: 'one',
    boundary: { sequence: highwater, messageId: 'answer' },
    messages: [
      { messageId: 'question', author: 'operator' },
      {
        messageId: 'answer',
        sequence: completed,
        author: { sessionId: 'one' },
        blocks: [
          {
            blockId: 'text',
            content: 'Visible answer',
            sha256: createHash('sha256').update('Visible answer').digest('hex'),
          },
        ],
      },
    ],
  });
  expect(CollaborationDurableTranscriptSchema.parse(result)).toEqual(result);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(result).not.toHaveProperty('sourceIdentity');
  expect(replay).not.toHaveBeenCalled();
  expect(db.prepare('SELECT * FROM events').all()).toEqual(rows);
  expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
  expect(store.listSessions()).toHaveLength(1);
});

it('retains all qualified messages across the existing 50-message page boundary without truncation', () => {
  for (let n = 0; n < 61; n++) {
    user(`u${n}`);
    assistant(`a${n}`);
  }
  const result = store.getDurableSessionTranscript('one');
  expect(result.messages).toHaveLength(122);
  expect(result.messages.at(-1)?.messageId).toBe('a60');
  const original = structuredClone(result);
  user('later');
  expect(result).toEqual(original);
  expect(store.getDurableSessionTranscript('one').messages).toHaveLength(123);
});

it.each([
  'missing',
  'empty',
  'hidden',
  'symposium',
  'partial',
  'legacy',
  'interleaved',
  'duplicate',
  'orphanEnd',
  'corrupt',
])('refuses %s durable source without inventing an empty or partial transcript', (kind) => {
  if (kind === 'missing') {
    expect(() => store.getDurableSessionTranscript('absent')).toThrowError(
      SessionCollaborationError,
    );
    expect(() => store.getDurableSessionTranscript('absent')).toThrowError(
      'Conversation not found',
    );
    return;
  }
  if (kind !== 'empty') user();
  if (kind === 'hidden') store.hideSession('one');
  if (kind === 'symposium')
    db.prepare("UPDATE sessions SET session_type='symposium' WHERE session_id='one'").run();
  if (kind === 'partial') store.append('one', 'message_start', { messageId: 'open' });
  if (kind === 'legacy')
    store.upsertSession({ sessionId: 'one', initialPrompt: 'Missing original prompt' });
  if (kind === 'interleaved') {
    store.append('one', 'message_start', { messageId: 'answer' });
    store.append('one', 'block_start', { messageId: 'answer', blockId: 'text', blockType: 'text' });
    user('overlap');
    store.append('one', 'block_end', { messageId: 'answer', blockId: 'text' });
    store.append('one', 'message_end', { messageId: 'answer' });
  }
  if (kind === 'duplicate') user('question');
  if (kind === 'orphanEnd') {
    store.append('one', 'block_start', { messageId: 'orphan', blockId: 'text', blockType: 'text' });
    store.append('one', 'message_end', { messageId: 'orphan' });
  }
  if (kind === 'corrupt')
    db.prepare(
      "UPDATE events SET payload=json_set(payload,'$.text',42) WHERE session_id='one'",
    ).run();
  if (kind === 'hidden' || kind === 'symposium') {
    expect(() => store.getDurableSessionTranscript('one')).toThrowError(SessionCollaborationError);
    expect(() => store.getDurableSessionTranscript('one')).toThrowError('Conversation not found');
  } else refuses('snapshot_changed');
});

it.each([
  { seatId: null },
  { seatId: 'private' },
  { symposiumProvenance: null },
  { symposiumProvenance: {} },
])('refuses unproven payload attribution %j rather than silently omitting it', (marker) => {
  user();
  store.append('one', 'user_message', { messageId: 'private', text: 'PRIVATE', ...marker });
  refuses('snapshot_changed');
});

it.each([
  ['private', null],
  [null, '{}'],
  ['private', '{}'],
  ['private', '{'],
  [
    'other',
    JSON.stringify({
      seatId: 'private',
      configRevision: 1,
      accountProfileRevision: 'a',
      seatProfileRevision: 'p',
      contextGrantRevision: 1,
      authorityGrantRevision: 1,
      isolationDomainId: 'd',
      isolationDomainRevision: 1,
    }),
  ],
])('refuses mismatched or unproven native column mapping (%s, %s)', (seat, provenance) => {
  user();
  const seq = store.append('one', 'user_message', { messageId: 'private', text: 'PRIVATE' });
  db.prepare('UPDATE events SET seat_id=?,symposium_provenance=? WHERE seq=?').run(
    seat,
    provenance,
    seq,
  );
  refuses('snapshot_changed');
});

it('keeps an admitted ordinary native conversation eligible without exposing private driver mapping', () => {
  const binding = {
    version: 2,
    account: { accountId: 'fixture', provider: 'openai-codex', profileRevision: 'r1' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
  } as const;
  store.admitOrdinaryLocalCommand(
    {
      sessionId: 'native',
      selectedModel: 'offline',
      mode: 'agent',
      cwd: '/fixture',
      accountBinding: { ...binding.account, accountLabel: 'Fixture', model: 'offline' },
      repositoryWorkspaceId: 'workspace',
    },
    binding,
    {
      clientMsgId: 'initial',
      requestFingerprint: 'fp',
      selection: {
        version: 1,
        agent: { profileId: 'default-mitzo', revision: 1, kind: 'builtin' },
        context: { source: 'none', revision: null },
        permission: { mode: 'agent', revision: 0 },
        model: 'offline',
        thinking: null,
      },
      payload: { text: 'Question' },
    },
  );
  const seq = store.append('native', 'user_message', { messageId: 'initial', text: 'Question' });
  expect(store.getDurableSessionTranscript('native')).toMatchObject({
    sourceConversationId: 'native',
    boundary: { sequence: seq, messageId: 'initial' },
    messages: [{ messageId: 'initial' }],
  });
});

it('bounds message count before hydrating a malformed later message', () => {
  for (let n = 0; n < 501; n++) user(`u${n}`);
  db.prepare(
    "UPDATE events SET payload=json_set(payload,'$.text',42) WHERE seq=(SELECT min(seq) FROM events)",
  ).run();
  refuses('capacity_refused');
});

it.each(['plain', 'escaped'])(
  'bounds cumulative %s bytes before hydrating malformed continuation',
  (kind) => {
    const text = kind === 'plain' ? 'x'.repeat(280000) : '\u0000'.repeat(50000);
    user('first', text);
    user('second', text);
    store.append('one', 'user_message', { messageId: 'malformed', text: 42 });
    refuses('capacity_refused');
  },
);

it('preserves the existing exact 512 KiB message-material bound independently of the public envelope', () => {
  user('first', '');
  user('second', '');
  const empty = store.getDurableSessionTranscript('one');
  const available = 512 * 1024 - Buffer.byteLength(JSON.stringify(empty.messages));
  db.prepare(
    "UPDATE events SET payload=json_set(payload,'$.text',?) WHERE seq=(SELECT min(seq) FROM events)",
  ).run('x'.repeat(280000));
  db.prepare(
    "UPDATE events SET payload=json_set(payload,'$.text',?) WHERE seq=(SELECT max(seq) FROM events)",
  ).run('y'.repeat(available - 280000));
  expect(Buffer.byteLength(JSON.stringify(store.getDurableSessionTranscript('one').messages))).toBe(
    512 * 1024,
  );
  db.prepare(
    "UPDATE events SET payload=json_set(payload,'$.text',json_extract(payload,'$.text')||'z') WHERE seq=(SELECT max(seq) FROM events)",
  ).run();
  refuses('capacity_refused');
});

const provenance = (revision = 'a') => ({
  seatId: 'private',
  configRevision: 1,
  accountProfileRevision: revision,
  seatProfileRevision: 'p',
  contextGrantRevision: 1,
  authorityGrantRevision: 1,
  isolationDomainId: 'd',
  isolationDomainRevision: 1,
});
function privateRow(value: string) {
  const seq = store.append('one', 'user_message', { messageId: 'private', text: 'PRIVATE' });
  db.prepare('UPDATE events SET seat_id=?,symposium_provenance=? WHERE seq=?').run(
    'private',
    value,
    seq,
  );
}
it('excludes a canonically mapped private native row without refusing ordinary visible text', () => {
  user();
  privateRow(JSON.stringify(provenance()));
  expect(store.getDurableSessionTranscript('one').messages.map((row) => row.messageId)).toEqual([
    'question',
  ]);
});
it('refuses corrupt UTF-8 native mapping bytes instead of accepting silently replaced metadata', () => {
  user();
  privateRow(JSON.stringify(provenance()));
  const encoded = Buffer.from(JSON.stringify(provenance('UNSUPPORTED')));
  const offset = encoded.indexOf('UNSUPPORTED');
  const corrupt = Buffer.concat([
    encoded.subarray(0, offset),
    Buffer.from([0xed, 0xa0, 0x80]),
    encoded.subarray(offset + 'UNSUPPORTED'.length),
  ]);
  db.prepare("UPDATE events SET symposium_provenance=CAST(? AS TEXT) WHERE seat_id='private'").run(
    corrupt,
  );
  refuses('snapshot_changed');
});
it('refuses aggregate native metadata overflow before hydrating either large provenance', () => {
  user();
  privateRow(JSON.stringify(provenance('a'.repeat(280000))));
  privateRow(JSON.stringify(provenance('b'.repeat(280000))));
  let bytes = 0;
  db.function('observe_provenance', (value: Buffer) => {
    bytes += Buffer.byteLength(value);
    return value;
  });
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) =>
    prepare(
      sql.replace(
        'THEN CAST(symposium_provenance AS BLOB) END AS provenance',
        'THEN observe_provenance(CAST(symposium_provenance AS BLOB)) END AS provenance',
      ),
    ),
  );
  expect(() => captureCollaborationDurableTranscript(db, 'one')).toThrowError(
    CollaborationContractError,
  );
  expect(() => captureCollaborationDurableTranscript(db, 'one')).toThrowError('capacity_refused');
  expect(bytes).toBe(0);
  // Prove this exact SQL observer remains active after a valid bounded read.
  db.prepare('DELETE FROM events WHERE seq=(SELECT max(seq) FROM events)').run();
  expect(captureCollaborationDurableTranscript(db, 'one').messages).toHaveLength(1);
  expect(bytes).toBe(Buffer.byteLength(JSON.stringify(provenance('a'.repeat(280000)))));
});
it('keeps highwater and all visible pages inside the original SQLite WAL read snapshot', () => {
  const seq = user();
  let appended = false;
  db.function('observe_highwater', (value: number) => {
    if (!appended) {
      appended = true;
      user('concurrent', 'Later');
    }
    return value;
  });
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) =>
    prepare(
      sql.replace('SELECT MAX(seq) AS through', 'SELECT observe_highwater(MAX(seq)) AS through'),
    ),
  );
  const frozen = captureCollaborationDurableTranscript(db, 'one');
  expect(appended).toBe(true);
  expect(frozen.boundary).toEqual({ sequence: seq, messageId: 'question' });
  expect(frozen.messages.map((row) => row.messageId)).toEqual(['question']);
  expect(store.getDurableSessionTranscript('one').messages.map((row) => row.messageId)).toEqual([
    'question',
    'concurrent',
  ]);
});

it.each(['assistantPlain', 'earlierMessage', 'assistantEscaped', 'userEscaped'])(
  'refuses %s serialized material overflow before transferring the excess text from SQLite',
  (kind) => {
    const first = kind.endsWith('Escaped') ? '\u0000'.repeat(50000) : 'x'.repeat(280000);
    const second = kind.endsWith('Escaped') ? '\u0000'.repeat(50000) : 'y'.repeat(280000);
    if (kind === 'earlierMessage' || kind === 'userEscaped') user('first', first);
    if (kind === 'userEscaped') user('second', second);
    else {
      store.append('one', 'message_start', { messageId: 'answer' });
      store.append('one', 'block_start', {
        messageId: 'answer',
        blockId: 'text',
        blockType: 'text',
      });
      for (const delta of kind === 'earlierMessage' ? [second] : [first, second])
        store.append('one', 'block_delta', { messageId: 'answer', blockId: 'text', delta });
      store.append('one', 'block_end', { messageId: 'answer', blockId: 'text' });
      store.append('one', 'message_end', { messageId: 'answer' });
    }
    const hydrated: string[] = [];
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string,
    ) {
      const statement = prepare.call(this, sql);
      if (/AS (delta|text)\b/.test(sql)) {
        const observe = (value: unknown) => {
          if (!value || typeof value !== 'object') return;
          for (const key of ['delta', 'text']) {
            const field = (value as Record<string, unknown>)[key];
            if (typeof field === 'string') hydrated.push(field);
            else if (Buffer.isBuffer(field)) hydrated.push(field.toString('utf8'));
          }
        };
        const get = statement.get.bind(statement);
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, 'get').mockImplementation((...params: unknown[]) => {
          const result = get(...params);
          observe(result);
          return result;
        });
        vi.spyOn(statement, 'iterate').mockImplementation(function* (...params: unknown[]) {
          for (const result of iterate(...params)) {
            observe(result);
            yield result;
          }
        });
      }
      return statement;
    });
    let error: unknown;
    try {
      store.getDurableSessionTranscript('one');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CollaborationContractError);
    expect(error).toMatchObject({ code: 'capacity_refused' });
    expect(hydrated).toEqual([first]);
  },
);

it.each([
  '"quoted"\\path',
  '\u0000\n\t',
  'λ漢字',
  '🦊🧭',
  '\u2028\u2029',
  '\ufeffleading',
  'inside\ufefftext',
])('agrees with actual SQLite serialized cost and preserves supported text %j', (text) => {
  const seq = user('encoded', text);
  const row = db
    .prepare(
      "SELECT length(CAST(json_quote(json_extract(payload,'$.text')) AS BLOB))-2 AS bytes FROM events WHERE seq=?",
    )
    .get(seq) as { bytes: number };
  expect(row.bytes).toBe(Buffer.byteLength(JSON.stringify(text)) - 2);
  assistant('encoded-answer', text);
  expect(
    store.getDurableSessionTranscript('one').messages.map((row) => row.blocks[0].content),
  ).toEqual([text, text]);
});
it.each(['\ud800', '\udc00', 'before\ud800after', 'before\udc00after'])(
  'refuses unsupported unpaired surrogate source %j instead of silently replacing or undercharging it',
  (text) => {
    user('encoded', text);
    refuses('snapshot_changed');
  },
);
it.each(['\ud800', '\udc00'])(
  'refuses unsupported durable user message identity %j without inventing replacement IDs',
  (messageId) => {
    user(messageId, 'Visible');
    refuses('snapshot_changed');
  },
);
it.each(['\ud800', '\udc00'])(
  'refuses an empty completed text block with unsupported identity %j before emitting a replacement',
  (blockId) => {
    store.append('one', 'message_start', { messageId: 'answer' });
    store.append('one', 'block_start', { messageId: 'answer', blockId, blockType: 'text' });
    store.append('one', 'block_end', { messageId: 'answer', blockId });
    store.append('one', 'message_end', { messageId: 'answer' });
    refuses('snapshot_changed');
  },
);
it('preserves a BOM at an embedded assistant delta boundary and the exact retained hash', () => {
  store.append('one', 'message_start', { messageId: 'answer' });
  store.append('one', 'block_start', { messageId: 'answer', blockId: 'text', blockType: 'text' });
  for (const delta of ['Prefix', '\ufeffsuffix'])
    store.append('one', 'block_delta', { messageId: 'answer', blockId: 'text', delta });
  store.append('one', 'block_end', { messageId: 'answer', blockId: 'text' });
  store.append('one', 'message_end', { messageId: 'answer' });
  expect(store.getDurableSessionTranscript('one').messages[0].blocks[0]).toEqual({
    blockId: 'text',
    content: 'Prefix\ufeffsuffix',
    sha256: createHash('sha256').update('Prefix\ufeffsuffix').digest('hex'),
  });
});
