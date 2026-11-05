import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionPromptStore } from '../session-prompt-store.js';
import { SessionPromptService, type SessionPromptPort } from '../session-prompt-service.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'prompt-service-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new SessionPromptStore(join(root, 'events.db'));
  cleanup.push(() => store.close());
  const auth = { id: 'login', expiresAt: Date.now() + 1000000 };
  const port = {
    authorized: vi.fn(() => true),
    inspect: vi.fn<SessionPromptPort['inspect']>(async () => ({ busy: false })),
    deliver: vi.fn<SessionPromptPort['deliver']>(async (_delivery, _signal, current) => {
      current();
    }),
    receipt: vi.fn(() => 'absent' as 'absent' | 'accepted' | 'uncertain'),
    close: vi.fn(),
  };
  const service = new SessionPromptService(store, port);
  cleanup.push(() => service.close());
  const input = {
    requestId: randomUUID(),
    sessionId: 'worker',
    prompt: 'Check PR #7',
    intervalMinutes: 10,
    startImmediately: true,
    maxRuns: null,
  };
  return { store, service, port, auth, input };
}
it('keeps one pending check while busy and sends it once after the existing turn ends', async () => {
  const f = fixture();
  const timer = await f.service.create(f.input, f.auth, 'user', null);
  f.port.inspect.mockResolvedValue({ busy: true });
  await f.service.tick();
  await f.service.tick();
  expect(f.port.deliver).not.toHaveBeenCalled();
  expect(f.store.deliveries()).toHaveLength(1);
  f.port.inspect.mockResolvedValue({ busy: false });
  await Promise.all([f.service.tick(), f.service.tick()]);
  expect(f.port.deliver).toHaveBeenCalledTimes(1);
  expect(f.store.get(timer.id)).toMatchObject({ runCount: 1, status: 'active' });
});
it('cancels timers and undelivered incoming prompts when their recipient is removed', async () => {
  const f = fixture();
  const timer = await f.service.create(f.input, f.auth, 'user', null);
  f.port.inspect.mockResolvedValue({ busy: true });
  await f.service.tick();
  const incoming = await f.service.send(
    { requestId: randomUUID(), sessionId: 'worker', text: 'Do not start this' },
    f.auth,
    'peer',
  );
  await f.service.cancelSession('worker');
  await f.service.cancelSession('worker');
  expect(f.store.get(timer.id)).toMatchObject({ status: 'cancelled', nextRunAt: null });
  expect(f.store.delivery(incoming.id).state).toBe('cancelled');
  f.port.inspect.mockResolvedValue({ busy: false });
  await f.service.tick();
  expect(f.port.deliver).not.toHaveBeenCalled();
});
it('joins cancelled in-flight delivery and preserves its exact accepted receipt', async () => {
  const f = fixture();
  await f.service.create(f.input, f.auth, 'user', null);
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.port.deliver.mockImplementationOnce(async () => {
    entered();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const tick = f.service.tick();
  await started;
  let settled = false;
  const cancellation = f.service.cancelSession('worker').then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  await Promise.all([tick, cancellation]);
  expect(f.store.deliveries()[0].state).toBe('accepted');
});
it('rejects a new timer after removal wins asynchronous inspection', async () => {
  const f = fixture();
  let finish!: () => void;
  f.port.inspect.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { busy: false };
  });
  const creation = f.service.create(f.input, f.auth, 'user', null);
  await f.service.cancelSession('worker');
  finish();
  await expect(creation).rejects.toThrow(/removed/);
  expect(f.store.list()).toEqual([]);
  await expect(
    f.service.send(
      { requestId: randomUUID(), sessionId: 'worker', text: 'Late prompt' },
      f.auth,
      'peer',
    ),
  ).rejects.toThrow(/removed/);
});

