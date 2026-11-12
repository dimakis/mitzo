import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { EventStore } from '../event-store.js';
import { SdkUserSteering } from '../sdk-user-steering.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sdk-user-steer-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'events.db');
  let events = new EventStore(path);
  cleanup.push(() => events.close());
  events.upsertSession({ sessionId: 'chat' });
  let active: string | undefined = 'original';
  let current = true;
  const push = vi.fn<(input: SDKUserMessage) => void>();
  const authorize = () => {
    if (!current) throw Error('Owner revoked');
  };
  const create = () => {
    const query = {};
    const runtime = new SdkUserSteering({
      events,
      sessionId: 'chat',
      operator: 'operator',
      assertCurrent: authorize,
      activeCommandId: () => active,
      push,
    });
    return {
      steer: runtime.steer.bind(runtime),
      waitForReceipt: runtime.waitForReceipt.bind(runtime),
      beforeInput: (input: SDKUserMessage, available: boolean) =>
        runtime.beforeInput(input, available, query),
      observe: (event: Readonly<Record<string, unknown>>) => runtime.observe(event, query),
    };
  };
  const runtime = create();
  const input = {
    requestId: randomUUID(),
    targetCommandId: 'original',
    text: 'Use the corrected order.',
  };
  return {
    get events() {
      return events;
    },
    runtime,
    input,
    push,
    authorize,
    submitted: () => push.mock.calls[0][0],
    revoke: () => {
      current = false;
    },
    successor: () => {
      active = 'successor';
    },
    reopen: () => {
      events.close();
      events = new EventStore(path);
      return create();
    },
  };
}
it('requires exact real-stdin acknowledgement and retries only the original receipt', async () => {
  const f = fixture();
  expect(await f.runtime.steer(f.input, f.authorize)).toEqual({ status: 'uncertain' });
  const message = f.submitted();
  expect(message).toMatchObject({ priority: 'now', message: { content: f.input.text } });
  expect(f.runtime.observe({ ...message })).toBe(true);
  expect(await f.runtime.steer(f.input, f.authorize)).toEqual({ status: 'uncertain' });
  expect(f.runtime.beforeInput(message, true)).toBe(true);
  const initialReceipt = f.runtime.waitForReceipt(f.input);
  expect(f.runtime.observe({ ...message, message: { content: 'wrong' } })).toBe(true);
  expect(await f.runtime.steer(f.input, f.authorize)).toEqual({ status: 'uncertain' });
  expect(f.runtime.observe({ ...message })).toBe(true);
  expect(await initialReceipt).toEqual({ status: 'accepted' });
  expect(await f.runtime.steer(f.input, f.authorize)).toEqual({ status: 'accepted' });
  expect(f.push).toHaveBeenCalledTimes(1);
  await expect(f.runtime.steer({ ...f.input, text: 'changed' }, f.authorize)).rejects.toThrow();
});
it.each(['revocation', 'successor', 'retired query'] as const)(
  'refuses %s at the stdin fence without consuming the active command',
  async (change) => {
    const f = fixture();
    await f.runtime.steer(f.input, f.authorize);
    if (change === 'revocation') f.revoke();
    if (change === 'successor') f.successor();
    expect(f.runtime.beforeInput(f.submitted(), change !== 'retired query')).toBe(false);
    expect(f.events.userSteering.read('chat', 'operator', f.input)?.status).toBe('rejected');
    expect(f.runtime.observe({ ...f.submitted() })).toBe(true);
    expect(f.events.userSteering.read('chat', 'operator', f.input)?.status).toBe('rejected');
  },
);
it('retains uncertainty after reopen and never resubmits to a successor', async () => {
  const f = fixture();
  await f.runtime.steer(f.input, f.authorize);
  expect(f.runtime.beforeInput(f.submitted(), true)).toBe(true);
  const restarted = f.reopen();
  f.successor();
  expect(await restarted.steer(f.input, f.authorize)).toEqual({ status: 'uncertain' });
  expect(restarted.observe({ ...f.submitted() })).toBe(true);
  expect(await restarted.steer(f.input, f.authorize)).toEqual({ status: 'uncertain' });
  expect(f.push).toHaveBeenCalledTimes(1);
});
it('does not claim a stale target', async () => {
  const f = fixture();
  f.successor();
  expect(await f.runtime.steer(f.input, f.authorize)).toEqual({ status: 'stale_target' });
  expect(f.push).not.toHaveBeenCalled();
  expect(f.events.userSteering.read('chat', 'operator', f.input)).toBeUndefined();
});

it('rejects a command identity and cross-operator receipt access', async () => {
  const f = fixture();
  f.events.append('chat', 'user_message', {
    type: 'user_message',
    v: 2,
    messageId: f.input.requestId,
    text: 'ordinary',
  });
  await expect(f.runtime.steer(f.input, f.authorize)).rejects.toThrow('already reserved');
  expect(f.push).not.toHaveBeenCalled();
  const input = { ...f.input, requestId: randomUUID() };
  await f.runtime.steer(input, f.authorize);
  expect(() => f.events.userSteering.read('chat', 'another-operator', input)).toThrow(
    'Original correction identity',
  );
  expect(() => f.events.claimClientCommand(input.requestId, 'ordinary-fingerprint')).toThrow(
    'Identity belongs to a user correction',
  );
  expect(() => f.events.insertSendCommand(input.requestId, 'chat', { text: 'ordinary' })).toThrow(
    'Identity belongs to a user correction',
  );
});

it('leaves reply metadata untouched when an ordinary command already owns the correction identity', async () => {
  const f = fixture();
  f.events.append('chat', 'user_message', {
    v: 2,
    type: 'user_message',
    messageId: f.input.requestId,
    text: 'Existing command',
  });
  f.events.append('chat', 'user_message', {
    v: 2,
    type: 'user_message',
    messageId: 'reply-source',
    text: 'Earlier message',
  });
  expect(f.events.getMessageReplyContext('chat', f.input.requestId)).toBeUndefined();
  await expect(
    f.runtime.steer({ ...f.input, replyToMessageId: 'reply-source' }, f.authorize),
  ).rejects.toThrow('already reserved');
  expect(f.events.getMessageReplyContext('chat', f.input.requestId)).toBeUndefined();
  expect(f.push).not.toHaveBeenCalled();
});

it('requires the exact image payload in the provider acknowledgement', async () => {
  const f = fixture();
  const input = { ...f.input, images: [{ mediaType: 'image/png' as const, data: 'aGVsbG8=' }] };
  await f.runtime.steer(input, f.authorize);
  const message = f.submitted();
  expect(f.runtime.beforeInput(message, true)).toBe(true);
  expect(f.runtime.observe({ ...message, message: { content: input.text } })).toBe(true);
  expect(await f.runtime.steer(input, f.authorize)).toEqual({ status: 'uncertain' });
  expect(f.runtime.observe({ ...message })).toBe(true);
  expect(await f.runtime.steer(input, f.authorize)).toEqual({ status: 'accepted' });
});
