import { afterEach, expect, it } from 'vitest';
import { EventStore } from '../event-store.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function fixture() {
  const store = new EventStore(':memory:');
  stores.push(store);
  return store;
}
function chat(store: EventStore, id: string, summary = id) {
  store.upsertSession({ sessionId: id, summary, conversationSource: 'mitzo' });
}
const binding = {
  provider: 'anthropic-vertex',
  accountId: 'personal-account',
  accountLabel: 'Personal',
  model: 'claude-opus-4-8',
  profileRevision: '1',
};

it('finds model and account terms in either order without transcript mentions', async () => {
  const store = fixture();
  store.upsertSession({
    sessionId: 'billing',
    conversationSource: 'mitzo',
    summary: 'Billing',
    accountBinding: binding,
  });
  for (const query of ['Claude personal', 'personal Claude']) {
    const hits = await store.searchSessionsAsync(query);
    expect(hits.map((hit) => hit.sessionId)).toEqual(['billing']);
    expect(hits[0].matchedFields).toEqual(expect.arrayContaining(['model', 'account']));
  }
});

it('uses current account aliases on every query, including after index initialization', async () => {
  const store = fixture();
  store.upsertSession({
    sessionId: 'billing',
    conversationSource: 'mitzo',
    accountBinding: binding,
  });
  expect(await store.searchSessionsAsync('home')).toEqual([]);
  const hits = await store.searchSessionsAsync(
    'Claude home',
    20,
    undefined,
    undefined,
    () => 'Home',
  );
  expect(hits.map((hit) => hit.sessionId)).toEqual(['billing']);
  expect(
    await store.searchSessionsAsync('personal', 20, undefined, undefined, () => 'Home'),
  ).toEqual([]);
});

it('matches words across title, project and messages but requires every word', async () => {
  const store = fixture();
  store.upsertSession({
    sessionId: 'one',
    conversationSource: 'mitzo',
    summary: 'Billing review',
    cwd: '/workspace/mitzo',
  });
  store.append('one', 'user_message', { text: 'Compare personal subscriptions' });
  chat(store, 'two', 'Billing review');
  expect(
    (await store.searchSessionsAsync('personal mitzo billing')).map((hit) => hit.sessionId),
  ).toEqual(['one']);
  expect(await store.searchSessionsAsync('personal missing')).toEqual([]);
});

it.each([
  '/workspace/mgmt/.claude/worktrees/abc123',
  '/workspace/mgmt/.cursor/worktrees/abc123/nested',
  String.raw`C:\workspace\mgmt\.claude\worktrees\abc123`,
])('matches the owning project for isolated chat cwd %s', async (cwd) => {
  const store = fixture();
  store.upsertSession({
    sessionId: 'isolated',
    conversationSource: 'mitzo',
    summary: 'Billing review',
    cwd,
  });
  const hits = await store.searchSessionsAsync('billing mgmt');
  expect(hits.map((hit) => hit.sessionId)).toEqual(['isolated']);
  expect(hits[0].matchedFields).toEqual(expect.arrayContaining(['title', 'project']));
});

it('keeps quoted phrases exact while unquoted words may be separated or reversed', async () => {
  const store = fixture();
  chat(store, 'one');
  store.append('one', 'user_message', { text: 'personal billing for Claude' });
  expect(await store.searchSessionsAsync('Claude personal')).toHaveLength(1);
  expect(await store.searchSessionsAsync('"Claude personal"')).toHaveLength(0);
  store.append('one', 'user_message', { text: 'Claude personal billing' });
  expect(await store.searchSessionsAsync('"Claude personal" billing')).toHaveLength(1);
});

it('ranks strong titles above newer incidental message mentions', async () => {
  const store = fixture();
  chat(store, 'title', 'Claude personal');
  chat(store, 'incidental', 'Unrelated meeting');
  store.append('incidental', 'user_message', {
    text: 'Someone mentioned personal subscriptions and Claude',
  });
  expect((await store.searchSessionsAsync('Claude personal')).map((hit) => hit.sessionId)).toEqual([
    'title',
    'incidental',
  ]);
});

it('reconstructs text across streamed chunks and incremental index refreshes', async () => {
  const store = fixture();
  chat(store, 'one');
  store.append('one', 'message_start', { messageId: 'answer' });
  store.append('one', 'block_start', { messageId: 'answer', blockId: 'text', blockType: 'text' });
  store.append('one', 'block_delta', {
    messageId: 'answer',
    blockId: 'text',
    blockType: 'text',
    delta: 'The personal sub',
  });
  expect(await store.searchSessionsAsync('"personal subscription"')).toEqual([]);
  store.append('one', 'block_delta', {
    messageId: 'answer',
    blockId: 'text',
    blockType: 'text',
    delta: 'scription for Claude',
  });
  store.append('one', 'message_end', { messageId: 'answer' });
  const hits = await store.searchSessionsAsync('"personal subscription"');
  expect(hits).toHaveLength(1);
  expect(hits[0].snippet).toContain('personal subscription');
  expect(hits[0].messageId).toBe('answer');
});