it.each(['sender', 'recipient'])(
  'blocks removal of the %s while a retained outgoing receipt is uncertain',
  async (sessionId) => {
    const f = fixture();
    const delivery = f.store.message(
      { requestId: randomUUID(), sessionId: 'recipient', text: 'Original callback' },
      f.auth,
      'sender',
    );
    f.store.claim(delivery.id);
    f.store.finish(delivery.id, 'uncertain', 'Response lost');
    f.port.receipt.mockReturnValue('uncertain');
    // A fresh service has no in-flight promise for this durable delivery.
    const restarted = new SessionPromptService(f.store, f.port);
    await expect(restarted.cancelSession(sessionId)).rejects.toThrow(/uncertain|unsettled/i);
    expect(f.store.delivery(delivery.id)).toMatchObject({
      id: delivery.id,
      commandId: delivery.commandId,
      state: 'uncertain',
    });
    f.port.receipt.mockReturnValue('accepted');
    await restarted.cancelSession(sessionId);
    expect(f.store.delivery(delivery.id).state).toBe('accepted');
    expect(f.port.deliver).not.toHaveBeenCalled();
  },
);

it('checks uncertainty after joining an in-flight delivery during sender removal', async () => {
  const f = fixture();
  const delivery = f.store.message(
    { requestId: randomUUID(), sessionId: 'recipient', text: 'Original callback' },
    f.auth,
    'sender',
  );
  let entered!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  f.port.deliver.mockImplementationOnce(async () => {
    entered();
    await new Promise<void>((resolve) => { finish = resolve; });
    throw Error('Response lost');
  });
  f.port.receipt.mockReturnValue('uncertain');
  const tick = f.service.tick();
  await ready;
  const cancellation = expect(f.service.cancelSession('sender')).rejects.toThrow(/uncertain/i);
  finish();
  await Promise.all([tick, cancellation]);
  expect(f.store.delivery(delivery.id).state).toBe('uncertain');
});

