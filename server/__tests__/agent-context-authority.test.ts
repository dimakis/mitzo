import { afterEach, expect, it, vi } from 'vitest';
import { revokeAuthSession } from '../auth.js';
import {
  retainAgentContextAuthority,
  agentContextRuntimeError,
} from '../agent-context-authority.js';
import { findSessionRuntimeError } from '../session-runtime-error.js';
afterEach(() => vi.useRealTimers());
it('retains the admitted operator scope across async setup and aborts immediately on logout', async () => {
  const auth = { id: crypto.randomUUID(), expiresAt: Date.now() + 60000 };
  const controller = new AbortController();
  const scope = retainAgentContextAuthority(auth, controller);
  try {
    scope.assertCurrent();
    await Promise.resolve();
    revokeAuthSession(auth);
    expect(controller.signal.aborted).toBe(true);
    expect(findSessionRuntimeError(controller.signal.reason)?.code).toBe('auth_revoked');
    expect(agentContextRuntimeError(new Error('connection closed'), scope.assertCurrent)).toBe(
      controller.signal.reason,
    );
    expect(() => scope.assertCurrent()).toThrow();
  } finally {
    scope.release();
  }
});
it('fences expiry and removes its watcher when the owning query finishes', () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const scope = retainAgentContextAuthority(
    { id: crypto.randomUUID(), expiresAt: Date.now() + 1000 },
    controller,
  );
  vi.advanceTimersByTime(1001);
  expect(controller.signal.aborted).toBe(true);
  expect(findSessionRuntimeError(controller.signal.reason)?.code).toBe('auth_expired');
  expect(() => scope.assertCurrent()).toThrow();
  scope.release();
  const fresh = new AbortController();
  const finished = retainAgentContextAuthority(
    { id: crypto.randomUUID(), expiresAt: Date.now() + 1000 },
    fresh,
  );
  finished.release();
  vi.advanceTimersByTime(1001);
  expect(fresh.signal.aborted).toBe(false);
  expect(() => finished.assertCurrent()).toThrow(/released/i);
});

it('does not relabel transport failures with unrelated or untrusted authorization errors', () => {
  const failure = new Error('connection closed');
  expect(agentContextRuntimeError(failure)).toBe(failure);
  expect(
    agentContextRuntimeError(failure, () => {
      throw new Error('Bearer private-data');
    }),
  ).toBe(failure);
});
