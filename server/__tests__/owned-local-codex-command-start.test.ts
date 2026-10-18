import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../account-profiles.js';
import { TaskStore } from '../task-store.js';
import { resolveTelosWorkTaskToolContext } from '../telos-work-execution-authority.js';
import { OwnedLocalCodexChatAdmission } from '../owned-local-codex-chat-admission.js';
import { OwnedCodexLifecycleBridge } from '../owned-codex-lifecycle-bridge.js';
import { getAgentLibrary } from '../agent-library-runtime.js';
import { getRepositoryWorkspaces } from '../repository-workspace-runtime.js';
import { openCodexChat } from '../codex-chat-session.js';
import { captureAgentLibraryAuthorization } from '../agent-library-transport.js';
import type { OrdinaryLocalCodexOwnedRuntime } from '../ordinary-local-codex-owned-runtime.js';
import type { FrozenHostCodexBootstrapLease } from '../frozen-host-codex-bootstrap.js';

type Owners = ConstructorParameters<typeof OrdinaryLocalCodexOwnedRuntime>[0];
const runtime = vi.hoisted(() => ({
  trace: [] as string[],
  mode: 'dispatch' as 'dispatch' | 'duplicate' | 'failure',
  instances: [] as Array<{ owners: Owners; close: ReturnType<typeof vi.fn> }>,
  beforeDispatch: undefined as (() => void) | undefined,
  queryGate: undefined as Promise<void> | undefined,
  controller: false,
  owner: false,
  scopeError: false,
  useTls: false,
  scopeContext: undefined as { currentTaskId: string; goalId: string } | undefined,
}));
vi.mock('../local-server-url.js', async (original) => ({
  ...(await original<typeof import('../local-server-url.js')>()),
  localServerUsesTls: () => runtime.useTls,
}));
vi.mock('../telos-work-command-scope.js', async (original) => {
  const actual = await original<typeof import('../telos-work-command-scope.js')>();
  return {
    ...actual,
    resolveTelosWorkCommandScope: (
      ...args: Parameters<typeof actual.resolveTelosWorkCommandScope>
    ) => {
      if (runtime.scopeError) throw Error('Incomplete durable delegated worker');
      return runtime.scopeContext ?? actual.resolveTelosWorkCommandScope(...args);
    },
  };
});
vi.mock('../ordinary-local-codex-owned-runtime.js', () => ({
  OrdinaryLocalCodexOwnedRuntime: class {
    close = vi.fn(() => {
      runtime.trace.push('driver-close');
    });
    constructor(readonly owners: Owners) {
      runtime.instances.push(this);
    }
    async admitPreparedFirst(operationId: string, raw: unknown) {
      runtime.trace.push(`prepared:${operationId}`);
      return this.admit(raw);
    }
    async admit(raw: unknown) {
      runtime.trace.push('admit');
      if (runtime.mode === 'duplicate') return { dispatched: false };
      if (runtime.mode === 'failure') throw Error('private admission evidence');
      expect(raw).toEqual({ offline: 'command' });
      runtime.beforeDispatch?.();
      const dispatch = createDispatch(this.owners);
      await this.owners.dispatch(dispatch);
      runtime.trace.push('native-ready');
      expect(dispatch.lease.close).not.toHaveBeenCalled();
      this.owners.eventStore.completeOrdinaryLocalCommand(this.owners.commandId);
      runtime.trace.push('consumed');
      return { dispatched: true };
    }
  },
}));
vi.mock('../agent-library-transport.js', () => ({
  captureAgentLibraryAuthorization: vi.fn(() => ({
    auth: { id: 'fixture-owner-login' },
    assertCurrent: vi.fn(),
  })),
  readAgentLibraryProfile: vi.fn(),
}));
vi.mock('../symposium-custodian-mode.js', async (original) => ({
  ...(await original<object>()),
  get custodianControllerMode() {
    return runtime.controller;
  },
  get custodianOwnerMode() {
    return runtime.owner;
  },
}));
vi.mock('../agent-library-runtime.js', () => ({
  getAgentLibrary: vi.fn(() => {
    runtime.trace.push('library');
    return {};
  }),
}));
vi.mock('../repository-workspace-runtime.js', () => ({
  getRepositoryWorkspaces: vi.fn(() => {
    runtime.trace.push('workspace');
    return {};
  }),
  readRepositoryWorkspaceForConversation: vi.fn(),
}));
vi.mock('../codex-chat-session.js', () => ({
  openCodexChat: vi.fn(),
  getCodexRuntime: () => undefined,
  getCodexConversationStore: () => ({}),
  publicCodexStartupError: () => 'Owned local Codex chat unavailable',
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
    throw Error('Real model calls forbidden');
  }),
}));
vi.mock('../auto-rename.js', () => ({
  shouldAutoRename: () => {
    throw Error('Model naming forbidden');
  },
}));
vi.mock('../notify.js', () => ({ sendTurnCompleteNotification: vi.fn(async () => {}) }));
vi.mock('../pushover.js', () => ({ sendTurnCompleteNotification: vi.fn(async () => {}) }));
vi.mock('../goal-client.js', () => ({
  createGoal: vi.fn(async () => null),
  reportUsage: vi.fn(async () => {}),
  deriveGoalTitle: () => 'Offline',
}));

