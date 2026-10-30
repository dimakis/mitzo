import { createTelosWorkFixtures } from '../../../../frontend/src/test-utils/telos-work-fixtures';
import { EventEmitter } from 'node:events';
import type { Page, Request, Response } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { observeTaskChatReads, navigateToChatMetadata } from './task-chat-read-observer';

function fixture() {
  const events = new EventEmitter();
  const observer = observeTaskChatReads(events as unknown as Page);
  const request = (path = '/api/tasks', method = 'GET') => {
    const value = {
      url: () => 'http://127.0.0.1' + path,
      method: () => method,
    } as unknown as Request;
    events.emit('request', value);
    return value;
  };
  const response = (request: Request, body: Promise<unknown>, status = 200) => {
    events.emit('response', {
      request: () => request,
      url: request.url,
      status: () => status,
      json: () => body,
    } as unknown as Response);
  };
  return { events, observer, request, response };
}

const task = (id = 'exact-task', status = 'pending_review') => ({ id, status, children: [] });
const taskBody = (id = 'exact-task') => ({ tasks: [task(id)] });

it('observes the fresh exact task while an unrelated earlier response body never settles', async () => {
  const f = fixture();
  f.response(f.request('/api/sessions/old/meta'), new Promise(() => {}));
  const boundary = f.observer.boundary();
  f.response(f.request(), Promise.resolve(taskBody()));

  await expect(
    f.observer.waitForTask('exact-task', boundary, { timeout: 50, interval: 1 }),
  ).resolves.toMatchObject({ path: '/api/tasks', status: 200, requestOrdinal: 2 });
  expect(f.observer.pending()).toEqual([{ path: '/api/sessions/old/meta', requestOrdinal: 1 }]);
  f.observer.close();
});

it('does not count an older request whose body completes after the navigation boundary', async () => {
  const f = fixture();
  const old = f.request();
  const boundary = f.observer.boundary();
  f.response(old, Promise.resolve(taskBody()));
  await vi.waitFor(() => expect(f.observer.reads).toHaveLength(1));
  expect(f.observer.since(boundary)).toEqual([]);
  await expect(
    f.observer.waitForTask('exact-task', boundary, { timeout: 20, interval: 1 }),
  ).rejects.toThrow();

  f.response(f.request(), Promise.resolve(taskBody()));
  await expect(f.observer.waitForTask('exact-task', boundary)).resolves.toMatchObject({
    requestOrdinal: 2,
  });
  f.observer.close();
});

it('requires the exact task GET, successful status and retained body, and removes listeners', async () => {
  const f = fixture();
  const boundary = f.observer.boundary();
  f.response(f.request('/api/telos/work/items/exact-task'), Promise.resolve({ id: 'exact-task' }));
  f.response(f.request('/api/tasks', 'POST'), Promise.resolve(taskBody()));
  f.response(f.request(), Promise.resolve(taskBody('other-task')));
  f.response(f.request(), Promise.resolve(taskBody()), 503);
  f.response(f.request(), Promise.reject(new Error('discarded body')));
  await vi.waitFor(() => expect(f.observer.reads).toHaveLength(4));
  await expect(
    f.observer.waitForTask('exact-task', boundary, { timeout: 20, interval: 1 }),
  ).rejects.toThrow();
  expect(f.observer.reads.at(-1)).toMatchObject({ bodyReadError: 'Error: discarded body' });
  expect(f.observer.pending()).toEqual([]);
  f.observer.close();
  expect(f.events.listenerCount('request')).toBe(0);
  expect(f.events.listenerCount('response')).toBe(0);
});

it.each([
  ['serialized body', JSON.stringify(taskBody())],
  ['bare task array', [task()]],
  ['malformed tasks field', { tasks: 'exact-task' }],
  ['unrelated description', { tasks: [{ ...task('other-task'), description: 'exact-task' }] }],
  ['different task ID containing the target', taskBody('exact-task-other')],
  ['invalid status', { tasks: [task('exact-task', 'approved')] }],
  ['missing children', { tasks: [{ id: 'exact-task', status: 'pending_review' }] }],
  ['malformed children', { tasks: [{ ...task(), children: {} }] }],
  ['malformed sibling', { tasks: [task(), null] }],
  ['invalid nested status', { tasks: [{ ...task(), children: [task('child', 'approved')] }] }],
])('rejects a task read with %s', async (_label, body) => {
  const f = fixture();
  const boundary = f.observer.boundary();
  f.response(f.request(), Promise.resolve(body));
  await expect(
    f.observer.waitForTask('exact-task', boundary, { timeout: 20, interval: 1 }),
  ).rejects.toThrow();
  f.observer.close();
});

it('finds an exact nested task ID in a valid task tree', async () => {
  const f = fixture();
  const boundary = f.observer.boundary();
  f.response(
    f.request(),
    Promise.resolve({
      tasks: [{ ...task('parent', 'active'), children: [task()] }],
    }),
  );
  await expect(f.observer.waitForTask('exact-task', boundary)).resolves.toMatchObject({
    path: '/api/tasks',
    status: 200,
  });
  f.observer.close();
});

it.each(['pending', 'active', 'done', 'pending_review', 'blocked', 'skipped', 'failed'])(
  'accepts the supported task status %s',
  async (status) => {
    const f = fixture();
    const boundary = f.observer.boundary();
    f.response(f.request(), Promise.resolve({ tasks: [task('exact-task', status)] }));
    await expect(f.observer.waitForTask('exact-task', boundary)).resolves.toBeDefined();
    f.observer.close();
  },
);

