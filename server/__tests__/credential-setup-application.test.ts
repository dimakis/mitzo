import { afterEach, expect, it, vi } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
import type { CredentialConnections } from '../credential-connections.js';
import type { ConnectionSetup } from '../credential-setup.js';
import { bindConnectionSetupApplication } from '../credential-setup-application.js';

afterEach(() => vi.useRealTimers());
function fixture(busy = false) {
  const registry = new SessionRegistry();
  registry.register('origin-client', {
    sessionId: 'origin-chat',
    mode: 'agent',
    abortController: new AbortController(),
    currentSnapshot: null,
    inputQueue: { push: vi.fn(), close: vi.fn() },
  } as never);
  const setup = {
    id: 'setup-a',
    sessionId: 'origin-chat',
    status: 'ready',
    delivery: 'pending',
    connectionId: 'connection-a',
    connectionRevision: 1,
    expiresAt: Date.now() + 1_800_000,
  } as ConnectionSetup;
  const pending = [setup];
  const service = {
    setups: {
      pendingReady: () => pending,
      markDelivered: vi.fn(() => {
        pending.splice(0);
      }),
    },
    connection: vi.fn(() => ({ id: 'connection-a', revision: 1, status: 'active' })),
  } as unknown as CredentialConnections;
  const send = vi.fn(async () => true);
  const isBusy = vi.fn(() => busy);
  const binding = bindConnectionSetupApplication(service, { registry, send, isBusy });
  return { registry, setup, pending, service, send, isBusy, binding };
}
it('replays durable readiness after startup and stops retrying after dispatch succeeds', async () => {
  vi.useFakeTimers();
  const f = fixture(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.send).not.toHaveBeenCalled();
  f.isBusy.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(1500);
  expect(f.send).toHaveBeenCalledWith(
    'origin-client',
    expect.stringContaining('context-only'),
    'connection-setup:setup-a',
  );
  await vi.advanceTimersByTimeAsync(6000);
  expect(f.send).toHaveBeenCalledOnce();
  f.binding.dispose();
});
it('retires the previous runtime retry loop without delivering through a replacement service', async () => {
  vi.useFakeTimers();
  const f = fixture(true);
  await vi.advanceTimersByTimeAsync(0);
  f.binding.dispose();
  f.isBusy.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(6000);
  expect(f.send).not.toHaveBeenCalled();
  expect(await f.binding.onReady(f.setup)).toBe(false);
});
it('requires an available exact origin chat before credential verification', async () => {
  const f = fixture();
  expect(f.binding.canComplete(f.setup)).toBe(true);
  expect(f.binding.canComplete({ ...f.setup, sessionId: 'other-chat' })).toBe(false);
  f.registry.get('origin-client')!.abortController.abort();
  expect(f.binding.canComplete(f.setup)).toBe(false);
  f.binding.dispose();
});

it('leaves old readiness available for manual continuation without retrying forever', async () => {
  vi.useFakeTimers();
  const f = fixture(true);
  f.setup.expiresAt = Date.now() + 2000;
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  f.isBusy.mockReturnValue(false);
  expect(await f.binding.onReady(f.setup)).toBe(false);
  expect(f.pending).toHaveLength(1);
  f.binding.dispose();
});
