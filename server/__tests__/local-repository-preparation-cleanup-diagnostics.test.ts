import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexToolFailure,
  codexToolFailureResult,
  withCodexToolCleanup,
} from '../codex-tool-failure.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { PendingHostTaskError, pendingHostTaskDecisionHash } from '../pending-host-task.js';
import { captureLocalRepositoryPreparationAuthorization } from '../local-repository-preparation-authorization.js';
import { captureLocalRepositoryPreparationObjectData } from '../local-repository-preparation-object-data.js';
import { captureNativeLocalRepositoryPreparationSource } from '../local-repository-preparation-source.js';
import {
  executeLocalRepositoryPreparation,
  withLocalRepositoryPreparationEnvelope,
  type LocalRepositoryPreparationOwners,
} from '../local-repository-preparation-operation.js';
import { executeNativeLocalRepositoryPreparation } from '../native-local-repository-preparation.js';
import { captureNativeLocalRepositoryReader } from '../local-repository-native-read.js';
import { assertPreparedRepositoryTaskTopology } from '../prepared-repository-workspace-owner.js';
import type { NativeHostToolContext } from '../native-host-tool-context.js';

vi.mock('../local-repository-preparation-authorization.js', async (original) => ({
  ...(await original<typeof import('../local-repository-preparation-authorization.js')>()),
  captureLocalRepositoryPreparationAuthorization: vi.fn(),
}));
vi.mock('../local-repository-preparation-object-data.js', () => ({
  captureLocalRepositoryPreparationObjectData: vi.fn(),
}));
vi.mock('../local-repository-preparation-source.js', async (original) => ({
  ...(await original<typeof import('../local-repository-preparation-source.js')>()),
  captureNativeLocalRepositoryPreparationSource: vi.fn(),
}));
vi.mock('../local-repository-native-read.js', async (original) => ({
  ...(await original<typeof import('../local-repository-native-read.js')>()),
  captureNativeLocalRepositoryReader: vi.fn(),
}));
vi.mock('../prepared-repository-workspace-owner.js', async (original) => ({
  ...(await original<typeof import('../prepared-repository-workspace-owner.js')>()),
  assertPreparedRepositoryTaskTopology: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const typed = (reason: 'deadline' | 'filesystem_denied') =>
  new CodexToolFailure('internal_failure', {
    stage: 'repository_preparation',
    reason,
    effectStatus: 'not_started',
  });
const errno = (code: string) => Object.assign(Error('SECRET /private/credential'), { code });
function fixture() {
  const controller = new AbortController();
  const input = { path: '/fixture/source' };
  const order: string[] = [];
  const full = vi.fn(async () => {
    controller.signal.throwIfAborted();
  });
  const sync = vi.fn(() => {
    controller.signal.throwIfAborted();
  });
  const dispose = vi.fn(async () => {
    order.push('context');
  });
  const context = Object.freeze({
    signal: controller.signal,
    assertCurrent: full,
    assertCurrentSync: sync,
    dispose,
    toolName: 'PrepareLocalRepository',
    requestHash: pendingHostTaskDecisionHash(input),
    session: { accountBinding: {} },
    nativeTarget: { commandId: 'command' },
    workspace: { id: 'workspace', directory: '/fixture/task' },
  }) as unknown as NativeHostToolContext;
  const objects = {
    dispose: vi.fn(async () => {
      order.push('objects');
    }),
  };
  const held = {
    owner: { assertCurrent: vi.fn(async () => {}) },
    approve: vi.fn(async () => {}),
    materialize: vi.fn(async () => ({ state: 'materialized' })),
  };
  vi.mocked(captureLocalRepositoryPreparationAuthorization).mockResolvedValue(held as never);
  vi.mocked(captureLocalRepositoryPreparationObjectData).mockResolvedValue(objects as never);
  const owners = { context, qualifySource: vi.fn() } as unknown as LocalRepositoryPreparationOwners;
  const run = () =>
    withLocalRepositoryPreparationEnvelope(controller.signal, (envelope) =>
      executeLocalRepositoryPreparation(owners, input, envelope),
    );
  return { controller, input, order, context, full, sync, dispose, objects, held, owners, run };
}
async function failed(action: () => Promise<unknown>, aborted = false) {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  const result = codexToolFailureResult(caught, aborted, undefined, 'repository_preparation');
  expect(result.isError).toBe(true);
  expect(result.content).not.toMatch(/SECRET|private|credential/);
  return { result, value: JSON.parse(result.content) };
}

it.each(['deadline', 'filesystem_denied'] as const)(
  'retains primary %s and all cleanup/revalidation uncertainty through durable tool replay',
  async (reason) => {
    const f = fixture();
    f.held.approve.mockRejectedValue(typed(reason));
    f.objects.dispose.mockImplementation(async () => {
      f.order.push('objects');
      throw errno('ENOSPC');
    });
    f.full.mockRejectedValue(errno('ETIMEDOUT'));
    const { result, value } = await failed(f.run);
    expect(value.diagnostic).toMatchObject({
      stage: 'repository_preparation',
      reason,
      effectStatus: 'unknown',
      primary: { stage: 'repository_preparation', reason, effectStatus: 'not_started' },
      cleanup: [
        { stage: 'repository_preparation', reason: 'storage_full', effectStatus: 'unknown' },
        { stage: 'repository_preparation', reason: 'deadline', effectStatus: 'unknown' },
      ],
    });
    expect(f.full).toHaveBeenCalledOnce();
    expect(f.sync).toHaveBeenCalledTimes(4); // final current check runs even after full revalidation fails
    expect(f.held.materialize).not.toHaveBeenCalled();
    const root = mkdtempSync(join(tmpdir(), 'mitzo-cleanup-receipt-'));
    const path = join(root, 'native.db');
    const binding = {
      accountId: 'offline',
      accountLabel: 'Offline',
      provider: 'openai-codex',
      model: 'synthetic',
      profileRevision: 'p',
    };
    const identity = {
      turnId: 'turn',
      toolName: 'PrepareLocalRepository',
      requestHash: 'a'.repeat(64),
    };
    let store = new CodexConversationStore(path);
    try {
      store.create('chat', binding, '/fixture');
      store.enqueue('chat', binding, { id: 'command', prompt: 'prepare' });
      store.claimNext('chat', binding);
      expect(store.claimTool('chat', binding, 'command', 'call', identity)).toBe(true);
      store.recordToolResult('chat', binding, 'command', 'call', identity, result);
      store.close();
      store = new CodexConversationStore(path);
      expect(store.replayToolResult('chat', binding, 'command', 'call', identity)).toEqual(result);
      expect(() =>
        store.replayToolResult(
          'chat',
          { ...binding, accountId: 'other' },
          'command',
          'call',
          identity,
        ),
      ).toThrow();
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('keeps custody revocation visible when the primary error was generic', async () => {
  const f = fixture();
  f.held.approve.mockRejectedValue(Error('SECRET original'));
  f.full.mockRejectedValue(new PendingHostTaskError('pending_host_task_ownership_changed'));
  const { value } = await failed(f.run);
  expect(value.error).toBe('stale_owner');
  expect(value.diagnostic).toMatchObject({
    reason: 'custody_changed',
    effectStatus: 'unknown',
    primary: { reason: 'unknown' },
    cleanup: [{ reason: 'custody_changed' }],
  });
});

it('withholds successful materialization after cleanup failure', async () => {
  const f = fixture();
  f.objects.dispose.mockRejectedValue(errno('EPERM'));
  const { value } = await failed(f.run);
  expect(f.held.materialize).toHaveBeenCalledOnce();
  expect(value.diagnostic).toMatchObject({
    reason: 'filesystem_denied',
    effectStatus: 'unknown',
    cleanup: [{ reason: 'filesystem_denied' }],
  });
  expect(value.diagnostic.primary).toBeUndefined();
});

it('retains cancellation and the typed primary while joining cleanup', async () => {
  const f = fixture();
  f.held.approve.mockImplementation(async () => {
    f.controller.abort();
    throw typed('deadline');
  });
  f.objects.dispose.mockRejectedValue(errno('EPERM'));
  const { value } = await failed(f.run);
  expect(value.error).toBe('cancelled');
  expect(value.diagnostic).toMatchObject({
    reason: 'cancelled',
    effectStatus: 'unknown',
    primary: { reason: 'deadline' },
  });
  expect(f.objects.dispose).toHaveBeenCalledOnce();
  expect(f.full).toHaveBeenCalledOnce();
});

it('native composition joins every source and context after primary and multiple cleanup failures', async () => {
  const f = fixture();
  const sourceDisposers = [0, 1].map((index) =>
    vi.fn(async () => {
      f.order.push(`source-${index}`);
      throw errno(index ? 'ETIMEDOUT' : 'EPERM');
    }),
  );
  vi.mocked(captureNativeLocalRepositoryPreparationSource)
    .mockResolvedValueOnce({ dispose: sourceDisposers[0] } as never)
    .mockResolvedValueOnce({ dispose: sourceDisposers[1] } as never);
  vi.mocked(captureLocalRepositoryPreparationAuthorization).mockImplementation(async (owners) => {
    for (let index = 0; index < 2; index++)
      await owners.qualifySource(f.input.path, f.context, { sourcePath: f.input.path } as never);
    throw typed('deadline');
  });
  f.dispose.mockImplementation(async () => {
    f.order.push('context');
    throw new PendingHostTaskError('pending_host_task_ownership_changed');
  });
  const owners = {
    capture: () => f.context,
    events: {},
    registry: {},
    workspaces: { findLocalRepositoryPreparation: () => undefined },
  } as unknown as Parameters<typeof executeNativeLocalRepositoryPreparation>[0];
  const { value } = await failed(() =>
    executeNativeLocalRepositoryPreparation(owners, f.input, f.controller.signal),
  );
  expect(f.order).toEqual(['source-0', 'source-1', 'context']);
  expect(value.error).toBe('stale_owner');
  expect(value.diagnostic).toMatchObject({
    reason: 'custody_changed',
    effectStatus: 'unknown',
    primary: { reason: 'deadline' },
    cleanup: [
      { reason: 'filesystem_denied' },
      { reason: 'deadline' },
      { reason: 'custody_changed' },
    ],
  });
});

it('preserves active-task validation failure through reader and context cleanup', async () => {
  const f = fixture();
  const readerDispose = vi.fn(async () => {
    throw errno('EPERM');
  });
  vi.mocked(captureNativeLocalRepositoryReader).mockResolvedValue({
    deniedRoots: [],
    dispose: readerDispose,
  } as never);
  vi.mocked(assertPreparedRepositoryTaskTopology).mockRejectedValue(typed('deadline'));
  f.dispose.mockRejectedValue(new PendingHostTaskError('pending_host_task_ownership_changed'));
  const owners = {
    capture: () => f.context,
    events: {},
    registry: {},
    workspaces: {
      findLocalRepositoryPreparation: () => ({
        id: 'workspace',
        state: 'claimed',
        taskIdentity: {},
        qualifiedLocalPreparation: {
          allocationFacts: { source: { gitDirectory: '/fixture/git' } },
        },
      }),
    },
  } as unknown as Parameters<typeof executeNativeLocalRepositoryPreparation>[0];
  const { value } = await failed(() =>
    executeNativeLocalRepositoryPreparation(owners, f.input, f.controller.signal),
  );
  expect(value.error).toBe('stale_owner');
  expect(value.diagnostic).toMatchObject({
    effectStatus: 'unknown',
    primary: { reason: 'deadline', effectStatus: 'not_started' },
    cleanup: [{ reason: 'filesystem_denied' }, { reason: 'custody_changed' }],
  });
  expect(readerDispose).toHaveBeenCalledOnce();
  expect(f.dispose).toHaveBeenCalledOnce();
  expect(captureLocalRepositoryPreparationAuthorization).not.toHaveBeenCalled();
});

it('bounds cleanup output while retaining a later custody refusal and joining every cleanup', async () => {
  const order: number[] = [];
  const { value } = await failed(() =>
    withCodexToolCleanup(
      async () => {
        throw typed('deadline');
      },
      Array.from({ length: 12 }, (_, index) => async () => {
        order.push(index);
        if (index === 11) throw new PendingHostTaskError('pending_host_task_ownership_changed');
        throw errno('EPERM');
      }),
    ),
  );
  expect(order).toEqual(Array.from({ length: 12 }, (_, index) => index));
  expect(value.error).toBe('stale_owner');
  expect(value.diagnostic).toMatchObject({
    reason: 'custody_changed',
    effectStatus: 'unknown',
    primary: { reason: 'deadline' },
    cleanupTruncated: true,
  });
  expect(value.diagnostic.cleanup).toHaveLength(8);
});