let chat: typeof import('../chat.js');
let startOpenShell: typeof import('../ordinary-openshell-codex-entry.js').startOwnedOpenShellCodexCommand;
let root: string;
let tasks: TaskStore;
let sequence = 0;
const profiles = new AccountProfiles(
  [
    {
      id: 'personal',
      label: 'Personal',
      provider: 'openai-codex',
      credentialRef: '/offline/login',
      email: 'fixture@example.test',
      planType: 'plus',
      models: [{ id: 'fixture', label: 'Offline' }],
    },
  ],
  { codexEnabled: true },
);
const binding = profiles.resolve('personal', 'fixture');
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-owned-command-start-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No network in command-start fixture');
    }),
  );
  chat = await import('../chat.js');
  tasks = new TaskStore(':memory:');
  chat.setTaskStore(tasks);
  startOpenShell = (await import('../ordinary-openshell-codex-entry.js'))
    .startOwnedOpenShellCodexCommand;
});
beforeEach(() => {
  vi.clearAllMocks();
  runtime.trace.splice(0);
  runtime.instances.splice(0);
  runtime.mode = 'dispatch';
  runtime.beforeDispatch = undefined;
  runtime.queryGate = undefined;
  runtime.controller = runtime.owner = false;
  runtime.scopeError = false;
  runtime.useTls = false;
  runtime.scopeContext = undefined;
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '1');
  vi.stubEnv('MITZO_ORDINARY_OPENSHELL_CODEX_ENABLED', '1');
  vi.mocked(openCodexChat).mockImplementation(async (options) => {
    runtime.trace.push('native-open');
    options.ownedLocal!.assertOptions(options);
    options.ownedLocal!.assertBeforeEnqueue({
      id: options.messageId,
      prompt: options.prompt,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    });
    options.ownedLocal!.assertBeforeDispatch(options.messageId);
    return {
      [Symbol.asyncIterator]: async function* () {
        runtime.trace.push('loop');
        expect(chat.eventStore.getOrdinaryLocalCommandAdmission(options.messageId)?.state).toBe(
          'consumed',
        );
        yield { type: 'system', subtype: 'init', session_id: options.conversationId };
        await runtime.queryGate;
      },
      setPermissionMode: async () => {},
      interrupt: async () => {},
      close: vi.fn(),
      stopTask: async () => {
        throw Error('Offline');
      },
    };
  });
});
afterAll(() => {
  tasks?.close();
  chat?.eventStore.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function request() {
  const sessionId = `owned-command-${++sequence}`;
  const transport = { send: vi.fn(), isOpen: () => true };
  return {
    transport,
    clientId: sessionId,
    args: {
      command: { offline: 'command' },
      reservation: {
        id: `${sessionId}-workspace`,
        binding,
        conversationId: sessionId,
        taskRoot: root,
      },
      commandId: `${sessionId}-command`,
      operatorConnectionId: 'authenticated-browser',
      signal: new AbortController().signal,
    },
  };
}
function createDispatch(owners: Owners): Parameters<Owners['dispatch']>[0] {
  const { conversationId: sessionId, id: workspaceId } = owners.reservation;
  const definition = {
    name: 'Agent',
    descriptor: 'Offline',
    role: 'agent' as const,
    instructions: 'Offline',
    expectedOutput: 'Evidence',
    acceptanceCriteria: ['Evidence'],
    modelPolicyRole: 'agent' as const,
  };
  const agentProfile = {
    profileId: 'agent',
    revision: 1,
    definition,
    contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
  };
  const expected = {
    binding: {
      version: 2 as const,
      account: {
        accountId: binding.accountId,
        provider: 'openai-codex' as const,
        profileRevision: binding.profileRevision,
      },
      harness: { implementation: 'codex' as const },
      execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'target' },
    },
    hostId: 'host',
    runtimeContractRevision: 'runtime',
    capabilityRevision: 'cap',
    workspace: { workspaceId, cwd: root },
    selection: {
      version: 1 as const,
      agent: { profileId: 'agent', revision: 1 },
      context: { source: 'none' as const, revision: null },
      permission: { mode: 'agent' as const, revision: 0 },
      model: 'fixture',
      thinking: null,
    },
    agentProfile,
  };
  const payload = { text: 'Frozen input', systemPrompt: 'Frozen instructions' };
  owners.eventStore.admitOrdinaryLocalCommand(
    {
      sessionId,
      cwd: root,
      repositoryWorkspaceId: workspaceId,
      accountBinding: binding,
      mode: 'agent',
      selectedModel: 'fixture',
      reasoningEffort: null,
      agentProfile,
    },
    expected.binding,
    {
      clientMsgId: owners.commandId,
      requestFingerprint: `${sessionId}-fp`,
      selection: expected.selection,
      payload,
    },
  );
  owners.eventStore.claimOrdinaryLocalCommandDispatch(owners.commandId);
  const profile = profiles.codexProfile(binding);
  const lease: FrozenHostCodexBootstrapLease = {
    client: { initialize: vi.fn(async () => {}), request: vi.fn(async () => ({})), close: vi.fn() },
    profile,
    binding,
    privateHome: '/offline/private',
    executableSha256: 'a'.repeat(64),
    assertCurrent: vi.fn(async () => {}),
    assertCurrentSync: vi.fn(),
    close: vi.fn(),
  };
  const admission = OwnedLocalCodexChatAdmission.capture({
    eventStore: owners.eventStore,
    sessionId,
    commandId: owners.commandId,
    expected,
    lease,
    bridge: new OwnedCodexLifecycleBridge(() => lease),
  });
  return {
    admission,
    lease,
    profile,
    expected,
    payload,
    sessionId,
    commandId: owners.commandId,
    workspace: {
      id: workspaceId,
      binding,
      conversationId: sessionId,
      directory: root,
      sandbox: false,
      state: 'claimed',
      connectionId: 'github',
      connectionRevision: 1,
      repository: 'owner/repo',
      baseBranch: 'main',
      baseOid: 'a'.repeat(40),
      featureBranch: 'mitzo/fixture',
      createdAt: Date.now(),
    },
  };
}

it('refuses the default-disabled route before resolving any lazy owners or native effects', async () => {
  const f = request();
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '0');
  await expect(chat.startOwnedLocalCodexCommand(f.transport, f.clientId, f.args)).rejects.toThrow(
    'Owned local Codex chat unavailable',
  );
  expect(getAgentLibrary).not.toHaveBeenCalled();
  expect(getRepositoryWorkspaces).not.toHaveBeenCalled();
  expect(runtime.instances).toHaveLength(0);
  expect(openCodexChat).not.toHaveBeenCalled();
});

