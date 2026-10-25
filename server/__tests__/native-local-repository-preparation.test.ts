import { afterEach, expect, it, vi } from 'vitest';
import { executeNativeLocalRepositoryPreparation } from '../native-local-repository-preparation.js';
import { executeLocalRepositoryPreparation } from '../local-repository-preparation-operation.js';
import { captureNativeLocalRepositoryPreparationSource } from '../local-repository-preparation-source.js';
import { pendingHostTaskDecisionHash } from '../pending-host-task.js';
import type { NativeHostToolContext } from '../native-host-tool-context.js';

vi.mock('../local-repository-preparation-operation.js', async (original) => ({
  ...(await original<typeof import('../local-repository-preparation-operation.js')>()),
  executeLocalRepositoryPreparation: vi.fn(),
}));
vi.mock('../local-repository-preparation-source.js', async (original) => ({
  ...(await original<typeof import('../local-repository-preparation-source.js')>()),
  captureNativeLocalRepositoryPreparationSource: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});
function fixture(dispose?: () => void | Promise<void>) {
  const controller = new AbortController(),
    lifetime = new AbortController();
  const input = { path: '/fixture/source' };
  const binding = {
    accountId: 'offline',
    accountLabel: 'Offline',
    provider: 'openai-codex' as const,
    model: 'fixture',
    profileRevision: 'p',
  };
  const target = Object.freeze({
    commandId: 'command',
    attempt: 1,
    threadId: 'thread',
    turnId: 'turn',
    generation: 0,
  });
  let closed = false,
    context!: NativeHostToolContext,
    capturedSignal!: AbortSignal;
  const scope = Object.freeze({ private: 'original-scope' }),
    facet = Object.freeze(() => scope);
  const current = vi.fn(function (this: unknown) {
    expect(this).toBe(context);
    if (closed) throw Error('original context closed');
    context.signal.throwIfAborted();
  });
  const full = vi.fn(async function (this: unknown) {
    Reflect.apply(current, this, []);
  });
  const capture = vi.fn(function (this: unknown, signal: AbortSignal) {
    expect(this).toBe(owners);
    capturedSignal = signal;
    context = Object.freeze(
      Object.defineProperties<object>(
        {
          toolName: 'PrepareLocalRepository',
          callId: 'call',
          turnId: 'turn',
          conversationId: 'session',
          runtimeId: 'runtime',
          nativeTarget: target,
          requestHash: pendingHostTaskDecisionHash(input),
          session: { accountBinding: binding },
          accountBinding: binding,
          signal: AbortSignal.any([signal, lifetime.signal]),
          assertCurrentSync: current,
          assertCurrent: full,
          async dispose() {
            expect(this).toBe(context);
            await dispose?.();
            closed = true;
            lifetime.abort();
          },
        },
        { nativeBaseReadScope: { value: scope }, captureNativeReadOwner: { value: facet } },
      ),
    ) as unknown as NativeHostToolContext;
    return context;
  });
  const owners = { capture, events: {}, registry: {}, workspaces: {} } as unknown as Parameters<
    typeof executeNativeLocalRepositoryPreparation
  >[0];
  const receipt = () => ({
    version: 1,
    request: {
      id: '12345678-1234-4234-8234-123456789abc',
      binding,
      conversationId: 'session',
      runtimeId: 'runtime',
      nativeTarget: target,
      prepareCallId: 'call',
      requestHash: pendingHostTaskDecisionHash(input),
      taskRoot: '/fixture/tasks',
      runtimeBinding: {
        version: 2,
        account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'p' },
        harness: { implementation: 'codex' },
        execution: { location: 'local', targetId: 'local', targetRevision: 'r' },
      },
    },
    rootIdentity: { dev: 1, ino: 1 },
    directory: '/fixture/tasks/new',
    sourceDigest: 'f'.repeat(64),
    state: 'materialized',
    taskIdentity: {
      directory: '/fixture/tasks/new',
      featureBranch: 'mitzo/new',
      root: { dev: 1, ino: 2 },
      git: { dev: 1, ino: 3 },
    },
  });
  const packed = Object.freeze({ kind: 'absent' });
  const qualified = Object.defineProperty({}, 'publicationPackedRefs', { value: packed });
  vi.mocked(captureNativeLocalRepositoryPreparationSource).mockResolvedValue(qualified as never);
  vi.mocked(executeLocalRepositoryPreparation).mockImplementation(async (actual, raw, envelope) => {
    expect(actual.context).toBe(context);
    expect(raw).toBe(input);
    expect(context.signal).not.toBe(envelope.signal);
    expect(capturedSignal).toBe(envelope.signal);
    expect(context.nativeBaseReadScope).toBe(scope);
    expect(context.captureNativeReadOwner).toBe(facet);
    const intent = Object.freeze({
      workspaceId: receipt().request.id,
      sourcePath: input.path,
      taskRoot: '/fixture/tasks',
    });
    const options = Object.freeze({ deadline: envelope.deadline });
    const source = await Reflect.apply(actual.qualifySource, actual, [
      input.path,
      context,
      intent,
      options,
    ]);
    expect(source).toBe(qualified);
    expect(Object.getOwnPropertyDescriptor(source, 'publicationPackedRefs')?.value).toBe(packed);
    expect(captureNativeLocalRepositoryPreparationSource).toHaveBeenCalledWith(
      context,
      intent,
      options,
    );
    return receipt() as never;
  });
  return {
    owners,
    input,
    controller,
    capture,
    current,
    full,
    receipt,
    context: () => context,
    closed: () => closed,
    capturedSignal: () => capturedSignal,
  };
}
it('mints the actual envelope before original capture and forwards exact context/intent/fourth options/packed witness', async () => {
  const f = fixture();
  const result = await executeNativeLocalRepositoryPreparation(
    f.owners,
    f.input,
    f.controller.signal,
  );
  expect(result).toEqual({
    isError: false,
    content: JSON.stringify({
      preparationId: f.receipt().request.id,
      directory: '/fixture/tasks/new',
      state: 'materialized',
    }),
  });
  expect(f.capture).toHaveBeenCalledOnce();
  expect(f.closed()).toBe(true);
  expect(f.capturedSignal().aborted).toBe(true);
  expect(result.content).not.toContain('runtimeId');
});
it('joins original context disposal before returning normalized success', async () => {
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(() => cleanup);
  let settled = false;
  const pending = executeNativeLocalRepositoryPreparation(
    f.owners,
    f.input,
    f.controller.signal,
  ).finally(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(executeLocalRepositoryPreparation).toHaveBeenCalled());
  expect(settled).toBe(false);
  release();
  await pending;
  expect(f.closed()).toBe(true);
});
it.each([
  'deny',
  'operation-cleanup',
  'context-cleanup',
  'cancel',
  'expiry',
  'wrong-receipt',
  'wrong-context',
  'wrong-path',
] as const)('withholds success after %s', async (kind) => {
  if (kind === 'expiry') vi.useFakeTimers();
  const f = fixture(
    kind === 'context-cleanup'
      ? async () => {
          throw Error('cleanup failed');
        }
      : undefined,
  );
  const original = vi.mocked(executeLocalRepositoryPreparation).getMockImplementation()!;
  vi.mocked(executeLocalRepositoryPreparation).mockImplementation(async (actual, raw, envelope) => {
    if (kind === 'deny' || kind === 'operation-cleanup') throw Error(kind);
    if (kind === 'cancel') f.controller.abort();
    if (kind === 'expiry') await vi.advanceTimersByTimeAsync(300001);
    if (kind === 'wrong-context' || kind === 'wrong-path') {
      const intent = Object.freeze({
        workspaceId: f.receipt().request.id,
        sourcePath: f.input.path,
        taskRoot: '/fixture/tasks',
      });
      await actual.qualifySource(
        kind === 'wrong-path' ? '/other' : f.input.path,
        kind === 'wrong-context' ? { ...actual.context } : actual.context,
        intent,
        { deadline: envelope.deadline },
      );
    }
    const result = await original(actual, raw, envelope);
    if (kind === 'wrong-receipt')
      return { ...result, request: { ...result.request, prepareCallId: 'other' } };
    return result;
  });
  await expect(
    executeNativeLocalRepositoryPreparation(f.owners, f.input, f.controller.signal),
  ).rejects.toThrow();
  expect(f.capture).toHaveBeenCalledOnce();
});
