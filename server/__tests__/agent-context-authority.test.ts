import { afterEach, expect, it, vi } from 'vitest';
import { registerAuthSession, revokeAuthSession } from '../auth.js';
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
it('expires client access while keeping admitted work revocable until release', () => {
  vi.useFakeTimers();
  const auth = { id: crypto.randomUUID(), expiresAt: Date.now() + 1000 };
  const controller = new AbortController();
  const scope = retainAgentContextAuthority(auth, controller);
  const client = vi.fn();
  const unregister = registerAuthSession(auth, client);
  try {
    vi.advanceTimersByTime(1001);
    expect(client).toHaveBeenCalledWith('expired');
    expect(controller.signal.aborted).toBe(false);
    expect(scope.failure()).toBeUndefined();
    expect(() => scope.assertCurrent()).not.toThrow();
    revokeAuthSession(auth);
    expect(controller.signal.aborted).toBe(true);
    expect(findSessionRuntimeError(controller.signal.reason)?.code).toBe('auth_revoked');
    expect(() => scope.assertCurrent()).toThrow();
  } finally {
    scope.release();
    unregister();
  }
});

it('removes its watcher when the owning query finishes', () => {
  vi.useFakeTimers();
  const fresh = new AbortController();
  const auth = { id: crypto.randomUUID(), expiresAt: Date.now() + 1000 };
  const finished = retainAgentContextAuthority(auth, fresh);
  finished.release();
  vi.advanceTimersByTime(1001);
  revokeAuthSession(auth);
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

it('does not relabel a transport error when the browser deadline passes before its timer runs', () => {
  vi.useFakeTimers();
  const deadline = Date.now() + 1000;
  const controller = new AbortController();
  const scope = retainAgentContextAuthority(
    { id: crypto.randomUUID(), expiresAt: deadline },
    controller,
  );
  try {
    vi.setSystemTime(deadline);
    const error = new Error('connection closed');
    expect(agentContextRuntimeError(error, scope.assertCurrent)).toBe(error);
    vi.advanceTimersByTime(1000);
    expect(controller.signal.aborted).toBe(false);
  } finally {
    scope.release();
  }
});

it('rejects an already expired login before retaining run authority', () => {
  const controller = new AbortController();
  expect(() =>
    retainAgentContextAuthority({ id: crypto.randomUUID(), expiresAt: Date.now() }, controller),
  ).toThrow(/expired/i);
});

it('preserves explicit cancellation after browser expiry', () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const scope = retainAgentContextAuthority(
    { id: crypto.randomUUID(), expiresAt: Date.now() + 1000 },
    controller,
  );
  try {
    vi.advanceTimersByTime(1001);
    const cancellation = new Error('Operator cancelled the turn');
    controller.abort(cancellation);
    expect(() => scope.assertCurrent()).toThrow(cancellation);
    expect(scope.failure()).toBeUndefined();
  } finally {
    scope.release();
  }
});