it.each(['controller', 'owner'] as const)(
  'refuses custodian %s before authorizing or resolving lazy owners',
  async (mode) => {
    const f = request();
    runtime[mode] = true;
    await expect(chat.startOwnedLocalCodexCommand(f.transport, f.clientId, f.args)).rejects.toThrow(
      'Owned local Codex chat unavailable',
    );
    expect(captureAgentLibraryAuthorization).not.toHaveBeenCalled();
    expect(getAgentLibrary).not.toHaveBeenCalled();
    expect(getRepositoryWorkspaces).not.toHaveBeenCalled();
    expect(runtime.instances).toHaveLength(0);
  },
);

it('refuses invalid interactive authority before resolving lazy owners', async () => {
  const f = request();
  vi.mocked(captureAgentLibraryAuthorization).mockImplementationOnce(() => {
    throw Error('private revoked subject');
  });
  await expect(chat.startOwnedLocalCodexCommand(f.transport, f.clientId, f.args)).rejects.toThrow(
    'Owned local Codex chat unavailable',
  );
  expect(getAgentLibrary).not.toHaveBeenCalled();
  expect(getRepositoryWorkspaces).not.toHaveBeenCalled();
  expect(runtime.instances).toHaveLength(0);
});

it('refuses incomplete delegated worker scope before ordinary driver admission or native startup', async () => {
  const f = request();
  runtime.scopeError = true;
  await expect(chat.startOwnedLocalCodexCommand(f.transport, f.clientId, f.args)).rejects.toThrow(
    /unavailable/,
  );
  expect(runtime.instances).toHaveLength(0);
  expect(openCodexChat).not.toHaveBeenCalled();
  expect(chat.eventStore.getSendCommand(f.args.commandId)).toBeUndefined();
});

