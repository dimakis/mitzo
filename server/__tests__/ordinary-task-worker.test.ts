import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { TaskStore } from '../task-store.js';
import { bindOrdinaryTaskWorkerSession } from '../ordinary-task-worker.js';
const calls = vi.hoisted(() => ({
  dispatch: vi.fn(),
  reserve: vi.fn(),
  inventory: vi.fn(),
  capture: vi.fn(),
  recovery: vi.fn(),
}));
vi.mock('../ordinary-scoped-command.js', () => ({ dispatchOwnedOrdinaryCommand: calls.dispatch }));
vi.mock('../ordinary-local-codex-entry.js', () => ({
  ordinaryRepositoryRuntimeInventory: calls.inventory,
}));
vi.mock('../agent-library-transport.js', () => ({
  captureAgentLibraryAuthorization: calls.capture,
  withAgentLibraryRecoveryAuthorization: calls.recovery,
}));
vi.mock('../auth.js', () => ({ registerAuthSession: () => () => {} }));
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const close of cleanups.splice(0).reverse()) close();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-worker-adapter-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const tasks = new TaskStore(join(root, 'tasks.db'));
  cleanups.push(() => tasks.close());
  const task = tasks.create({
    title: 'Worker',
    description: '',
    annotations: ['worker_allocation: 7aa6a744-d27c-4eca-a49c-bde6c305ab10'],
  });
  tasks.update(task.id, { status: 'active' });
  const account = {
    accountId: 'selected',
    accountLabel: 'Selected',
    provider: 'openai-codex' as const,
    profileRevision: 'r1',
    model: 'selected-model',
  };
  const binding = {
    version: 2 as const,
    account: {
      accountId: account.accountId,
      provider: account.provider,
      profileRevision: account.profileRevision,
    },
    harness: { implementation: 'codex' as const },
    execution: {
      location: 'local' as const,
      targetId: 'selected-target',
      targetRevision: 'target-r1',
    },
  };
  const definition = {
    name: 'Worker',
    descriptor: 'Task agent',
    role: 'agent' as const,
    instructions: 'Work',
    expectedOutput: 'Evidence',
    acceptanceCriteria: ['Task complete'],
    modelPolicyRole: 'agent' as const,
  };
  const profile = {
    profileId: 'selected-agent',
    revision: 1,
    definition,
    contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
  };
  const selection = {
    version: 1 as const,
    agent: { profileId: profile.profileId, revision: 1 },
    context: { source: 'none' as const, revision: null },
    permission: { mode: 'agent' as const, revision: 0 },
    model: account.model,
    thinking: null,
  };
  const settings = {
    version: 2 as const,
    binding,
    selection,
    workspace: { kind: 'ordinary' as const, preparationId: 'ad520d88-a8f7-49d9-9e57-798fdb287c80' },
  };
  const meta = {
    sessionId: 'source',
    ordinaryWorkspaceId: 'source-workspace',
    cwd: '/tmp/source',
    accountBinding: account,
    selectedModel: account.model,
    reasoningEffort: null,
    mode: 'agent',
    agentProfile: profile,
  };
  const source = {
    sessionId: 'source',
    ownerConnectionId: 'source-connection',
    accountBinding: account,
    mode: 'agent',
    model: account.model,
  };
  const record = {
    id: 'child-workspace',
    conversationId: 'worker-conversation',
    directory: '/tmp/worker',
    preparationFingerprint: 'a'.repeat(64),
    binding: account,
    settings,
    agentProfile: profile,
    allocationOperationId: '7aa6a744-d27c-4eca-a49c-bde6c305ab10',
    hostReservation: { taskRoot: root },
  };
  const prepared = vi.fn();
  const events = {
    getSession: vi.fn(() => structuredClone(meta)),
    getSessionRuntimeBinding: vi.fn(() => structuredClone(binding)),
    getOrdinaryWorkspaceConversationSettings: vi.fn(() => structuredClone(settings)),
    getOrdinaryConversationSettings: vi.fn(() => undefined),
    getOrdinaryWorkspaceSessionPreparation: vi.fn(() => undefined),
    prepareOrdinaryWorkspaceSession: prepared,
  };
  const workspaces = {
    reserveOrdinaryWorkspace: calls.reserve.mockImplementation(async (input) => ({
      ...record,
      binding: input.binding,
      settings: input.settings,
    })),
    prepareOrdinaryWorkspace: vi
      .fn()
      .mockResolvedValue({
        preparationId: '4dd560bc-44c5-4de8-95bc-9e65469f7880',
        runtimeBinding: binding,
      }),
    qualifyOrdinaryWorkspace: vi.fn(),
    getOrdinaryWorkspaceForOperation: vi.fn(() => undefined),
  };
  calls.capture.mockReturnValue({
    auth: { id: 'operator', expiresAt: Date.now() + 60000 },
    assertCurrent: vi.fn(),
  });
  calls.recovery.mockImplementation((_auth, run) => run('retained-operator'));
  calls.inventory.mockReturnValue({
    profiles: {
      resolve: (_id: string, model: string) => ({ ...account, model }),
      validateModelSelection: vi.fn(),
    },
    catalog: { resolve: () => ({ status: 'compatible', binding }) },
    result: {
      capabilityRevision: 'cap-r1',
      routes: [{ account: binding.account, targetId: binding.execution.targetId }],
    },
  });
  calls.dispatch.mockResolvedValue({ sessionId: 'worker-conversation', dispatched: true });
  const deps = { events, tasks, workspaces, source: () => source, taskRoot: () => root };
  return {
    tasks,
    task,
    settings,
    meta,
    account,
    source,
    record,
    events,
    workspaces,
    prepared,
    deps,
  };
}

