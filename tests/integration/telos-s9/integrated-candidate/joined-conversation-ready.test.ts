import { EventEmitter } from 'node:events';
import type { Page, Response } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import {
  observePreparedConversations,
  waitForPreparedConversation,
} from './joined-conversation-ready';

// These tests exercise the response observer and its readiness gate. The actual
// browser/DOM assertions remain covered by the unchanged integrated journeys.
const dom = vi.hoisted(() => ({ poll: vi.fn(), count: vi.fn() }));
vi.mock('@playwright/test', () => ({
  expect: Object.assign(() => ({ toHaveCount: dom.count }), {
    poll: (read: () => Promise<unknown>) => ({
      toBe: async (value: unknown) => {
        dom.poll();
        expect(await read()).toBe(value);
      },
    }),
  }),
}));

function fixture() {
  const events = new EventEmitter();
  Object.assign(events, {
    evaluate: async () => 'prepared',
    getByText: () => ({ filter: () => ({}) }),
  });
  const wait = observePreparedConversations(events as unknown as Page);
  const observer = events.listeners('response')[0] as (response: Response) => Promise<void>;
  const respond = (suffix: string, text: () => Promise<string>) =>
    observer({
      url: () => `http://127.0.0.1/api/sessions/prepared/${suffix}`,
      status: () => 200,
      text,
    } as unknown as Response);
  const meta = () =>
    respond('meta', async () =>
      JSON.stringify({
        sessionId: 'prepared',
        runtimeCommandScope: 'prepared-first-command',
      }),
    );
  const messages = () => respond('messages', async () => JSON.stringify({ messages: [] }));
  return { page: events as unknown as Page, wait: () => wait('prepared'), respond, meta, messages };
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it('requires fresh complete responses after an observed body read is cancelled', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.respond('meta', async () => {
    throw Error('Navigation cancelled body read');
  });
  await f.messages();
  let completed = false;
  const waiting = f.wait().then(() => {
    completed = true;
  });
  await vi.advanceTimersByTimeAsync(500);
  expect(completed).toBe(false);
  expect(dom.poll).not.toHaveBeenCalled();
  await f.meta();
  await vi.advanceTimersByTimeAsync(100);
  await waiting;
  expect(completed).toBe(true);
  expect(dom.poll).toHaveBeenCalledOnce();
  expect(dom.count).toHaveBeenCalledWith(0);
});

it.each(['cancelled-only', 'malformed-json'] as const)(
  'retains the existing readiness refusal and deadline for %s',
  async (failure) => {
    const f = fixture();
    await f.respond('meta', async () => {
      if (failure === 'cancelled-only') throw Error('Navigation cancelled body read');
      return '<actual malformed response>';
    });
    await f.messages();
    await expect(f.wait()).rejects.toThrow(
      failure === 'cancelled-only' ? 'prepared conversation reads:' : undefined,
    );
    expect(dom.poll).not.toHaveBeenCalled();
    expect(dom.count).not.toHaveBeenCalled();
  },
  15000,
);

it('requires complete JSON after the retained legacy cancelled-read marker', async () => {
  const f = fixture();
  await f.respond('meta', async () => '<stream>');
  await f.meta();
  await f.messages();
  await f.wait();
  expect(dom.poll).toHaveBeenCalledOnce();
  expect(dom.count).toHaveBeenCalledWith(0);
}, 15000);

it('allows a caller-selected finite App budget while requiring the same completed reads', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const reads: unknown[] = [];
  let completed = false;
  const waiting = waitForPreparedConversation(f.page, reads, 'prepared', { timeout: 20_000 }).then(
    () => {
      completed = true;
    },
  );
  await vi.advanceTimersByTimeAsync(11_000);
  expect(completed).toBe(false);
  expect(dom.poll).not.toHaveBeenCalled();
  reads.push(
    {
      path: '/api/sessions/prepared/meta',
      status: 200,
      body: JSON.stringify({
        sessionId: 'prepared',
        runtimeCommandScope: 'prepared-first-command',
      }),
    },
    {
      path: '/api/sessions/prepared/messages',
      status: 200,
      body: JSON.stringify({ messages: [] }),
    },
  );
  await vi.advanceTimersByTimeAsync(100);
  await waiting;
  expect(completed).toBe(true);
  expect(dom.poll).toHaveBeenCalledOnce();
});