it('rechecks delegated scope at the actual guarded consumer boundary after driver awaits', async () => {
  const f = request();
  runtime.beforeDispatch = () => {
    runtime.scopeError = true;
  };
  await expect(chat.startOwnedLocalCodexCommand(f.transport, f.clientId, f.args)).rejects.toThrow(
    /unavailable/,
  );
  expect(openCodexChat).not.toHaveBeenCalled();
  expect(chat.eventStore.getOrdinaryLocalCommandAdmission(f.args.commandId)?.state).toBe(
    'uncertain',
  );
  expect(runtime.trace).not.toContain('loop');
});

it.each([false, true])(
  'binds proven task tools to the canonical internal listener (TLS %s)',
  async (useTls) => {
    const f = request();
    runtime.useTls = useTls;
    const mapped = tasks.createOrRecoverTelosExecutionTask(
      { title: 'Exact task' },
      {
        attemptId: `${f.clientId}-attempt`,
        childItemId: 'child',
        leadConversationId: 'lead',
        workerConversationId: f.args.reservation.conversationId,
        contextSnapshotId: `${f.clientId}-context`,
        contextHash: 'a'.repeat(64),
      },
    );
    runtime.scopeContext = { currentTaskId: mapped.id, goalId: mapped.id };
    await chat.startOwnedLocalCodexCommand(f.transport, f.clientId, f.args);
    const options = vi.mocked(openCodexChat).mock.calls.at(-1)![0];
    expect(options.session.taskContext).toEqual(runtime.scopeContext);
    expect(options.mcpServers).toHaveProperty('task-board');
    expect(options.mcpServers!['task-board'].args).toEqual(
      expect.arrayContaining([
        '--base-url',
        `http://localhost:${Number.parseInt(process.env.PORT || '3100', 10) + (useTls ? 1 : 0)}`,
        '--client-id',
        f.clientId,
        '--session-id',
        f.args.reservation.conversationId,
        '--task-id',
        mapped.id,
      ]),
    );
    const capturedArgs = [...options.mcpServers!['task-board'].args!];
    const capturedSessionId = options.session.sessionId;
    const capturedTaskContext = options.session.taskContext;
    options.session.sessionId = 'rebound-conversation';
    options.session.taskContext = { currentTaskId: 'another-task', goalId: 'another-task' };
    expect(options.mcpServers!['task-board'].args).toEqual(capturedArgs);
    options.session.sessionId = capturedSessionId;
    options.session.taskContext = capturedTaskContext;
    expect(options.systemPrompt).toBe('Frozen instructions');
    runtime.scopeError = true;
    expect(() => options.assertAgentContextAuthorization!()).toThrow();
    runtime.scopeError = false;
    await vi.waitFor(() => expect(runtime.instances[0].close).toHaveBeenCalled());
  },
);

