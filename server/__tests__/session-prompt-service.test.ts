import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionPromptStore } from '../session-prompt-store.js';
import { SessionPromptService } from '../session-prompt-service.js';

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
    inspect: vi.fn(async () => ({ busy: false })),
    deliver: vi.fn(async (_delivery, _signal, current) => {
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