it('does not fabricate phrases across different messages or text blocks', async () => {
  const store = fixture();
  chat(store, 'one');
  for (const [messageId, blockId, delta] of [
    ['a', 'x', 'personal '],
    ['b', 'y', 'subscription'],
  ])
    store.append('one', 'block_delta', { messageId, blockId, blockType: 'text', delta });
  expect(await store.searchSessionsAsync('"personal subscription"')).toEqual([]);
  expect(await store.searchSessionsAsync('personal subscription')).toHaveLength(1);
});

it('reassembles a text block across the 128-event index page boundary', async () => {
  const store = fixture();
  chat(store, 'one');
  store.append('one', 'block_delta', {
    messageId: 'answer',
    blockId: 'text',
    blockType: 'text',
    delta: 'personal sub',
  });
  for (let i = 0; i < 127; i++) store.append('one', 'tool_result', { text: 'unsearchable noise' });
  store.append('one', 'block_delta', {
    messageId: 'answer',
    blockId: 'text',
    blockType: 'text',
    delta: 'scription',
  });
  expect(await store.searchSessionsAsync('"personal subscription"')).toHaveLength(1);
});

it('does not join legacy chunks without a stable message identity', async () => {
  const store = fixture();
  chat(store, 'one');
  store.append('one', 'block_delta', { blockId: 'reused', blockType: 'text', delta: 'personal ' });
  store.append('one', 'block_delta', {
    blockId: 'reused',
    blockType: 'text',
    delta: 'subscription',
  });
  expect(await store.searchSessionsAsync('"personal subscription"')).toEqual([]);
  expect(await store.searchSessionsAsync('personal subscription')).toHaveLength(1);
});

it('excludes reasoning, tool data, hidden and internal sessions', async () => {
  const store = fixture();
  chat(store, 'one');
  store.append('one', 'block_start', { messageId: 'a', blockId: 'secret', blockType: 'thinking' });
  store.append('one', 'block_delta', {
    messageId: 'a',
    blockId: 'secret',
    delta: 'private-secret',
  });
  store.append('one', 'block_delta', { blockType: 'tool_use', delta: 'tool-secret' });
  store.append('one', 'tool_result', { text: 'result-secret' });
  chat(store, 'hidden', 'hidden-secret');
  store.hideSession('hidden');
  store.registerInternalSdkExecution({
    sdkSessionId: 'internal',
    parentSessionId: 'one',
    operationId: 'search',
    purpose: 'web_search',
    cwd: '/workspace',
  });
  for (const query of [
    'private-secret',
    'tool-secret',
    'result-secret',
    'hidden-secret',
    'internal-secret',
  ])
    expect(await store.searchSessionsAsync(query)).toEqual([]);
});

it('never indexes contributor-seat text as ordinary conversation text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-search-seats-'));
  const path = join(root, 'events.db');
  const store = new EventStore(path);
  try {
    chat(store, 'one');
    const db = new Database(path);
    try {
      db.prepare('INSERT INTO events(session_id,type,payload,seat_id) VALUES(?,?,?,?)').run(
        'one',
        'block_delta',
        JSON.stringify({ blockType: 'text', delta: 'seat-secret' }),
        'contributor',
      );
    } finally {
      db.close();
    }
    expect(await store.searchSessionsAsync('seat-secret')).toEqual([]);
  } finally {
    await store.closeSearchIndex();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves literal punctuation and tolerates surrounding whitespace', async () => {
  const store = fixture();
  chat(store, 'one');
  store.append('one', 'user_message', { text: 'C++ reached 50%_done, naïve xy' });
  for (const query of [' C++ 50%_done ', 'xy naïve', '"50%_done"'])
    expect(await store.searchSessionsAsync(query)).toHaveLength(1);
  expect(await store.searchSessionsAsync('50%_missing')).toEqual([]);
});

it('preserves exact-case Unicode title and message searches', async () => {
  const store = fixture();
  chat(store, 'unicode', 'École');
  store.append('unicode', 'user_message', { text: 'Προσωπικό Личный' });
  for (const query of ['École', 'Προσωπικό', 'Личный', 'École Личный'])
    expect((await store.searchSessionsAsync(query)).map((hit) => hit.sessionId)).toEqual([
      'unicode',
    ]);
});

it('does not lose other sessions when one conversation has many matching messages', async () => {
  const store = fixture();
  for (const id of ['first', 'second', 'noisy']) {
    chat(store, id);
    store.append(id, 'user_message', { text: 'needle' });
  }
  for (let i = 0; i < 100; i++) store.append('noisy', 'user_message', { text: 'needle' });
  expect(await store.searchSessionsAsync('needle', 3)).toHaveLength(3);
});