it('allocates and dispatches a worker through the exact selected ordinary owner with durable linkage before dispatch', async () => {
  const f = fixture();
  const spawn = bindOrdinaryTaskWorkerSession(f.deps as never, 'selected-client');
  calls.dispatch.mockImplementationOnce(async (input) => {
    expect(f.prepared).toHaveBeenCalledTimes(1);
    expect(f.tasks.get(f.task.id)?.sessionId).toBe(
      'task-worker:7aa6a744-d27c-4eca-a49c-bde6c305ab10',
    );
    expect(input.command.runtime.account).toEqual(f.settings.binding.account);
    expect(input.command.selection).toEqual(f.settings.selection);
    const session = {};
    input.onSessionPrepared(session);
    expect(session).toEqual({ taskContext: { currentTaskId: f.task.id, goalId: 'goal' } });
    return { sessionId: input.sessionId, dispatched: true };
  });
  expect(
    await spawn(f.task.id, 'Reviewed task', 'goal', vi.fn(), {
      operationId: f.record.allocationOperationId,
      signal: new AbortController().signal,
    }),
  ).toBe('task-worker:7aa6a744-d27c-4eca-a49c-bde6c305ab10');
  expect(calls.reserve).toHaveBeenCalledWith(
    expect.objectContaining({
      settings: {
        ...f.settings,
        workspace: { kind: 'ordinary', preparationId: '4dd560bc-44c5-4de8-95bc-9e65469f7880' },
      },
      binding: f.account,
      allocationOperationId: f.record.allocationOperationId,
    }),
  );
});

it('qualifies a fresh child proof for a supported source model change while preserving the original source preparation', async () => {
  const f = fixture();
  f.meta.selectedModel = 'supported-new-model';
  f.settings.selection.model = 'supported-new-model';
  f.source.model = 'supported-new-model';
  const original = structuredClone(f.settings);
  const spawn = bindOrdinaryTaskWorkerSession(f.deps as never, 'selected-client');
  await spawn(f.task.id, 'Reviewed task', 'goal', vi.fn(), {
    operationId: f.record.allocationOperationId,
    signal: new AbortController().signal,
  });
  expect(f.workspaces.prepareOrdinaryWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({
      binding: { ...f.account, model: 'supported-new-model' },
      selection: {
        runOn: 'local',
        runtime: {
          account: f.settings.binding.account,
          harness: 'codex',
          targetId: 'selected-target',
        },
      },
    }),
  );
  expect(calls.reserve).toHaveBeenCalledWith(
    expect.objectContaining({
      settings: expect.objectContaining({
        workspace: { kind: 'ordinary', preparationId: '4dd560bc-44c5-4de8-95bc-9e65469f7880' },
        selection: expect.objectContaining({ model: 'supported-new-model' }),
      }),
    }),
  );
  expect(f.settings).toEqual(original);
  expect(f.meta.accountBinding.model).toBe('selected-model');
});

it('rejects changed account/model/target selection before allocating or dispatching', async () => {
  const f = fixture();
  const spawn = bindOrdinaryTaskWorkerSession(f.deps as never, 'selected-client');
  f.meta.selectedModel = 'changed-model';
  await expect(
    spawn(f.task.id, 'Reviewed task', 'goal', vi.fn(), {
      operationId: f.record.allocationOperationId,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('Selected worker source changed');
  expect(calls.reserve).not.toHaveBeenCalled();
  expect(calls.dispatch).not.toHaveBeenCalled();
});

it('preserves operation and conversation evidence after uncertain dispatch without retrying', async () => {
  const f = fixture();
  const spawn = bindOrdinaryTaskWorkerSession(f.deps as never, 'selected-client');
  calls.dispatch.mockRejectedValueOnce(Error('uncertain'));
  await expect(
    spawn(f.task.id, 'Reviewed task', 'goal', vi.fn(), {
      operationId: f.record.allocationOperationId,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('uncertain');
  expect(f.tasks.get(f.task.id)?.annotations).toContain('worker_conversation: worker-conversation');
  expect(calls.dispatch).toHaveBeenCalledTimes(1);
});
