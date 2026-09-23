import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DELIBERATION_CONFIG, type ModelProvider } from '@mitzo/harness';
import { EventStore } from '../event-store.js';
import { startDeliberation, cancelDeliberation } from '../deliberate-admission.js';

const response = {
  content: 'answer',
  model: 'fake',
  usage: { inputTokens: 1, outputTokens: 1 },
  costUsd: 0.01,
};

describe('durable deliberation', () => {
  let store: EventStore;
  let dir: string;
  let call: ReturnType<typeof vi.fn<ModelProvider['call']>>;
  let createProvider: ReturnType<typeof vi.fn<(model: string) => ModelProvider>>;
  const config = { ...DEFAULT_DELIBERATION_CONFIG, maxRounds: 1 };
  const request = { sessionId: 's', clientMsgId: 'c', task: 'Design this' };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deliberate-'));
    store = new EventStore(join(dir, 'events.db'));
    store.upsertSession({ sessionId: 's' });
    call = vi.fn<ModelProvider['call']>().mockResolvedValue(response);
    createProvider = vi.fn<(model: string) => ModelProvider>(() => ({ name: 'fake', call }));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function start(overrides = {}, options = {}) {
    return startDeliberation({
      store,
      request: { ...request, ...overrides },
      config,
      routeRevision: () => 'route-1',
      createProvider,
      ...options,
    });
  }
  it('admits one root before construction/events and attributes every paid call', async () => {
    createProvider.mockImplementation(() => {
      expect(store.getExecutionAdmission('s', 'c')).toBeDefined();
      return { name: 'fake', call };
    });
    call.mockImplementation(async () => {
      const token = store.getExecutionAdmission('s', 'c')!.token;
      expect(store.getProviderAttempts(token).filter((a) => a.phase === 'RUNNING')).toHaveLength(1);
      return response;
    });
    const events = vi.fn(() => expect(store.getExecutionAdmission('s', 'c')).toBeDefined());
    await start({}, { onEvent: events }).completion;
    const token = store.getExecutionAdmission('s', 'c')!.token;
    expect(store.getProviderAttempts(token).map((a) => a.token.providerAttemptId)).toEqual(
      ['propose', 'challenge-1', 'respond-1', 'converge'].map(
        (p) => `deliberate:${token.executionId}:${p}`,
      ),
    );
    expect(store.getProviderAttempts(token).every((a) => a.terminalReason === 'completed')).toBe(
      true,
    );
    expect(store.getSession('s')?.executionTerminalReason).toBe('completed');
    expect(events).toHaveBeenCalled();
  });
  it('deduplicates running and completed retries including whitespace normalization', async () => {
    let release!: (value: typeof response) => void;
    call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = start();
    expect(start({ task: '  Design this  ' }).duplicate).toBe(true);
    release(response);
    await first.completion;
    expect(start().duplicate).toBe(true);
    expect(createProvider).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledTimes(4);
  });
  it.each([
    [{ task: 'changed' }, {}],
    [{ selection: { accountId: 'other' } }, {}],
    [{ selection: { model: 'other' } }, {}],
    [{ selection: { reasoningEffort: 'high' } }, {}],
    [{}, { routeRevision: () => 'route-2' }],
    [{}, { config: { ...config, maxRounds: 2 } }],
  ])(
    'rejects changed intent/config/identity before side effects (%j)',
    async (requestChange, options) => {
      await start().completion;
      const before = createProvider.mock.calls.length;
      expect(() => start(requestChange, options)).toThrow(/different request/);
      expect(createProvider).toHaveBeenCalledTimes(before);
    },
  );
  it('does not construct providers when admission storage fails', () => {
    vi.spyOn(store, 'beginExecution').mockImplementation(() => {
      throw new Error('disk');
    });
    expect(() => start()).toThrow();
    expect(createProvider).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });
  it('terminalizes constructor failure without leaking provider details', async () => {
    createProvider.mockImplementation(() => {
      throw new Error('SECRET endpoint');
    });
    expect(await start().completion).toMatchObject({ status: 'failed' });
    expect(store.getSession('s')?.executionTerminalReason).toBe('startup_failed');
    expect(store.getProviderAttempts(store.getExecutionAdmission('s', 'c')!.token)).toHaveLength(0);
  });
  it.each([false, true])(
    'recovers a disk-backed crash (attempt started: %s) without redispatch',
    async (started) => {
      await start().completion;
      const fingerprint = store.getExecutionAdmission('s', 'c')!.requestFingerprint;
      store.upsertSession({ sessionId: 'crash' });
      const { token } = store.beginExecution('crash', undefined, 'crash-c', fingerprint);
      if (started) store.beginProviderAttempt(token, `deliberate:${token.executionId}:propose`);
      store.close();
      store = new EventStore(join(dir, 'events.db'));
      store.recoverOrphanedExecutions();
      call.mockClear();
      createProvider.mockClear();
      const retry = start({ sessionId: 'crash', clientMsgId: 'crash-c' });
      expect(retry.duplicate).toBe(true);
      expect(await retry.completion).toMatchObject({ status: started ? 'ambiguous' : 'failed' });
      expect(call).not.toHaveBeenCalled();
      expect(createProvider).not.toHaveBeenCalled();
      if (started) {
        expect(() => start({ sessionId: 'crash', clientMsgId: 'new' })).toThrow(/confirmation/i);
        await start({ sessionId: 'crash', clientMsgId: 'new', confirmAmbiguous: true }).completion;
        expect(call).toHaveBeenCalledTimes(4);
      }
    },
  );
  it('records truthful partial attempts and sanitizes challenger failure', async () => {
    call.mockResolvedValueOnce(response).mockRejectedValueOnce(new Error('SECRET payload'));
    const result = await start().completion;
    expect(result).toMatchObject({ status: 'ambiguous' });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    const token = store.getExecutionAdmission('s', 'c')!.token;
    expect(store.getProviderAttempts(token).map((a) => a.terminalReason)).toEqual([
      'completed',
      'ambiguous',
    ]);
    expect(store.getSession('s')?.executionTerminalReason).toBe('failed');
  });
  it('cancels once, fences late completion and prevents later child dispatch', async () => {
    let release!: (value: typeof response) => void;
    call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const running = start();
    expect(cancelDeliberation(store, 's')).toBe(true);
    expect(cancelDeliberation(store, 's')).toBe(false);
    expect(store.getSession('s')?.executionTerminalReason).toBe('stopped');
    release(response);
    expect(await running.completion).toMatchObject({ status: 'cancelled' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(store.getSession('s')?.executionTerminalReason).toBe('stopped');
  });
});
