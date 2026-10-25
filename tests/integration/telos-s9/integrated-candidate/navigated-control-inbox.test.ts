import { EventEmitter } from 'node:events';
import type { Page, Request, Response } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { observeNavigatedControlInbox } from './navigated-control-inbox';

function fixture() {
  const events = new EventEmitter();
  const mainFrame = {};
  const childFrame = {};
  const page = Object.assign(events, {
    mainFrame: () => mainFrame,
    waitForResponse: (predicate: (response: Response) => boolean) =>
      new Promise<Response>((resolve) => {
        const listen = (response: Response) => {
          if (predicate(response)) {
            events.off('response', listen);
            resolve(response);
          }
        };
        events.on('response', listen);
      }),
  }) as unknown as Page;
  const request = (frame = mainFrame, itemId = 'coordinator') => {
    const value = {
      frame: () => frame,
      method: () => 'POST',
      postDataJSON: () => ({ operation: 'inbox', itemId }),
    } as unknown as Request;
    events.emit('request', value);
    return value;
  };
  const response = (request: Request, body: unknown, status = 200) => {
    const json = vi.fn(async () => body);
    const value = {
      request: () => request,
      url: () => 'http://127.0.0.1/api/telos/work/controls',
      status: () => status,
      json,
    } as unknown as Response;
    events.emit('response', value);
    return json;
  };
  return { page, events, mainFrame, childFrame, request, response };
}

it('ignores a discarded old-document inbox and reads the first committed-document response before navigation settles', async () => {
  const f = fixture();
  let finishNavigation!: () => void;
  let oldBody!: ReturnType<typeof f.response>;
  let newBody!: ReturnType<typeof f.response>;
  const pending = observeNavigatedControlInbox(f.page, 'coordinator', () => {
    const old = f.request();
    f.events.emit('framenavigated', f.mainFrame);
    oldBody = f.response(old, 'discarded old body');
    f.response(f.request(f.childFrame), 'wrong frame');
    f.response(f.request(f.mainFrame, 'other-item'), 'wrong item');
    newBody = f.response(f.request(), [{ controlId: 'retained' }]);
    return new Promise<void>((resolve) => (finishNavigation = resolve));
  });
  await vi.waitFor(() => expect(newBody).toHaveBeenCalledOnce());
  expect(oldBody).not.toHaveBeenCalled();
  finishNavigation();
  await expect(pending).resolves.toEqual({
    status: 200,
    body: [{ controlId: 'retained' }],
  });
  expect(f.events.listenerCount('request')).toBe(0);
  expect(f.events.listenerCount('framenavigated')).toBe(0);
});

it('does not skip a first matching bad status or malformed receipt to select a later successful response', async () => {
  const f = fixture();
  const pending = observeNavigatedControlInbox(f.page, 'coordinator', async () => {
    f.events.emit('framenavigated', f.mainFrame);
    f.response(f.request(), { error: 'first response must fail caller assertions' }, 503);
    f.response(f.request(), [{ controlId: 'later' }]);
  });
  await expect(pending).resolves.toEqual({
    status: 503,
    body: { error: 'first response must fail caller assertions' },
  });
});

it('propagates navigation failure and removes its document/request listeners', async () => {
  const f = fixture();
  const failure = new Error('navigation failed');
  await expect(
    observeNavigatedControlInbox(f.page, 'coordinator', async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(f.events.listenerCount('request')).toBe(0);
  expect(f.events.listenerCount('framenavigated')).toBe(0);
});