it('leaves unbound task workflows free to advance within the existing task transport', async () => {
  const f = request();
  const first = tasks.create({ title: 'Legacy A' });
  const second = tasks.create({ title: 'Legacy B' });
  runtime.scopeContext = { currentTaskId: first.id, goalId: first.id };
  await chat.startOwnedLocalCodexCommand(f.transport, f.clientId, f.args);
  const options = vi.mocked(openCodexChat).mock.calls.at(-1)![0];
  const args = options.mcpServers!['task-board'].args!;
  expect(args).not.toContain('--session-id');
  expect(args).not.toContain('--task-id');
  options.session.taskContext = { currentTaskId: second.id, goalId: first.id };
  const work = vi.fn(() => {
    throw Error('Legacy tasks must not open Telos');
  });
  expect(
    resolveTelosWorkTaskToolContext(
      { events: chat.eventStore, tasks, work },
      { sessionId: f.args.reservation.conversationId, taskId: second.id, accountBinding: binding },
      { sessionId: undefined, taskId: undefined },
    ),
  ).toBe(second.id);
  expect(work).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(runtime.instances[0].close).toHaveBeenCalled());
});

it('connects the actual consumer to driver admission and pumps its existing native query after consumed', async () => {
  const f = request();
  await expect(chat.startOwnedLocalCodexCommand(f.transport, f.clientId, f.args)).resolves.toEqual({
    dispatched: true,
    sessionId: f.args.reservation.conversationId,
  });
  await vi.waitFor(() => expect(runtime.instances[0].close).toHaveBeenCalledOnce());
  expect(runtime.trace.indexOf('native-ready')).toBeLessThan(runtime.trace.indexOf('consumed'));
  expect(runtime.trace.indexOf('consumed')).toBeLessThan(runtime.trace.indexOf('loop'));
  expect(runtime.instances[0].owners).toMatchObject({
    eventStore: chat.eventStore,
    enabled: true,
    commandId: f.args.commandId,
    operatorConnectionId: f.args.operatorConnectionId,
    signal: f.args.signal,
  });
  expect(getRepositoryWorkspaces).toHaveBeenCalledWith(true);
  expect(chat.eventStore.getOrdinaryLocalCommandAdmission(f.args.commandId)?.state).toBe(
    'consumed',
  );
});

it('retains the captured operator and command identity if caller arguments change during admission', async () => {
  const f = request();
  const commandId = f.args.commandId;
  const signal = f.args.signal;
  runtime.beforeDispatch = () => {
    f.args.commandId = 'replacement-command';
    f.args.operatorConnectionId = 'replacement-operator';
    f.args.signal = new AbortController().signal;
  };
  await chat.startOwnedLocalCodexCommand(f.transport, f.clientId, f.args);
  await vi.waitFor(() => expect(runtime.instances[0].close).toHaveBeenCalledOnce());
  expect(runtime.instances[0].owners).toMatchObject({
    commandId,
    operatorConnectionId: 'authenticated-browser',
    signal,
  });
  expect(vi.mocked(openCodexChat).mock.calls.at(-1)![0].session.ownerConnectionId).toBe(
    'authenticated-browser',
  );
});

it('separates retained auth from the visible stream and pins its original login', async () => {
  const f = request();
  const args = { ...f.args, ownerConnectionId: 'actual-visible-stream' };
  runtime.beforeDispatch = () => {
    args.ownerConnectionId = 'replacement-stream';
  };
  await chat.startOwnedLocalCodexCommand(f.transport, f.clientId, args);
  await vi.waitFor(() => expect(runtime.instances[0].close).toHaveBeenCalledOnce());
  expect(vi.mocked(openCodexChat).mock.calls.at(-1)![0].session).toMatchObject({
    ownerConnectionId: 'actual-visible-stream',
    ownedLocalAuthSessionId: 'fixture-owner-login',
  });
});

it('releases a new idle driver for an exact duplicate without preparing a query or starting a loop', async () => {
  const f = request();
  runtime.mode = 'duplicate';
  await expect(chat.startOwnedLocalCodexCommand(f.transport, f.clientId, f.args)).resolves.toEqual({
    dispatched: false,
    sessionId: f.args.reservation.conversationId,
  });
  expect(runtime.instances[0].close).toHaveBeenCalledOnce();
  expect(openCodexChat).not.toHaveBeenCalled();
  expect(runtime.trace).not.toContain('loop');
  expect(f.transport.send).not.toHaveBeenCalled();
});

