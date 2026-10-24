import { afterEach, expect, it, vi } from 'vitest';
import { waitForChange } from '../wait-for-change.js';
import { EventStore } from '../event-store.js';
import { randomUUID } from 'node:crypto';
afterEach(() => vi.useRealTimers());
it('subscribes before reading and releases subscriptions without repeated polling', async () => {
  let value = 0;
  let wake = () => {};
  const unsubscribe = vi.fn();
  const read = vi.fn(() => value);
  const pending = waitForChange({
    signal: new AbortController().signal,
    timeoutMs: 10000,
    subscribe: (fn) => {
      wake = fn;
      return unsubscribe;
    },
    read,
    changed: (n) => n > 0,
  });
  expect(read).toHaveBeenCalledTimes(1);
  value = 1;
  wake();
  await expect(pending).resolves.toEqual({ changed: true, value: 1 });
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledTimes(2);
});
it('handles immediate change, timeout, revocation and cancellation without leaking a waiter', async () => {
  vi.useFakeTimers();
  const signal = new AbortController();
  const unsubscribe = vi.fn();
  const timeout = waitForChange({
    signal: signal.signal,
    timeoutMs: 10,
    subscribe: () => unsubscribe,
    read: () => 0,
    changed: () => false,
  });
  await vi.advanceTimersByTimeAsync(10);
  await expect(timeout).resolves.toEqual({ changed: false, value: 0 });
  let wake = () => {};
  let current = true;
  const revoked = waitForChange({
    signal: signal.signal,
    timeoutMs: 1000,
    subscribe: (fn) => {
      wake = fn;
      return unsubscribe;
    },
    read: () => {
      if (!current) throw Error('revoked');
      return 0;
    },
    changed: () => false,
  });
  const rejected = expect(revoked).rejects.toThrow('revoked');
  current = false;
  wake();
  await rejected;
  const cancelled = waitForChange({
    signal: signal.signal,
    timeoutMs: 1000,
    subscribe: () => unsubscribe,
    read: () => 0,
    changed: () => false,
  });
  const aborted = expect(cancelled).rejects.toThrow('stopped');
  signal.abort(Error('stopped'));
  await aborted;
  expect(vi.getTimerCount()).toBe(0);
});
it('wakes on durable peer message changes and isolates unrelated conversations', async () => {
  const events = new EventStore(':memory:');
  try {
    const a = vi.fn(),
      unrelated = vi.fn();
    const stop = events.agentCommunication.subscribe('recipient', a),
      stopOther = events.agentCommunication.subscribe('other', unrelated);
    const message = events.agentCommunication.reserve(
      'sender',
      'operator',
      { turnId: 'turn', callId: 'call' },
      { requestId: randomUUID(), recipientConversationId: 'recipient', text: 'Ready' },
    );
    await Promise.resolve();
    expect(a).toHaveBeenCalledOnce();
    expect(unrelated).not.toHaveBeenCalled();
    events.agentCommunication.recordForHost(message.messageId, 'delivered');
    await Promise.resolve();
    expect(a).toHaveBeenCalledTimes(2);
    stop();
    stopOther();
    events.agentCommunication.recordForHost(message.messageId, 'delivered');
    await Promise.resolve();
    expect(a).toHaveBeenCalledTimes(2);
  } finally {
    events.close();
  }
});