it('retains unreadable matching receipts but ignores unrelated uncertainty', async () => {
  const f = fixture();
  const delivery = f.store.message(
    { requestId: randomUUID(), sessionId: 'recipient', text: 'Original callback' },
    f.auth,
    'sender',
  );
  f.store.claim(delivery.id);
  f.port.receipt.mockImplementation(() => { throw Error('Evidence unavailable'); });
  await f.service.cancelSession('other-chat');
  await expect(f.service.cancelSession('sender')).rejects.toThrow(/uncertain/i);
  f.port.receipt.mockReturnValue('absent');
  await f.service.cancelSession('sender');
  expect(f.store.delivery(delivery.id).state).toBe('failed');
  expect(f.port.deliver).not.toHaveBeenCalled();
});
it('rechecks cancellation after asynchronous preparation and cannot overwrite a cancelled timer', async () => {
  const f = fixture();
  const timer = await f.service.create(f.input, f.auth, 'user', null);
  let proceed!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  f.port.deliver.mockImplementation(async (_delivery, signal, current) => {
    entered();
    await new Promise<void>((resolve) => (proceed = resolve));
    signal.throwIfAborted();
    current();
  });
  const pending = f.service.tick();
  await ready;
  f.service.change(
    timer.id,
    { requestId: randomUUID(), expectedRevision: timer.revision, action: 'cancel' },
    f.auth,
  );
  proceed();
  await pending;
  expect(f.store.get(timer.id)).toMatchObject({ status: 'cancelled', runCount: 0 });
});
it('blocks revoked consent before dispatch and never starts a model', async () => {
  const f = fixture();
  const timer = await f.service.create(f.input, f.auth, 'user', null);
  f.port.authorized.mockReturnValue(false);
  await f.service.tick();
  expect(f.port.deliver).not.toHaveBeenCalled();
  expect(f.store.get(timer.id)).toMatchObject({ status: 'blocked' });
});
it('recovers an accepted dispatch after a lost response without sending the prompt again', async () => {
  const f = fixture();
  const timer = await f.service.create(f.input, f.auth, 'user', null);
  f.port.deliver.mockRejectedValue(Error('Response lost'));
  f.port.receipt.mockReturnValue('uncertain');
  await f.service.tick();
  expect(f.store.get(timer.id).status).toBe('blocked');
  f.port.receipt.mockReturnValue('accepted');
  await f.service.tick();
  expect(f.store.get(timer.id)).toMatchObject({ status: 'blocked', runCount: 1 });
  expect(f.port.deliver).toHaveBeenCalledTimes(1);
});
it('delivers worker callbacks with stable work identity through the same port', async () => {
  const f = fixture();
  const input = {
    requestId: randomUUID(),
    sessionId: 'coordinator',
    text: 'PR #7 merged.',
    workId: 'PR7',
  };
  const receipt = await f.service.send(input, f.auth, 'worker');
  await f.service.tick();
  expect(f.port.deliver).toHaveBeenCalledWith(
    expect.objectContaining({
      senderSessionId: 'worker',
      recipientSessionId: 'coordinator',
      workId: 'PR7',
    }),
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(await f.service.send(input, f.auth, 'worker')).toMatchObject({
    id: receipt.id,
    state: 'accepted',
  });
  await f.service.tick();
  expect(f.port.deliver).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(receipt)).not.toContain('expiresAt');
});
it('reconciles an interrupted paused timer without redispatching or leaving its claim stuck', async () => {
  const f = fixture();
  const timer = await f.service.create(f.input, f.auth, 'user', null);
  const delivery = f.store.due()[0];
  f.store.claim(delivery.id);
  f.store.change(
    timer.id,
    { requestId: randomUUID(), expectedRevision: timer.revision, action: 'pause' },
    f.auth,
  );
  await f.service.tick();
  expect(f.store.delivery(delivery.id).state).toBe('uncertain');
  expect(f.store.get(timer.id).status).toBe('paused');
  f.port.receipt.mockReturnValue('accepted');
  await f.service.tick();
  expect(f.store.get(timer.id)).toMatchObject({ status: 'paused', runCount: 1 });
  expect(f.port.deliver).not.toHaveBeenCalled();
});
it('preserves a pending manual check when a busy paused timer is resumed with renewed authorization', async () => {
  const f = fixture();
  const timer = await f.service.create(
    { ...f.input, startImmediately: false },
    f.auth,
    'user',
    null,
  );
  const paused = f.service.change(
    timer.id,
    { requestId: randomUUID(), expectedRevision: timer.revision, action: 'pause' },
    f.auth,
  );
  const manual = f.service.change(
    timer.id,
    { requestId: randomUUID(), expectedRevision: paused.revision, action: 'run' },
    f.auth,
  );
  f.port.inspect.mockResolvedValue({ busy: true });
  await f.service.tick();
  const original = f.store.deliveries()[0];
  const renewed = { ...f.auth, id: 'renewed-login' };
  f.service.change(
    timer.id,
    { requestId: randomUUID(), expectedRevision: manual.revision, action: 'resume' },
    renewed,
  );
  f.port.inspect.mockResolvedValue({ busy: false });
  await f.service.tick();
  expect(f.store.get(timer.id)).toMatchObject({ status: 'active', runCount: 1, lastError: null });
  expect(f.port.deliver).toHaveBeenCalledTimes(1);
  expect(f.port.deliver.mock.calls[0][0]).toMatchObject({ auth: renewed, manual: true });
  expect(f.store.delivery(original.id).state).toBe('cancelled');
});
it('does not abort the original check when an exact Run now request is retried during preparation', async () => {
  const f = fixture();
  const timer = await f.service.create(
    { ...f.input, startImmediately: false },
    f.auth,
    'user',
    null,
  );
  const request = { requestId: randomUUID(), expectedRevision: timer.revision, action: 'run' };
  const first = f.service.change(timer.id, request, f.auth);
  let proceed!: () => void;
  let entered!: () => void;
  let deliverySignal!: AbortSignal;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  f.port.deliver.mockImplementation(async (_delivery, signal, current) => {
    deliverySignal = signal;
    entered();
    await new Promise<void>((resolve) => (proceed = resolve));
    signal.throwIfAborted();
    current();
  });
  const pending = f.service.tick();
  await ready;
  const retried = f.service.change(timer.id, request, f.auth);
  const aborted = deliverySignal.aborted;
  proceed();
  await pending;
  expect(retried).toEqual(first);
  expect(aborted).toBe(false);
  expect(f.store.get(timer.id)).toMatchObject({ status: 'active', runCount: 1 });
  expect(f.port.deliver).toHaveBeenCalledTimes(1);
});
it('advances beyond busy recipients and revisits earlier work fairly while more callbacks arrive', async () => {
  const f = fixture();
  const available = new Set(['coordinator']);
  f.port.inspect.mockImplementation(async (sessionId) => ({ busy: !available.has(sessionId) }));
  const enqueue = (count: number, sessionId: string) => {
    for (let index = 0; index < count; index++)
      f.store.message(
        { requestId: randomUUID(), sessionId, text: 'Task complete' },
        f.auth,
        'sender',
      );
  };
  enqueue(200, 'busy-worker');
  const callback = f.store.message(
    { requestId: randomUUID(), sessionId: 'coordinator', text: 'Task T complete', workId: 'T' },
    f.auth,
    'sender',
  );
  await f.service.tick();
  expect(f.port.deliver).not.toHaveBeenCalled();
  enqueue(201, 'busy-tail');
  await f.service.tick();
  expect(f.store.delivery(callback.id).state).toBe('accepted');
  available.add('busy-worker');
  enqueue(201, 'busy-tail');
  await f.service.tick();
  expect(
    f.port.deliver.mock.calls.some(([delivery]) => delivery.recipientSessionId === 'busy-worker'),
  ).toBe(true);
});
it.each(['dispatching', 'uncertain'] as const)(
  'isolates an unreadable %s receipt while unrelated timers and callbacks continue',
  async (state) => {
    const f = fixture();
    const timer = await f.service.create(f.input, f.auth, 'user', null);
    const original = f.store.due()[0];
    f.store.claim(original.id);
    if (state === 'uncertain') f.store.finish(original.id, 'uncertain', 'Response lost');
    const healthy = await f.service.create(
      { ...f.input, requestId: randomUUID(), sessionId: 'other-worker' },
      f.auth,
      'user',
      null,
    );
    f.port.receipt.mockImplementation(() => {
      throw Error('Historical execution evidence unavailable');
    });
    await f.service.tick();
    expect(f.store.delivery(original.id).state).toBe('uncertain');
    expect(f.store.get(healthy.id).runCount).toBe(1);
    const callback = f.store.message(
      { requestId: randomUUID(), sessionId: 'coordinator', text: 'Task complete' },
      f.auth,
      'sender',
    );
    await f.service.tick();
    expect(f.store.delivery(callback.id).state).toBe('accepted');
    expect(f.port.deliver).toHaveBeenCalledTimes(2);
    expect(f.port.deliver.mock.calls.every(([d]) => d.id !== original.id)).toBe(true);
    f.port.receipt.mockReturnValue('accepted');
    await f.service.tick();
    expect(f.store.get(timer.id).runCount).toBe(1);
    expect(f.port.deliver).toHaveBeenCalledTimes(2);
  },
);
it('retains uncertainty when both a dispatch and its receipt read fail', async () => {
  const f = fixture();
  const timer = await f.service.create(f.input, f.auth, 'user', null);
  f.port.deliver.mockRejectedValue(Error('Response lost'));
  f.port.receipt.mockImplementation(() => {
    throw Error('Receipt unavailable');
  });
  await f.service.tick();
  expect(f.store.get(timer.id)).toMatchObject({ status: 'blocked', runCount: 0 });
  expect(f.store.deliveries()[0].state).toBe('uncertain');
  await f.service.tick();
  expect(f.port.deliver).toHaveBeenCalledTimes(1);
});
