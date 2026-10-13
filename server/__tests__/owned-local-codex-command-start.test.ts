import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../account-profiles.js';
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
  controller: false,
  owner: false,
}));
vi.mock('../ordinary-local-codex-owned-runtime.js', () => ({
  OrdinaryLocalCodexOwnedRuntime: class {
    close = vi.fn(() => {
      runtime.trace.push('driver-close');
    });
    constructor(readonly owners: Owners) {
      runtime.instances.push(this);
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
  captureAgentLibraryAuthorization: vi.fn(() => ({ auth: {}, assertCurrent: vi.fn() })),
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
let root: string;
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
});
beforeEach(() => {
  vi.clearAllMocks();
  runtime.trace.splice(0);
  runtime.instances.splice(0);
  runtime.mode = 'dispatch';
  runtime.beforeDispatch = undefined;
  runtime.controller = runtime.owner = false;
  vi.stubEnv('MITZO_ORDINARY_LOCAL_CODEX_ENABLED', '1');
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
