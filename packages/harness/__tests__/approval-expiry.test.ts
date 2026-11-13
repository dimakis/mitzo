import { afterEach, expect, it, vi } from 'vitest';
import { SessionRegistry } from '../src/session-registry.js';
import { buildPermissionHandler } from '../src/permission-handler.js';
import { resolvePending } from '../src/permissions.js';
import { toolFailure } from '@mitzo/protocol';

afterEach(() => vi.useRealTimers());

it.each(['Bash', 'PrepareLocalRepository', 'ConnectionRequest', 'TelosCreateFeature'])(
  '%s reports expiry consistently and accepts a fresh request in the same session',
  async (toolName) => {
    vi.useFakeTimers();
    const sent: Record<string, unknown>[] = [];
    const abort = new AbortController();
    const registry = new SessionRegistry();
    registry.register('client', {
      sessionId: 'session',
      mode: 'agent',
      abortController: abort,
      sessionAllowList: new Set(),
      transport: { isOpen: () => true, send: (event) => sent.push(event) },
    });
    try {
      const decide = buildPermissionHandler('client', registry);
      const input = { operation: 'bounded' };
      const options = { signal: abort.signal, toolUseID: 'first', forcePrompt: true };
      const first = decide(toolName, input, options);
      await vi.advanceTimersByTimeAsync(120_000);
      const failure = toolFailure('approval_expired', 'approval', 'not_started');
      expect(await first).toMatchObject({ behavior: 'deny', failure });
      expect(sent[1]).toMatchObject({ type: 'permission_timeout', failure });
      expect(abort.signal.aborted).toBe(false);
      expect(resolvePending(sent[0].permId as string, 'once')).toBe(false);
      const second = decide(toolName, input, { ...options, toolUseID: 'second' });
      await vi.advanceTimersByTimeAsync(0);
      expect(sent[2]).toMatchObject({ type: 'permission_request' });
      expect(sent[2].permId).not.toBe(sent[0].permId);
      resolvePending(sent[2].permId as string, 'once');
      expect(await second).toMatchObject({ behavior: 'allow', updatedInput: input });
    } finally {
      abort.abort();
      registry.dispose();
    }
  },
);

it('late responses receive the same structured timeout even before the timer runs', async () => {
  vi.useFakeTimers();
  const registry = new SessionRegistry();
  const sent: Record<string, unknown>[] = [];
  const abort = new AbortController();
  registry.register('client', {
    sessionId: 'session',
    mode: 'agent',
    abortController: abort,
    sessionAllowList: new Set(),
    transport: { isOpen: () => true, send: (event) => sent.push(event) },
  });
  try {
    const pending = buildPermissionHandler('client', registry)(
      'ConnectionRequest',
      {},
      {
        signal: abort.signal,
        toolUseID: 'late',
        forcePrompt: true,
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 120_001);
    expect(resolvePending(sent[0].permId as string, 'once')).toBe(false);
    expect(await pending).toMatchObject({
      behavior: 'deny',
      failure: toolFailure('approval_expired', 'approval', 'not_started'),
    });
    expect(sent[1]).toMatchObject({ type: 'permission_timeout' });
  } finally {
    abort.abort();
    registry.dispose();
  }
});
