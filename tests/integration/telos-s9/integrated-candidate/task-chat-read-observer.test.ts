import { EventEmitter } from 'node:events';
import type { Page, Request, Response } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { observeTaskChatReads } from './task-chat-read-observer';

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

it('observes the fresh exact task while an unrelated earlier response body never settles', async () => {
  const f = fixture();
  f.response(f.request('/api/sessions/old/meta'), new Promise(() => {}));
  const boundary = f.observer.boundary();
  f.response(f.request(), Promise.resolve([{ id: 'exact-task', status: 'pending_review' }]));

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
  f.response(old, Promise.resolve([{ id: 'exact-task' }]));
  await vi.waitFor(() => expect(f.observer.reads).toHaveLength(1));
  expect(f.observer.since(boundary)).toEqual([]);
  await expect(
    f.observer.waitForTask('exact-task', boundary, { timeout: 20, interval: 1 }),
  ).rejects.toThrow();

  f.response(f.request(), Promise.resolve([{ id: 'exact-task' }]));
  await expect(f.observer.waitForTask('exact-task', boundary)).resolves.toMatchObject({
    requestOrdinal: 2,
  });
  f.observer.close();
});

it('requires the exact task GET, successful status and retained body, and removes listeners', async () => {
  const f = fixture();
  const boundary = f.observer.boundary();
  f.response(f.request('/api/telos/work/items/exact-task'), Promise.resolve({ id: 'exact-task' }));
  f.response(f.request('/api/tasks', 'POST'), Promise.resolve([{ id: 'exact-task' }]));
  f.response(f.request(), Promise.resolve([{ id: 'other-task' }]));
  f.response(f.request(), Promise.resolve([{ id: 'exact-task' }]), 503);
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
