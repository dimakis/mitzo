import { afterEach, expect, it } from 'vitest';
import { EventStore } from '../event-store.js';

const stores: EventStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
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
