import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventStore } from '../event-store.js';
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
vi.mock('../auth.js', () => ({
  registerAuthSession: () => () => {},
  isAuthSessionCurrent: (auth: { expiresAt: number }) => auth.expiresAt > Date.now(),
}));
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
    ordinaryWorkspaceId: '24064a82-976a-45c9-b9f2-c465b9d29d56',
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
    id: '7f3738a1-fb24-463c-8c71-ee66db43d012',
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
    getEventsOfType: vi.fn(() => []),
    append: vi.fn(),
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
    prepareOrdinaryWorkspace: vi.fn().mockResolvedValue({
      preparationId: '4dd560bc-44c5-4de8-95bc-9e65469f7880',
      runtimeBinding: binding,
    }),
    qualifyOrdinaryWorkspace: vi.fn(),
    getOrdinaryWorkspaceForOperation: vi.fn(() => undefined),
  };
  const auth = { id: 'operator', expiresAt: Date.now() + 60000 };
  calls.capture.mockReturnValue({
    auth,
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
    auth,
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
  const spawn = bindOrdinaryTaskWorkerSession(f.deps as never, 'selected-client', f.auth);
  calls.dispatch.mockImplementationOnce(async (input) => {
    expect(f.prepared).toHaveBeenCalledTimes(1);
    expect(f.tasks.get(f.task.id)?.sessionId).toBe(
      'task-worker:7aa6a744-d27c-4eca-a49c-bde6c305ab10',
    );
    expect(input.command.runtime.account).toEqual(f.settings.binding.account);
    expect(input.command.selection).toEqual(f.settings.selection);
    const session = {};
    input.onSessionPrepared(session);
    expect(f.events.append).toHaveBeenCalledWith(
      'worker-conversation',
      'ordinary_task_worker_allocation',
      {
        version: 1,
        taskId: f.task.id,
        goalId: 'goal',
        operationId: f.record.allocationOperationId,
        workerClientId: 'task-worker:' + f.record.allocationOperationId,
        conversationId: 'worker-conversation',
      },
    );
    expect(session).toEqual({
      taskContext: {
        currentTaskId: f.task.id,
        goalId: 'goal',
        workerAllocationId: f.record.allocationOperationId,
      },
    });
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

it.each([undefined, { id: 'foreign-operator', expiresAt: Date.now() + 60_000 }])(
  'rejects a missing or foreign initiating operator before worker allocation (%j)',
  async (initiator) => {
    const f = fixture();
    expect(() =>
      bindOrdinaryTaskWorkerSession(f.deps as never, 'selected-client', initiator),
    ).toThrow();
    expect(calls.reserve).not.toHaveBeenCalled();
    expect(calls.dispatch).not.toHaveBeenCalled();
  },
);

it('continues the same selected run across viewer disconnect and session driver rekey', async () => {
  const f = fixture();
  const sourceBySession = vi.fn(() => f.source);
  const deps = {
    ...f.deps,
    sourceForSession: sourceBySession,
    source: vi.fn(() => f.source as typeof f.source | undefined),
  };
  const spawn = bindOrdinaryTaskWorkerSession(deps as never, 'old-client', f.auth);
  const captured = calls.capture.mock.results[0].value;
  captured.assertCurrent.mockImplementation(() => {
    throw Error('Old viewer disconnected');
  });
  deps.source.mockReturnValue(undefined);
  f.source.ownerConnectionId = 'reconnected-viewer';
  await expect(
    spawn(f.task.id, 'Reviewed task', 'goal', vi.fn(), {
      operationId: f.record.allocationOperationId,
      signal: new AbortController().signal,
    }),
  ).resolves.toBe('task-worker:7aa6a744-d27c-4eca-a49c-bde6c305ab10');
  expect(sourceBySession).toHaveBeenCalledWith('source');
});

it('cancels the retained worker conversation independently of a changed viewer driver key', async () => {
  const f = fixture();
  const stop = vi.fn();
  const spawn = bindOrdinaryTaskWorkerSession(
    { ...f.deps, stop } as never,
    'selected-client',
    f.auth,
  );
  const signal = new AbortController();
  await spawn(f.task.id, 'Reviewed task', 'goal', vi.fn(), {
    operationId: f.record.allocationOperationId,
    signal: signal.signal,
  });
  signal.abort();
  expect(stop).toHaveBeenCalledWith(
    'task-worker:' + f.record.allocationOperationId,
    'worker-conversation',
  );
});

it('closes run authority on teardown and refuses future worker effects', async () => {
  const f = fixture();
  const spawn = bindOrdinaryTaskWorkerSession(f.deps as never, 'selected-client', f.auth);
  expect(spawn.close).toBeTypeOf('function');
  spawn.close?.();
  await expect(
    spawn(f.task.id, 'Reviewed task', 'goal', vi.fn(), {
      operationId: f.record.allocationOperationId,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  expect(calls.reserve).not.toHaveBeenCalled();
  expect(calls.dispatch).not.toHaveBeenCalled();
});

it('rejects a superseded allocation even while retained history includes its old marker', async () => {
  const f = fixture();
  const spawn = bindOrdinaryTaskWorkerSession(f.deps as never, 'selected-client', f.auth);
  const annotations = f.tasks.get(f.task.id)!.annotations;
  f.tasks.update(f.task.id, {
    annotations: [...annotations, 'worker_allocation: replacement-operation'],
  });
  await expect(
    spawn(f.task.id, 'Old task', 'goal', vi.fn(), {
      operationId: f.record.allocationOperationId,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('Exact active worker allocation required');
  expect(calls.reserve).not.toHaveBeenCalled();
  expect(calls.dispatch).not.toHaveBeenCalled();
});

it('uses the actual latest admitted model and thinking for a distinct child proof after ordinary continuation', async () => {
  const f = fixture();
  const events = new EventStore(join(f.deps.taskRoot(), 'source-events.db'));
  cleanups.push(() => events.close());
  const sourceOperation = randomUUID();
  events.prepareOrdinaryWorkspaceSession(f.meta as never, {
    allocationOperationId: sourceOperation,
    preparationFingerprint: 'c'.repeat(64),
    settings: f.settings,
  });
  events.admitPreparedOrdinaryWorkspaceCommand(
    sourceOperation,
    f.meta as never,
    f.settings.binding,
    {
      clientMsgId: 'source-first',
      requestFingerprint: 'd'.repeat(64),
      selection: f.settings.selection,
      payload: { text: 'First selected command' },
    },
  );
  events.claimOrdinaryLocalCommandDispatch('source-first');
  events.completeOrdinaryLocalCommand('source-first');
  const selection = { ...f.settings.selection, model: 'supported-new-model', thinking: 'high' };
  events.admitOrdinaryLocalContinuation(
    {
      ...f.meta,
      accountBinding: { ...f.account, model: selection.model },
      selectedModel: selection.model,
      reasoningEffort: selection.thinking,
    } as never,
    f.settings.binding,
    {
      clientMsgId: 'source-follow-up',
      requestFingerprint: 'e'.repeat(64),
      selection,
      payload: { text: 'Use the explicitly selected model and thinking' },
    },
  );
  events.claimOrdinaryLocalCommandDispatch('source-follow-up');
  events.completeOrdinaryLocalCommand('source-follow-up');
  expect(events.getSession('source')).toMatchObject({
    selectedModel: 'selected-model',
    reasoningEffort: null,
  });
  expect(events.getOrdinaryWorkspaceConversationSettings('source')?.selection).toEqual(selection);
  const sourceProof = events.getOrdinaryWorkspaceSessionPreparation(sourceOperation);
  const spawn = bindOrdinaryTaskWorkerSession(
    { ...f.deps, events } as never,
    'selected-client',
    f.auth,
  );
  await spawn(f.task.id, 'Reviewed task', 'goal', vi.fn(), {
    operationId: f.record.allocationOperationId,
    signal: new AbortController().signal,
  });
  expect(f.workspaces.prepareOrdinaryWorkspace).toHaveBeenCalledWith(
    expect.objectContaining({
      binding: { ...f.account, model: selection.model },
    }),
  );
  expect(calls.reserve).toHaveBeenCalledWith(
    expect.objectContaining({
      settings: expect.objectContaining({
        workspace: { kind: 'ordinary', preparationId: '4dd560bc-44c5-4de8-95bc-9e65469f7880' },
        selection,
      }),
    }),
  );
  expect(events.getOrdinaryWorkspaceSessionPreparation(sourceOperation)).toEqual(sourceProof);
  expect(sourceProof?.settings.selection).toEqual(f.settings.selection);
});

it('rejects changed account/model/target selection before allocating or dispatching', async () => {
  const f = fixture();
  const spawn = bindOrdinaryTaskWorkerSession(f.deps as never, 'selected-client', f.auth);
  f.settings.selection.model = 'changed-model';
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
  const spawn = bindOrdinaryTaskWorkerSession(f.deps as never, 'selected-client', f.auth);
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
