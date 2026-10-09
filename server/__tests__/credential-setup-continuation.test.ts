import { expect, it, vi } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
import { createConnectionSetupContinuation } from '../credential-setup-continuation.js';
import type { ConnectionSetup } from '../credential-setup.js';

function fixture() {
  const registry = new SessionRegistry();
  registry.register('client-a', {
    sessionId: 'session-a',
    mode: 'agent',
    currentSnapshot: null,
    abortController: new AbortController(),
  } as never);
  registry.register('client-b', {
    sessionId: 'session-b',
    mode: 'agent',
    currentSnapshot: null,
    abortController: new AbortController(),
  } as never);
  const setup = {
    id: 'setup-a',
    sessionId: 'session-a',
    revision: 2,
    status: 'ready',
    delivery: 'pending',
    connectionId: 'connection-a',
    connectionRevision: 1,
  } as ConnectionSetup;
  const pending = [setup];
  const send = vi.fn(async (_clientId: string, _prompt: string, _messageId: string) => true);
  const currentConnection = vi.fn(() => ({ revision: 1, status: 'active' }));
  const markDelivered = vi.fn(() => {
    pending.splice(0);
  });
  const isBusy = vi.fn(() => false);
  const continuation = createConnectionSetupContinuation({
    registry,
    send,
    currentConnection,
    markDelivered,
    pendingReady: () => pending,
    isBusy,
  });
  return { registry, setup, send, currentConnection, markDelivered, isBusy, continuation };
}

it('delivers only a context readiness notice to the exact owning chat with deterministic dedup', async () => {
  const f = fixture();
  await f.continuation.flush();
  expect(f.send).toHaveBeenCalledWith(
    'client-a',
    expect.stringContaining('Do not repeat'),
    'connection-setup:setup-a',
  );
  expect(f.send.mock.calls[0][1]).toContain('connection-a');
  expect(f.markDelivered).toHaveBeenCalledWith('setup-a');
  await f.continuation.flush();
  expect(f.send).toHaveBeenCalledOnce();
});

it('retains ready deliveries while busy and coalesces simultaneous completion callbacks', async () => {
  const f = fixture();
  f.isBusy.mockReturnValue(true);
  expect(await f.continuation.notify(f.setup)).toBe(false);
  expect(f.markDelivered).not.toHaveBeenCalled();
  f.isBusy.mockReturnValue(false);
  await Promise.all([f.continuation.notify(f.setup), f.continuation.notify(f.setup)]);
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.markDelivered).toHaveBeenCalledOnce();
});

it('retains failed delivery for retry and reuses the same message id across notifier restarts', async () => {
  const f = fixture();
  f.send.mockResolvedValueOnce(false);
  expect(await f.continuation.notify(f.setup)).toBe(false);
  expect(f.markDelivered).not.toHaveBeenCalled();
  await f.continuation.flush();
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.send.mock.calls.map((call) => call[2])).toEqual([
    'connection-setup:setup-a',
    'connection-setup:setup-a',
  ]);
});

it('fails closed for missing, cancelled, changed, stale or wrong-session setup ownership', async () => {
  for (const condition of ['missing', 'abort', 'revision', 'disabled', 'pending', 'delivered']) {
    const f = fixture();
    if (condition === 'missing') f.setup.sessionId = 'missing';
    if (condition === 'abort') f.registry.get('client-a')!.abortController.abort();
    if (condition === 'revision')
      f.currentConnection.mockReturnValue({ revision: 2, status: 'active' });
    if (condition === 'disabled')
      f.currentConnection.mockReturnValue({ revision: 1, status: 'disabled' });
    if (condition === 'pending') f.setup.status = 'pending';
    if (condition === 'delivered') f.setup.delivery = 'delivered';
    expect(await f.continuation.notify(f.setup)).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.markDelivered).not.toHaveBeenCalled();
  }
});

it('does not acknowledge a replaced owner or aborted session after asynchronous dispatch', async () => {
  const f = fixture();
  f.send.mockImplementationOnce(async () => {
    f.registry.register('client-a', {
      sessionId: 'session-a',
      mode: 'agent',
      abortController: new AbortController(),
    } as never);
    return true;
  });
  expect(await f.continuation.notify(f.setup)).toBe(false);
  expect(f.markDelivered).not.toHaveBeenCalled();
});

it('does not acknowledge readiness after the verified connection changes during dispatch', async () => {
  const f = fixture();
  f.send.mockImplementationOnce(async () => {
    f.currentConnection.mockReturnValue({ revision: 2, status: 'active' });
    return true;
  });
  expect(await f.continuation.notify(f.setup)).toBe(false);
  expect(f.markDelivered).not.toHaveBeenCalled();
});

it('retains detached chat readiness until the owning chat reattaches', async () => {
  const f = fixture();
  f.registry.detach('client-a');
  expect(await f.continuation.notify(f.setup)).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
  f.registry.reattach('client-a', { send: vi.fn() } as never);
  await f.continuation.flush();
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.markDelivered).toHaveBeenCalledOnce();
});

it('retains suspended chat readiness until it resumes and does not acknowledge suspension during send', async () => {
  const f = fixture();
  f.registry.suspend('client-a', 0);
  expect(await f.continuation.notify(f.setup)).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
  f.registry.resume('client-a');
  f.send.mockImplementationOnce(async () => {
    f.registry.suspend('client-a', 0);
    return true;
  });
  expect(await f.continuation.notify(f.setup)).toBe(false);
  expect(f.markDelivered).not.toHaveBeenCalled();
  f.registry.resume('client-a');
});

it.each(['isClosingOut', 'isUserClose'] as const)(
  'retains readiness when %s begins during dispatch and retries its stable message after lifecycle recovery',
  async (predicate) => {
    const f = fixture();
    let closing = false;
    const lifecycle = vi.spyOn(f.registry, predicate).mockImplementation(() => closing);
    f.send.mockImplementationOnce(async () => {
      closing = true;
      return true;
    });
    expect(await f.continuation.notify(f.setup)).toBe(false);
    expect(f.setup.delivery).toBe('pending');
    expect(f.markDelivered).not.toHaveBeenCalled();
    await f.continuation.flush();
    expect(f.send).toHaveBeenCalledOnce();

    closing = false;
    await f.continuation.flush();
    expect(f.send.mock.calls.map((call) => call[2])).toEqual([
      'connection-setup:setup-a',
      'connection-setup:setup-a',
    ]);
    expect(f.markDelivered).toHaveBeenCalledOnce();
    lifecycle.mockRestore();
  },
);