it('waits for fresh metadata for the destination conversation, including an already consumed command', async () => {
  const f = fixture();
  const old = f.request('/api/sessions/peer/meta');
  const boundary = f.observer.boundary();
  f.response(old, Promise.resolve({ sessionId: 'peer' }));
  f.response(f.request('/api/sessions/other/meta'), new Promise(() => {}));
  await expect(
    f.observer.waitForSessionMeta('peer', boundary, { timeout: 20, interval: 1 }),
  ).rejects.toThrow();
  f.response(
    f.request('/api/sessions/peer/meta'),
    Promise.resolve({
      sessionId: 'peer',
      runtimeCommandScope: 'conversation',
    }),
  );
  await expect(f.observer.waitForSessionMeta('peer', boundary)).resolves.toMatchObject({
    path: '/api/sessions/peer/meta',
    requestOrdinal: 3,
    status: 200,
  });
  f.observer.close();
});

it('rejects failed, malformed, wrong-identity and non-GET destination metadata', async () => {
  const f = fixture();
  const boundary = f.observer.boundary();
  f.response(f.request('/api/sessions/peer/meta'), Promise.resolve({ sessionId: 'peer' }), 503);
  f.response(f.request('/api/sessions/peer/meta'), Promise.resolve({ sessionId: 'other' }));
  f.response(f.request('/api/sessions/peer/meta'), Promise.resolve(null));
  f.response(f.request('/api/sessions/peer/meta'), Promise.reject(Error('Discarded document')));
  f.response(f.request('/api/sessions/peer/meta', 'POST'), Promise.resolve({ sessionId: 'peer' }));
  await expect(
    f.observer.waitForSessionMeta('peer', boundary, { timeout: 20, interval: 1 }),
  ).rejects.toThrow();
  f.observer.close();
});

it.each([false, true])(
  'arms navigation reads before goto and releases its listeners (failure=%s)',
  async (failure) => {
    const events = new EventEmitter();
    const destination = 'http://127.0.0.1/chat/peer';
    const page = Object.assign(events, {
      goto: vi.fn(async () => {
        expect(events.listenerCount('request')).toBe(1);
        expect(events.listenerCount('response')).toBe(1);
        if (failure) throw Error('Navigation failed');
        const request = {
          url: () => 'http://127.0.0.1/api/sessions/peer/meta',
          method: () => 'GET',
        };
        events.emit('request', request);
        events.emit('response', {
          request: () => request,
          url: request.url,
          status: () => 200,
          json: async () => ({ sessionId: 'peer' }),
        });
      }),
    });
    const navigation = navigateToChatMetadata(page as unknown as Page, destination, 'peer');
    if (failure) await expect(navigation).rejects.toThrow('Navigation failed');
    else await navigation;
    expect(page.goto).toHaveBeenCalledExactlyOnceWith(destination);
    expect(events.listenerCount('request')).toBe(0);
    expect(events.listenerCount('response')).toBe(0);
  },
);

const collectionBody = () => ({
  profiles: ['manual'],
  records: createTelosWorkFixtures().homeStudio.items,
  failures: [],
});
it('requires a fresh completed collection containing every attached identity', async () => {
  const f = fixture();
  const body = collectionBody();
  const ids = body.records.map((record) => record.itemId);
  const old = f.request('/api/telos/work/collection');
  const boundary = f.observer.boundary();
  f.response(old, Promise.resolve(body));
  f.response(f.request('/api/telos/work/collection'), new Promise(() => {}));
  await expect(
    f.observer.waitForCollectionRecords(ids, boundary, { timeout: 20, interval: 1 }),
  ).rejects.toThrow();
  f.response(f.request('/api/telos/work/collection'), Promise.resolve(body));
  await expect(f.observer.waitForCollectionRecords(ids, boundary)).resolves.toMatchObject({
    requestOrdinal: 3,
    body,
  });
  f.observer.close();
});
it.each(['missing identity', 'malformed record', 'malformed failures', 'unsuccessful', 'non-GET'])(
  'does not admit a collection with %s',
  async (problem) => {
    const f = fixture();
    const body = collectionBody();
    const ids = body.records.map((record) => record.itemId);
    const raw =
      problem === 'missing identity'
        ? { ...body, records: body.records.slice(1) }
        : problem === 'malformed record'
          ? { ...body, records: [{ itemId: ids[0] }] }
          : problem === 'malformed failures'
            ? { ...body, failures: ['invalid'] }
            : body;
    f.response(
      f.request('/api/telos/work/collection', problem === 'non-GET' ? 'POST' : 'GET'),
      Promise.resolve(raw),
      problem === 'unsuccessful' ? 503 : 200,
    );
    await expect(
      f.observer.waitForCollectionRecords(ids, 0, { timeout: 20, interval: 1 }),
    ).rejects.toThrow();
    // A later valid response can recover without accepting the earlier invalid body.
    f.response(f.request('/api/telos/work/collection'), Promise.resolve(body));
    await expect(f.observer.waitForCollectionRecords(ids, 0)).resolves.toMatchObject({ body });
    f.observer.close();
  },
);

it('tracks a second admitted collection before headers and clears it on request failure', async () => {
  const f = fixture();
  const body = collectionBody();
  const ids = body.records.map((record) => record.itemId);
  f.response(f.request('/api/telos/work/collection'), Promise.resolve(body));
  const later = f.request('/api/telos/work/collection');
  await f.observer.waitForCollectionRecords(ids, 0);
  expect(f.observer.pending()).toEqual([{ path: '/api/telos/work/collection', requestOrdinal: 2 }]);
  f.events.emit('requestfailed', later);
  expect(f.observer.pending()).toEqual([]);
  expect(f.observer.requestedSince(0)).toHaveLength(2);
  f.observer.close();
  expect(f.events.listenerCount('requestfailed')).toBe(0);
});
