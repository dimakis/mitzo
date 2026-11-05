import { afterEach, expect, it } from 'vitest';
import { EventStore } from '../event-store.js';
import { mkdtempSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stores: EventStore[] = [];
const roots: string[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const store = new EventStore(':memory:');
  stores.push(store);
  for (const id of ['first', 'second', 'hidden']) {
    store.upsertSession({ sessionId: id, conversationSource: 'mitzo', summary: `${id} needle` });
    store.append(id, 'user_message', { text: 'Literal 50%_done "quoted" C++ xy naïve needle' });
    store.append(id, 'block_delta', { delta: `Latest needle ${id}` });
  }
  store.hideSession('hidden');
  return store;
}

it('preserves substring, literal wildcard, snippet, visibility and ranking semantics', async () => {
  const store = fixture();
  for (const query of ['needle', '50%_', '"quoted"', 'C++', 'xy', 'naïve', 'first', 'absent']) {
    expect(await store.searchSessionsAsync(query, 20)).toEqual(store.searchSessions(query, 20));
  }
  expect(await store.searchSessionsAsync('needle', 1)).toHaveLength(1);
});

it('stores a disk index only beneath the explicitly selected protected cache root', async () => {
  const store = fixture();
  const root = mkdtempSync(join(tmpdir(), 'protected-search-root-'));
  roots.push(root);
  await store.searchSessionsAsync('needle', 20, undefined, root);
  const directories = readdirSync(root);
  expect(directories).toHaveLength(1);
  const directory = join(root, directories[0]);
  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(join(directory, 'index.db')).mode & 0o777).toBe(0o600);
});

it('indexes newly appended events and rechecks current session visibility', async () => {
  const store = fixture();
  expect(await store.searchSessionsAsync('new-result')).toEqual([]);
  store.append('second', 'user_message', { text: 'new-result' });
  expect((await store.searchSessionsAsync('new-result')).map((row) => row.sessionId)).toEqual([
    'second',
  ]);
  store.hideSession('second');
  expect(await store.searchSessionsAsync('new-result')).toEqual([]);
});

it('recovers a stopped process cache, preserves live owners, and awaits disposal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'search-cache-lifetime-'));
  roots.push(root);
  mkdirSync(join(root, 'unrelated'));
  const live = fixture();
  await live.searchSessionsAsync('needle', 20, undefined, root);
  const liveDirectory = readdirSync(root).find((name) => name !== 'unrelated')!;
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `
    import(${JSON.stringify(new URL('../../packages/protocol/src/event-store.ts', import.meta.url).href)}).then(async ({ EventStore }) => {
    const store = new EventStore(':memory:');
    store.upsertSession({sessionId:'crashed',conversationSource:'mitzo',summary:'needle'});
    await store.searchSessionsAsync('needle',20,undefined,${JSON.stringify(root)});
    process.exit(0);
    }).catch(() => process.exit(1));
  `,
    ],
    { timeout: 15000 },
  );
  const abandoned = readdirSync(root).find(
    (name) => name !== liveDirectory && name !== 'unrelated',
  )!;
  expect(abandoned).toBeTruthy();
  const next = fixture();
  await next.searchSessionsAsync('needle', 20, undefined, root);
  expect(readdirSync(root)).not.toContain(abandoned);
  expect(readdirSync(root)).toContain(liveDirectory);
  await next.closeSearchIndex();
  expect(readdirSync(root).sort()).toEqual([liveDirectory, 'unrelated'].sort());
  await live.closeSearchIndex();
  expect(readdirSync(root)).toEqual(['unrelated']);
});

it('captures the complete event revision without loading transcript payloads', () => {
  const store = fixture();
  expect(store.getSessionEventCursor('absent')).toBe(0);
  const previous = store.getSessionEventCursor('first');
  const seq = store.append('first', 'tool_result', { text: 'new revision' });
  expect(store.getSessionEventCursor('first')).toBe(seq);
  expect(seq).toBeGreaterThan(previous);
});

it('excludes sessions hidden while an asynchronous search is running', async () => {
  const store = fixture();
  const pending = store.searchSessionsAsync('needle');
  store.hideSession('first');
  store.hideSession('second');
  expect(await pending).toEqual([]);
});

it('lets the server event loop run during initial indexing and matching', async () => {
  const store = fixture();
  for (let i = 0; i < 1200; i++) store.append('first', 'block_delta', { delta: `noise ${i}` });
  let heartbeat = false;
  setImmediate(() => {
    heartbeat = true;
  });
  const result = await store.searchSessionsAsync('noise');
  expect(heartbeat).toBe(true);
  expect(result.map((row) => row.sessionId)).toEqual(['first']);
});

it('rejects cancelled searches and disposes pending work when the database closes', async () => {
  const store = fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(store.searchSessionsAsync('needle', 20, abort.signal)).rejects.toThrow();
  const pending = store.searchSessionsAsync('needle');
  store.close();
  await expect(pending).rejects.toThrow();
});