it('releases driver failure without exposing its private evidence or starting a query', async () => {
  const f = request();
  runtime.mode = 'failure';
  await expect(chat.startOwnedLocalCodexCommand(f.transport, f.clientId, f.args)).rejects.toThrow(
    'Owned local Codex chat unavailable',
  );
  expect(runtime.instances[0].close).toHaveBeenCalledOnce();
  expect(openCodexChat).not.toHaveBeenCalled();
});

it('retains command uncertainty and releases driver ownership when native preparation fails', async () => {
  const f = request();
  vi.mocked(openCodexChat).mockRejectedValueOnce(new Error('private native configuration'));
  await expect(chat.startOwnedLocalCodexCommand(f.transport, f.clientId, f.args)).rejects.toThrow(
    'Owned local Codex chat unavailable',
  );
  expect(runtime.instances[0].close).toHaveBeenCalled();
  expect(chat.eventStore.getOrdinaryLocalCommandAdmission(f.args.commandId)?.state).toBe(
    'uncertain',
  );
  expect(runtime.trace).not.toContain('loop');
  expect(chat.registry.get(f.clientId)).toBeUndefined();
});

function liveRetry(location: 'local' | 'openshell', operationId?: string, resume = false) {
  const f = request();
  const retry = vi.fn(async () => ({ dispatched: false }));
  const admit = vi.fn(async () => {
    throw Error('A retry must not admit a new command');
  });
  const close = vi.fn();
  chat.registry.register(f.clientId, {
    sessionId: f.args.reservation.conversationId,
    transport: f.transport,
    abortController: new AbortController(),
    mode: 'agent',
    sessionAllowList: new Set(),
    ordinaryRuntimeOwner: {
      location,
      authSessionId: 'fixture-owner-login',
      identity: {},
      initialCommandId: f.args.commandId,
      ...{ initialPreparationOperationId: operationId, initialResume: resume },
      retryInitial: retry,
      admit,
      close,
    },
  });
  const definition = {
    name: 'Agent',
    descriptor: 'Offline',
    role: 'agent' as const,
    instructions: 'Offline',
    expectedOutput: 'Evidence',
    acceptanceCriteria: ['Evidence'],
    modelPolicyRole: 'agent' as const,
  };
  const command = {
    clientMsgId: f.args.commandId,
    capabilityRevision: 'offline-capability',
    runtime: {
      account: {
        accountId: binding.accountId,
        provider: binding.provider,
        profileRevision: binding.profileRevision,
      },
      harness: 'codex' as const,
      targetId: 'offline-target',
      mode: 'agent' as const,
    },
    selection: {
      version: 1 as const,
      agent: { profileId: 'agent', revision: 1 },
      context: { source: 'none' as const, revision: null },
      permission: { mode: 'agent' as const, revision: 0 },
      model: binding.model,
      thinking: null,
    },
    payload: { text: 'Original explicit prompt' },
  };
  return {
    retry,
    admit,
    close,
    sessionId: f.args.reservation.conversationId,
    remove: () => chat.registry.remove(f.clientId),
    invoke: (identity: { preparationOperationId?: string; resume?: boolean }) =>
      location === 'local'
        ? chat.startOwnedLocalCodexCommand(f.transport, f.clientId, { ...f.args, ...identity })
        : startOpenShell(f.transport, f.clientId, {
            ...identity,
            command,
            taskRoot: root,
            meta: {
              sessionId: f.args.reservation.conversationId,
              repositoryWorkspaceId: f.args.reservation.id,
              cwd: '/offline/sandbox',
              accountBinding: binding,
              agentProfile: {
                profileId: 'agent',
                revision: 1,
                definition,
                contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
              },
            },
            operatorConnectionId: f.args.operatorConnectionId,
            ownerConnectionId: f.clientId,
            signal: f.args.signal,
          }),
  };
}

