import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import type { Page, Response, Request } from '@playwright/test';
import { navigateWithServiceHealth } from '../service-health-navigation';

it('requires a fresh destination-document health response, never an old same-origin successful read', async () => {
  const events = new EventEmitter();
  const main = {};
  let accept!: (response: Response) => boolean;
  let resolveRead!: (response: Response) => void;
  const read = new Promise<Response>((resolve) => {
    resolveRead = resolve;
  });
  const page = Object.assign(events, {
    mainFrame: () => main,
    url: () => 'https://mitzo-ui.test/chat/next',
    waitForResponse: (predicate: (response: Response) => boolean) => {
      accept = predicate;
      return read;
    },
  }) as unknown as Page;
  const makeRead = () => {
    const request = {
      url: () => 'https://mitzo-ui.test/api/service-health',
      frame: () => main,
      method: () => 'GET',
    } as unknown as Request;
    const finished = vi.fn(async () => null);
    const response = {
      url: request.url,
      request: () => request,
      status: () => 200,
      finished,
    } as unknown as Response;
    return { request, response, finished };
  };
  const old = makeRead(),
    fresh = makeRead();
  let completed = false;
  const navigation = vi.fn(async () => {});
  const pending = navigateWithServiceHealth(page, navigation).then(() => {
    completed = true;
  });
  events.emit('request', old.request);
  if (accept(old.response)) resolveRead(old.response);
  await setImmediate();
  expect(completed).toBe(false);
  expect(old.finished).not.toHaveBeenCalled();
  // Committing the destination cannot retroactively adopt the earlier request.
  events.emit('framenavigated', main);
  expect(accept(old.response)).toBe(false);
  events.emit('request', fresh.request);
  expect(accept(fresh.response)).toBe(true);
  resolveRead(fresh.response);
  await pending;
  expect(fresh.finished).toHaveBeenCalledOnce();
  expect(navigation).toHaveBeenCalledOnce();
  expect(events.listenerCount('request')).toBe(0);
  expect(events.listenerCount('framenavigated')).toBe(0);
});