it.each(['local', 'openshell'] as const)(
  '%s live prepared retries require the original allocation operation',
  async (location) => {
    const f = liveRetry(location, 'original-allocation');
    try {
      for (const changed of [
        undefined,
        'another-allocation',
        '',
        'bad allocation',
        'a'.repeat(201),
        null,
        7,
      ]) {
        await expect(
          f.invoke({ preparationOperationId: changed as string | undefined }),
        ).rejects.toThrow(/unavailable/);
      }
      expect(f.retry).not.toHaveBeenCalled();
      await expect(f.invoke({ preparationOperationId: 'original-allocation' })).resolves.toEqual({
        dispatched: false,
        sessionId: f.sessionId,
      });
      expect(f.retry).toHaveBeenCalledTimes(1);
      expect(f.admit).not.toHaveBeenCalled();
      expect(f.close).not.toHaveBeenCalled();
      expect(runtime.instances).toEqual([]);
      expect(openCodexChat).not.toHaveBeenCalled();
    } finally {
      f.remove();
    }
  },
);

it('captures prepared entry identity before startup awaits and retains it for an exact live retry', async () => {
  const f = request();
  const args = { ...f.args, preparationOperationId: 'original-allocation', resume: false };
  let release!: () => void;
  runtime.queryGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.beforeDispatch = () => {
    args.preparationOperationId = 'changed-during-startup';
    args.resume = true;
  };
  try {
    await expect(
      chat.startOwnedLocalCodexCommand(f.transport, f.clientId, args),
    ).resolves.toMatchObject({ dispatched: true });
    const owner = chat.registry.findBySessionId(f.args.reservation.conversationId)?.session
      .ordinaryRuntimeOwner;
    expect(owner).toMatchObject({
      initialPreparationOperationId: 'original-allocation',
      initialResume: false,
    });
    runtime.mode = 'duplicate';
    runtime.beforeDispatch = undefined;
    await expect(
      chat.startOwnedLocalCodexCommand(f.transport, f.clientId, {
        ...f.args,
        preparationOperationId: 'original-allocation',
        resume: false,
      }),
    ).resolves.toEqual({ dispatched: false, sessionId: f.args.reservation.conversationId });
    expect(runtime.trace.filter((event) => event.startsWith('prepared:'))).toEqual([
      'prepared:original-allocation',
      'prepared:original-allocation',
    ]);
    expect(runtime.instances).toHaveLength(1);
    expect(openCodexChat).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await vi.waitFor(() => expect(runtime.instances[0]?.close).toHaveBeenCalled());
  }
});

it.each(['local', 'openshell'] as const)(
  '%s live ordinary retries cannot acquire preparation or resume identity',
  async (location) => {
    const f = liveRetry(location);
    try {
      await expect(f.invoke({ preparationOperationId: 'new-allocation' })).rejects.toThrow(
        /unavailable/,
      );
      await expect(f.invoke({ resume: true })).rejects.toThrow(/unavailable/);
      await expect(f.invoke({ resume: 'yes' as unknown as boolean })).rejects.toThrow(
        /unavailable/,
      );
      expect(f.retry).not.toHaveBeenCalled();
      await expect(f.invoke({})).resolves.toEqual({ dispatched: false, sessionId: f.sessionId });
      await expect(f.invoke({ resume: false })).resolves.toEqual({
        dispatched: false,
        sessionId: f.sessionId,
      });
      expect(f.retry).toHaveBeenCalledTimes(2);
      expect(f.admit).not.toHaveBeenCalled();
      expect(openCodexChat).not.toHaveBeenCalled();
    } finally {
      f.remove();
    }
  },
);

it.each(['local', 'openshell'] as const)(
  '%s live resume retries preserve the original resume identity',
  async (location) => {
    const f = liveRetry(location, undefined, true);
    try {
      await expect(f.invoke({})).rejects.toThrow(/unavailable/);
      await expect(f.invoke({ resume: false })).rejects.toThrow(/unavailable/);
      await expect(
        f.invoke({ resume: true, preparationOperationId: 'new-allocation' }),
      ).rejects.toThrow(/unavailable/);
      expect(f.retry).not.toHaveBeenCalled();
      await expect(f.invoke({ resume: true })).resolves.toEqual({
        dispatched: false,
        sessionId: f.sessionId,
      });
      expect(f.retry).toHaveBeenCalledTimes(1);
      expect(f.admit).not.toHaveBeenCalled();
      expect(openCodexChat).not.toHaveBeenCalled();
    } finally {
      f.remove();
    }
  },
);
