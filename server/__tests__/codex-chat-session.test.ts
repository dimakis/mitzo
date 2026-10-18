import { createHash } from 'node:crypto';
import { retainTelosWorkRoleContext } from '../telos-work-role-context.js';
import { buildAgentProfilePrompt } from '../agent-library-prompt.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  close: vi.fn(),
  send: vi.fn(),
  turnDispatchCount: 0,
  mcpClose: vi.fn(),
  connect: vi.fn(),
  permissionHandler: vi.fn(),
  assertPermissionModeChange: vi.fn(),
  setWebSearchGrant: vi.fn(),
  getWebSearchGrant: vi.fn(),
  store: vi.fn(),
  reserveStartup: vi.fn(),
  setArtifactRuntime: vi.fn(),
  recordKnowledgeAdoption: vi.fn(),
  recordAgentContextAdoption: vi.fn(),
  privateDirectory: '/tmp',
  conversationOptions: undefined as Record<string, unknown> | undefined,
  useTls: false,
  custodianController: false,
}));
vi.mock('../symposium-custodian-mode.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../symposium-custodian-mode.js')>()),
  get custodianControllerMode() {
    return mocks.custodianController;
  },
}));
vi.mock('../local-server-url.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../local-server-url.js')>()),
  localServerUsesTls: () => mocks.useTls,
}));
vi.mock('../codex-conversation-store.js', () => ({
  CodexConversationStore: class {
    constructor() {
      mocks.store();
    }
    recoverAtStartup() {}
    reserveStartup = mocks.reserveStartup;
    assertStartupResumeSafe() {}
    startupNeedsProvisioning() {
      return false;
    }
    markStartupProviderInitializing() {}
    readArtifactRuntime() {
      return null;
    }
    readRuntimeMigration() {
      return null;
    }
    setArtifactRuntime = mocks.setArtifactRuntime;
    recordKnowledgeAdoption = mocks.recordKnowledgeAdoption;
    recordAgentContextAdoption = mocks.recordAgentContextAdoption;
  },
}));
vi.mock('../codex-conversation.js', () => ({
  CodexConversation: class {
    constructor(options: { onClosed: () => void }) {
      mocks.turnDispatchCount = 0;
      mocks.conversationOptions = options;
      mocks.close.mockImplementation(options.onClosed);
    }
    initialize = mocks.initialize;
    getThreadId = vi.fn(() => 'thread');
    getDurableThreadId = vi.fn(() => 'thread');
    assertPermissionModeChange = mocks.assertPermissionModeChange;
    setWebSearchGrant = mocks.setWebSearchGrant;
    getWebSearchGrant = mocks.getWebSearchGrant;
    close = mocks.close;
    getTurnDispatchCount = () => mocks.turnDispatchCount;
    send = mocks.send;
  },
}));
vi.mock('../codex-mcp-tools.js', () => ({ connectCodexMcpTools: mocks.connect }));
vi.mock('../codex-private-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../codex-private-path.js')>()),
  codexPrivateDirectory: () => mocks.privateDirectory,
}));
vi.mock('@mitzo/harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mitzo/harness')>()),
  buildPermissionHandler: () => mocks.permissionHandler,
}));
import {
  capabilityIdempotencyKey,
  managedJiraConnectionEnv,
  openCodexChat,
  publicCodexRuntimeError,
  publicCodexStartupError,
  ordinaryRuntimeServiceProviders,
  selectedOpenShellAccountRoute,
  waitForCodexRuntime,
  waitForCodexRuntimeBySessionId,
} from '../codex-chat-session.js';
import { KnowledgePublicationUnavailableError } from '../knowledge-publication-bridge.js';
import { CodexAppServerClient, CodexRequestError } from '../codex-app-server-client.js';
import { CodexStartupError } from '../codex-startup-error.js';
import { RuntimePolicyAttestationError } from '../openshell-runtime-policy.js';
import { OpenShellRuntimeManager } from '../openshell-runtime.js';
import * as migrationAdapter from '../openshell-runtime-migration-adapter.js';
import * as lifecycleController from '../openshell-lifecycle-controller.js';
import * as knowledgeStoreConfig from '../knowledge-store-config.js';
import { ConnectionsService } from '../connections-service.js';
import { setConnectionsRuntime } from '../connections-runtime.js';
import { getLiveCapabilityConversationBinding } from '../capability-conversation-binding.js';
import { SymposiumProfileProposalStore } from '../symposium-profile-proposals.js';
import { SymposiumProfileStore } from '../symposium-profiles.js';
import { OwnedLocalCodexChatAdmission } from '../owned-local-codex-chat-admission.js';
import { OwnedCodexLifecycleBridge } from '../owned-codex-lifecycle-bridge.js';
import { AccountProfiles } from '../account-profiles.js';
import { EventStore } from '../event-store.js';
import type { FrozenHostCodexBootstrapLease } from '../frozen-host-codex-bootstrap.js';
import type { OrdinaryLocalCodexAdmissionExpectation } from '../ordinary-local-codex-admission.js';

beforeEach(() => {
  vi.spyOn(OpenShellRuntimeManager.prototype, 'inspectTaskCapabilities').mockResolvedValue({
    mgmtCli: false,
    meetingPrep: false,
    gws: true,
  });
  mocks.custodianController = false;
  vi.spyOn(OpenShellRuntimeManager.prototype, 'observeContract').mockResolvedValue({
    resourceVersion: 'test-observation',
    policy: {},
    attestation: { basePolicy: {}, effectivePolicyHash: 'test', providers: [] },
    approvedGrantableProviders: [],
    requiredServiceEnvironment: [],
  });
});
afterEach(() => {
  mocks.custodianController = false;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(OpenShellRuntimeManager.prototype.observeContract).mockRestore();
  vi.mocked(OpenShellRuntimeManager.prototype.inspectTaskCapabilities).mockRestore();
});
it('uses assigned GitHub credentials instead of the legacy fallback on a new runtime', () => {
  const managed = [
    { templateId: 'github-readonly', gatewayProviderName: 'mitzo-conn-github' },
    { templateId: 'jira-readonly', gatewayProviderName: 'mitzo-conn-jira' },
  ];
  expect(ordinaryRuntimeServiceProviders(['github', 'google-workspace'], managed)).toEqual([
    'google-workspace',
    'mitzo-conn-github',
    'mitzo-conn-jira',
  ]);
  expect(ordinaryRuntimeServiceProviders(['github'], managed.slice(1))).toEqual([
    'github',
    'mitzo-conn-jira',
  ]);
  // Retained selection excludes a newly assigned connection absent from that
  // physical sandbox, so an existing legacy GitHub binding stays selected.
  expect(ordinaryRuntimeServiceProviders(['github'], [])).toEqual(['github']);
});

it('forwards only recognized sanitized Codex diagnostics', () => {
  expect(
    publicCodexRuntimeError(
      new Error(
        'OpenShell denied the provider request because its credential-bearing body could not be inspected.',
      ),
    ),
  ).toBe(
    'OpenShell denied the provider request because its credential-bearing body could not be inspected.',
  );
  expect(publicCodexRuntimeError(new Error('Bearer sk-secret at https://private.example'))).toBe(
    'Codex turn failed. Inspect queued work before retrying.',
  );
});
it('explains sandbox recipe compatibility and source failures without exposing compiler output', async () => {
  const { SandboxAgentContextAdmissionError } = await import('../agent-context-sandbox.js');
  const secret = Error('Bearer sk-private in /private/workspace and compiler stdout');
  for (const [reason, expected] of [
    ['runtime', 'compatible reviewed runtime'],
    ['recipe', 'selected documents'],
    ['scope', 'new chat'],
    ['authorization', 'Sign in again'],
  ] as const) {
    const detail = new SandboxAgentContextAdmissionError(reason, secret);
    const message = publicCodexStartupError(new CodexStartupError('context_preparation', detail));
    expect(message).toContain(expected);
    expect(message).toContain('No provider turn was started');
    expect(message).not.toContain('sk-private');
    expect(message).not.toContain('/private/workspace');
  }
});
it('reports connection admission rejection without claiming a provider turn failed', () => {
  expect(
    publicCodexRuntimeError(new Error('Connection permissions changed. Start a new conversation.')),
  ).toBe('Connection permissions changed. Start a new conversation.');
});
it('reports startup request failures without discarding their safe category', () => {
  const error = new CodexRequestError('thread/start', 'authentication', 401);
  expect(publicCodexRuntimeError(error)).toMatch(/credentials or permissions/);
  expect(publicCodexStartupError(error)).toMatch(/credentials or permissions/);
  expect(publicCodexStartupError(new Error('Bearer sk-secret'))).toBe(
    'Codex could not start this chat. Check runtime and account configuration before continuing.',
  );
});
it('keeps fresh-sign-in advice when sandbox preparation rejects a subscription grant', () => {
  const error = new CodexStartupError(
    'sandbox_preparation',
    new Error('OpenShell ChatGPT grant is expired, revoked, or requires sign-in'),
  );
  expect(publicCodexStartupError(error)).toBe(
    `Chat startup failed during sandbox preparation. The selected ChatGPT connection needs a fresh sign-in. Reconnect that account before retrying. Reference: ${error.diagnosticId}`,
  );
});
it('scopes capability idempotency to the authoritative conversation identity', () => {
  const binding = {
    capabilityId: 'github.publish-pr',
    capabilityVersion: 1,
    connectionId: 'connection-1',
    connectionRevision: 3,
  };
  const firstCall = { turnId: 'turn-1', callId: 'tool-call-1' };
  const replayCall = { turnId: 'turn-1', callId: 'tool-call-after-reconnect' };
  expect(capabilityIdempotencyKey('conversation-a', binding, firstCall, { value: 'one' })).not.toBe(
    capabilityIdempotencyKey('conversation-b', binding, firstCall, { value: 'one' }),
  );
  expect(capabilityIdempotencyKey('conversation-a', binding, firstCall, { value: 'one' })).toBe(
    capabilityIdempotencyKey('conversation-a', binding, replayCall, { value: 'one' }),
  );
  expect(capabilityIdempotencyKey('conversation-a', binding, firstCall, { value: 'one' })).not.toBe(
    capabilityIdempotencyKey('conversation-a', binding, replayCall, { value: 'two' }),
  );
});
it('builds managed Jira runtime context from versioned public configuration, not legacy email', () => {
  const connection = {
    templateId: 'jira-readonly',
    templateVersion: 1,
    publicConfig: { email: 'person@example.com' },
    submittedEmail: 'legacy-invalid-value',
  } as unknown as import('../connections-store.js').Connection;
  expect(managedJiraConnectionEnv(connection)).toMatchObject({ JIRA_EMAIL: 'person@example.com' });
  expect(() =>
    managedJiraConnectionEnv({
      ...connection,
      publicConfig: { email: 'person@.' },
    }),
  ).toThrow('Unsupported managed Jira connection configuration');
  expect(() => managedJiraConnectionEnv({ ...connection, templateVersion: 2 })).toThrow(
    'Unsupported managed Jira connection configuration',
  );
});
function options(abortController: AbortController) {
  return {
    session: { cwd: '/tmp', abortController },
    registry: { findBySessionId: () => undefined, get: () => undefined },
    mcpServers: {},
    profile: { planType: 'api', credentialRef: '/test/login' },
    eventStore: {
      getRecentConversationText: () => [],
      getSession: () => undefined,
      getSessionEvents: () => [],
    },
  } as unknown as Parameters<typeof openCodexChat>[0];
}

function ownedLocalOptions(
  cwd = '/tmp',
  agentProfile?: import('@mitzo/protocol').AgentLibraryVersion,
) {
  const eventStore = new EventStore(':memory:');
  const profiles = new AccountProfiles(
    [
      {
        id: 'owned-personal',
        label: 'Personal',
        provider: 'openai-codex',
        credentialRef: '/offline/owned-login',
        email: 'fixture@example.test',
        planType: 'plus',
        models: [{ id: 'owned-model', label: 'Fixture' }],
      },
    ],
    { codexEnabled: true },
  );
  const binding = profiles.resolve('owned-personal', 'owned-model'),
    profile = profiles.codexProfile(binding);
  const runtimeBinding = {
    version: 2 as const,
    account: {
      accountId: binding.accountId,
      provider: binding.provider,
      profileRevision: binding.profileRevision,
    },
    harness: { implementation: 'codex' as const },
    execution: {
      location: 'local' as const,
      targetId: 'owned-mac',
      targetRevision: 'owned-target',
    },
  };
  const selection = {
    version: 1 as const,
    agent: { profileId: 'owned-agent', revision: 1 },
    context: { source: 'none' as const, revision: null },
    permission: { mode: 'agent' as const, revision: 0 },
    model: 'owned-model',
    thinking: null,
  };
  const expected = {
    binding: runtimeBinding,
    hostId: 'host',
    runtimeContractRevision: 'runtime',
    capabilityRevision: 'cap',
    workspace: { workspaceId: 'owned-workspace', cwd },
    selection,
    ...(agentProfile ? { agentProfile } : {}),
  } as OrdinaryLocalCodexAdmissionExpectation;
  eventStore.admitOrdinaryLocalCommand(
    {
      sessionId: 'owned-session',
      accountBinding: binding,
      cwd,
      repositoryWorkspaceId: 'owned-workspace',
      selectedModel: 'owned-model',
      reasoningEffort: null,
      mode: 'agent',
      ...(agentProfile ? { agentProfile } : {}),
    },
    runtimeBinding,
    {
      clientMsgId: 'owned-command',
      requestFingerprint: 'owned-fingerprint',
      selection,
      payload: {
        text: 'Frozen prompt',
        systemPrompt: agentProfile ? buildAgentProfilePrompt(agentProfile.definition) : '',
        intent: 'Original intent',
      },
    },
  );
  eventStore.claimOrdinaryLocalCommandDispatch('owned-command');
  const lease = {
    client: { initialize: vi.fn(), request: vi.fn(), close: vi.fn() },
    binding,
    profile,
    privateHome: '/private/fixture-home',
    executableSha256: 'a'.repeat(64),
    assertCurrent: vi.fn(async () => {}),
    assertCurrentSync: vi.fn(),
    close: vi.fn(),
  } as FrozenHostCodexBootstrapLease;
  const bridge = new OwnedCodexLifecycleBridge(() => lease);
  const ownedLocal = OwnedLocalCodexChatAdmission.capture({
    eventStore,
    sessionId: 'owned-session',
    commandId: 'owned-command',
    expected,
    lease,
    bridge,
  });
  const opts = {
    ...options(new AbortController()),
    eventStore,
    conversationId: 'owned-session',
    messageId: 'owned-command',
    binding,
    profile,
    prompt: 'Frozen prompt',
    intent: 'Original intent',
    model: 'owned-model',
    reasoningEffort: null,
    systemPrompt: agentProfile ? buildAgentProfilePrompt(agentProfile.definition) : '',
    ...(agentProfile ? { agentProfile } : {}),
    env: {},
    repositoryWorkspace: {
      id: 'owned-workspace',
      repository: 'fixture/repo',
      baseBranch: 'main',
      baseOid: 'a'.repeat(40),
      featureBranch: 'fixture',
      directory: cwd,
      sandbox: false,
    },
    session: { ...options(new AbortController()).session, cwd, mode: 'agent' },
    ownedLocal,
  } as Parameters<typeof openCodexChat>[0];
  return { eventStore, opts, lease, ownedLocal };
}

it('routes the selected model when provisioning an OpenShell subscription', () => {
  expect(
    selectedOpenShellAccountRoute({
      binding: {
        accountId: 'personal',
        accountLabel: 'Personal ChatGPT',
        provider: 'openai-codex',
        model: 'bound-model',
        profileRevision: 'revision',
      },
      model: 'selected-model',
      profile: {
        accountId: 'personal',
        accountLabel: 'Personal ChatGPT',
        credentialRef: '/test/login',
        email: 'test@example.invalid',
        planType: 'pro',
        sandboxProvider: 'personal-chatgpt',
        sandboxProviderType: 'openai-codex-oauth',
        sandboxProviderId: 'provider-id',
        sandboxGrantId: 'grant-id',
        model: 'bound-model',
      },
    }),
  ).toMatchObject({ kind: 'chatgpt-subscription', model: 'selected-model' });
});
it('does not open MCP processes if private storage is unavailable', async () => {
  mocks.store.mockImplementationOnce(() => {
    throw new Error('storage unavailable');
  });
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  const opening = openCodexChat(options(new AbortController()));
  await expect(opening).rejects.toThrow('storage unavailable');
  await expect(opening).rejects.toMatchObject({ phase: 'conversation_storage' });
  expect(mocks.connect).not.toHaveBeenCalled();
});
it.each([
  ['openai', 'openai-api'],
  ['openai-codex', 'chatgpt-subscription'],
] as const)(
  'labels %s provider conversations with their actual trace route',
  async (provider, route) => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
    const abort = new AbortController();
    const opts = options(abort);
    opts.binding = {
      accountId: 'offline-route-fixture',
      accountLabel: 'Fixture',
      provider,
      model: 'test-model',
      profileRevision: 'fixture',
    };
    const chat = await openCodexChat(opts);
    expect(mocks.conversationOptions?.route).toBe(route);
    chat.close();
  },
);

it('retains the failing initialization step while closing the runtime', async () => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  const cause = new CodexRequestError('thread/start', 'authentication', 401);
  mocks.initialize.mockRejectedValueOnce(cause);
  await expect(openCodexChat(options(new AbortController()))).rejects.toMatchObject({
    phase: 'conversation_initialization',
    cause,
  });
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.mcpClose).toHaveBeenCalledOnce();
  expect(mocks.send).not.toHaveBeenCalled();
});
it('reports a first-send policy rejection as known preparation failure', async () => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  mocks.initialize.mockResolvedValueOnce(undefined);
  const cause = new RuntimePolicyAttestationError('Runtime PRIVATE_COMMAND Bearer sk-secret');
  mocks.send.mockRejectedValueOnce(cause);
  const opening = openCodexChat(options(new AbortController()));
  await expect(opening).rejects.toMatchObject({ phase: 'initial_turn_preparation', cause });
  const error = await opening.catch((error) => error);
  expect(publicCodexStartupError(error)).toContain('observed sandbox policy differs');
  expect(publicCodexStartupError(error)).toContain('No provider turn was started.');
  expect(publicCodexStartupError(error)).not.toMatch(/unknown|PRIVATE_COMMAND|sk-secret/);
  expect(mocks.close).toHaveBeenCalledOnce();
});
it('retains uncertain-work advice when the first send fails after initialization', async () => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  mocks.initialize.mockResolvedValueOnce(undefined);
  const cause = new Error('unknown failure after provider dispatch');
  mocks.send.mockImplementationOnce(async () => {
    mocks.turnDispatchCount += 1;
    throw cause;
  });
  const opening = openCodexChat(options(new AbortController()));
  await expect(opening).rejects.toMatchObject({ phase: 'initial_turn_dispatch', cause });
  const error = await opening.catch((error) => error);
  expect(publicCodexStartupError(error)).toMatch(/outcome may be unknown/);
  expect(publicCodexStartupError(error)).toMatch(/inspect saved work/);
  expect(publicCodexStartupError(error)).not.toMatch(/configuration|runtime admission/);
  expect(mocks.close).toHaveBeenCalledOnce();
});
it('closes an initialization aborted before the first turn starts', async () => {
  vi.clearAllMocks();
  const abort = new AbortController();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  mocks.initialize.mockImplementationOnce(async () => {
    abort.abort();
  });
  await expect(openCodexChat(options(abort))).rejects.toThrow();
  expect(mocks.close).toHaveBeenCalled();
  expect(mocks.mcpClose).toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});

it('reattaches the provider runtime without admitting or replaying user intent', async () => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  const abort = new AbortController();
  const chat = await openCodexChat({
    ...options(abort),
    resume: true,
    reattachOnly: true,
    prompt: '',
    intent: undefined,
  });

  expect(mocks.initialize).toHaveBeenCalledOnce();
  expect(mocks.send).not.toHaveBeenCalled();
  chat.close();
});

it.each([false, true])(
  'forwards ordinary provider receipts alongside retained context (%s) without treating close as termination',
  async (withContext) => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
    const lifecycle = {
      beforeDispatch: vi.fn(),
      accepted: vi.fn(),
      terminal: vi.fn(),
      terminalConflict: vi.fn(),
    };
    const acceptedContext = vi.fn();
    const chat = await openCodexChat({
      ...options(new AbortController()),
      ordinaryTurnLifecycle: lifecycle,
      onAgentContextAccepted: acceptedContext,
      ...(withContext
        ? {
            agentContext: {
              source: 'workspace' as const,
              compilerRevision: 'fixture',
              recipeHash: 'a'.repeat(64),
              payloadHash: 'b'.repeat(64),
              profileId: 'architect',
              revision: 1,
              profileHash: 'c'.repeat(64),
              context: {
                type: 'boot_context' as const,
                source: 'contexgin' as const,
                sourceCount: 1,
                tokenCount: 5,
                tokenBudget: 1000,
                sources: [{ path: 'architecture.md', kind: 'reference' }],
                included: [],
                trimmed: [],
                fullMarkdown: 'PINNED WORKSPACE CONTEXT',
              },
            },
          }
        : {}),
    });
    const controls = mocks.conversationOptions as unknown as {
      onProviderDispatch(id: string): void;
      onProviderAccepted(id: string, thread: string, turn: string): void;
      onProviderTerminal(id: string, turn: string, status: 'completed'): void;
      onProviderTerminalConflict(id: string, thread: string, turn: string): void;
    };
    controls.onProviderDispatch('command');
    controls.onProviderAccepted('command', 'provider-thread', 'provider-turn');
    expect(lifecycle.beforeDispatch).toHaveBeenCalledWith('command');
    expect(lifecycle.accepted).toHaveBeenCalledWith('command', 'provider-thread', 'provider-turn');
    if (withContext)
      expect(acceptedContext).toHaveBeenCalledWith(
        'command',
        'provider-thread',
        'provider-turn',
        expect.stringMatching(/^[a-f0-9]{64}$/),
      );
    else expect(acceptedContext).not.toHaveBeenCalled();
    chat.close();
    expect(lifecycle.terminal).not.toHaveBeenCalled();
    controls.onProviderTerminal('command', 'provider-turn', 'completed');
    expect(lifecycle.terminal).toHaveBeenCalledWith('command', 'provider-turn', 'completed');
    controls.onProviderTerminalConflict('command', 'provider-thread', 'provider-turn');
    expect(lifecycle.terminalConflict).toHaveBeenCalledWith('command', 'provider-turn');
  },
);

it('waits for cold-reconnect runtime registration', async () => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  let release!: () => void;
  mocks.initialize.mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  const abort = new AbortController();
  const opts = options(abort);
  const opening = openCodexChat(opts);
  const waiting = waitForCodexRuntime(opts.session, 1000);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  release();
  await opening;
  expect(await waiting).toBeDefined();
  abort.abort();
});

it('waits for the reconnect session and runtime to both register', async () => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  const registry = {
    findBySessionId: vi.fn(() => undefined),
  } as unknown as import('@mitzo/harness').SessionRegistry;
  const abort = new AbortController();
  const opts = options(abort);
  const waiting = waitForCodexRuntimeBySessionId(registry, 'session', 1000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  registry.findBySessionId = vi.fn(() => ({ session: opts.session, clientId: 'client' }));
  await openCodexChat(opts);
  expect(await waiting).toBeDefined();
  abort.abort();
});

it('cancels reconnect polling when the request is aborted', async () => {
  const registry = {
    findBySessionId: vi.fn(() => undefined),
  } as unknown as import('@mitzo/harness').SessionRegistry;
  const abort = new AbortController();
  const waiting = waitForCodexRuntimeBySessionId(registry, 'session', 5000, abort.signal);
  abort.abort();
  await expect(waiting).resolves.toBeUndefined();
  expect(registry.findBySessionId).toHaveBeenCalledTimes(1);
});

it('cleans each resource once across explicit close, runtime close and abort', async () => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  const abort = new AbortController();
  const chat = await openCodexChat(options(abort));
  chat.close();
  chat.close();
  abort.abort();
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.mcpClose).toHaveBeenCalledTimes(1);
});

it('binds Telos source review to the actual native provider turn and call identity', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'sandbox');
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  const session = options(new AbortController()).session;
  const registry = {
    findBySessionId: vi.fn(() => ({ clientId: 'client', session })),
  } as unknown as import('@mitzo/harness').SessionRegistry;
  const chat = await openCodexChat({
    ...options(session.abortController),
    conversationId: 'conversation',
    registry,
  });
  mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'deny', message: 'Denied fixture' });
  const execute = mocks.conversationOptions!.executeTool as (
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    context: { turnId: string; callId: string },
  ) => Promise<unknown>;
  await execute(
    'TelosCreateOutcome',
    {
      summary: 'Outcome',
      intent: 'Result',
      rationale: 'Why',
      acceptanceCriteria: ['Evidence'],
      milestones: ['One'],
      profile: 'manual',
    },
    new AbortController().signal,
    { turnId: 'actual-turn', callId: 'actual-call' },
  );
  expect(mocks.permissionHandler).toHaveBeenCalledWith(
    'TelosCreateOutcome',
    expect.anything(),
    expect.objectContaining({
      toolUseID:
        'native:' +
        createHash('sha256')
          .update(JSON.stringify(['actual-turn', 'actual-call']))
          .digest('hex'),
      allowSessionGrant: false,
    }),
  );
  chat.close();
});

it('does not advertise unavailable host tools to an OpenShell runtime', async () => {
  vi.clearAllMocks();
  vi.stubEnv('PORT', '3100');
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'sandbox');
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  const session = options(new AbortController()).session;
  const registry = {
    findBySessionId: vi.fn(() => ({ clientId: 'client', session })),
  } as unknown as import('@mitzo/harness').SessionRegistry;
  const chat = await openCodexChat({
    ...options(session.abortController),
    conversationId: 'conversation',
    registry,
    systemPrompt: 'base prompt',
  });
  expect(mocks.conversationOptions?.systemPrompt).toContain(
    'In Agent or Auto mode, a user request to edit that workspace is the required approval',
  );
  expect(mocks.conversationOptions?.systemPrompt).not.toContain('Mitzo supplies host tools');
  expect(mocks.conversationOptions?.runtimeConfig).toEqual({ web_search: 'disabled' });
  expect(mocks.conversationOptions?.disableProjectDocuments).not.toBe(true);
  expect(mocks.conversationOptions?.tools).toEqual([
    expect.objectContaining({ name: 'ListConnections' }),
    expect.objectContaining({ name: 'RequestConnectionAccess' }),
    expect.objectContaining({ name: 'ConnectionRequest' }),
    expect.objectContaining({ name: 'ConnectionWebSocket' }),
    expect.objectContaining({ name: 'HomeAssistantDashboard' }),
    expect.objectContaining({ name: 'GetConnectionGuide' }),
    expect.objectContaining({ name: 'PrepareConnectionSetup' }),
    expect.objectContaining({ name: 'GetConnectionSetup' }),
    expect.objectContaining({ name: 'ListRepositories' }),
    expect.objectContaining({ name: 'PrepareRepositoryChat' }),
    expect.objectContaining({ name: 'GetRepositoryChatPreparation' }),
    expect.objectContaining({ name: 'SymposiumProposeProfile' }),
    expect.objectContaining({ name: 'SymposiumReadProfiles' }),
    expect.objectContaining({ name: 'TelosCreateOutcome' }),
    expect.objectContaining({ name: 'TelosAdoptSource' }),
    expect.objectContaining({ name: 'TelosGetItem' }),
    expect.objectContaining({ name: 'TelosUpdateItem' }),
    expect.objectContaining({ name: 'TelosSaveArtifact' }),
    expect.objectContaining({ name: 'TelosFindArtifacts' }),
    expect.objectContaining({ name: 'TelosReadArtifact' }),
    expect.objectContaining({ name: 'RequestWebAccess' }),
    expect.objectContaining({ name: 'RequestGithubPublish' }),
  ]);
  expect(mocks.conversationOptions?.systemPrompt).toContain(
    'never use a sandbox-local todo script',
  );
  expect(mocks.conversationOptions?.systemPrompt).toContain('TelosFindArtifacts');
  expect(mocks.connect).not.toHaveBeenCalled();
  await expect(chat.setPermissionMode?.('agent')).resolves.toBeUndefined();
  await expect(chat.setPermissionMode?.('ask')).rejects.toThrow('Ask mode');

  const input = {
    summary: 'Persist sandbox outcomes in live Telos',
    intent: 'Sandboxed agents create durable outcomes through the Mitzo host.',
    rationale: 'Local sandbox writes disappear and currently look successful.',
    acceptanceCriteria: ['The outcome is visible in the live Telos UI'],
    milestones: ['Expose the trusted host tool'],
    profile: 'manual',
  };
  mocks.permissionHandler.mockResolvedValueOnce({
    behavior: 'allow',
    updatedInput: { ...input, __mitzoTelosApproval: '00000000-0000-4000-8000-000000000001' },
  });
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        canonicalCreation: {
          ok: true,
          created: true,
          item: { id: 'telos-live', summary: input.summary },
        },
        permId: 'permission',
        sessionId: 'conversation',
        sourceSnapshotId: 'snapshot',
        operation: { kind: 'create', outcome: input },
        receipt: {
          commandId: 'command',
          actorId: 'operator:user',
          work: {
            itemId: 'telos-live',
            kind: 'outcome',
            parentId: null,
            revision: 'a'.repeat(64),
            links: [],
            assignments: [],
            sources: [],
            attempts: [],
          },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );
  vi.stubGlobal('fetch', fetch);
  const executeTool = mocks.conversationOptions?.executeTool as (
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    context?: { turnId: string; callId: string },
  ) => Promise<{ content: string; isError: boolean }>;

  await expect(
    executeTool('TelosCreateOutcome', input, new AbortController().signal, {
      turnId: 'actual-turn',
      callId: 'actual-call',
    }),
  ).resolves.toEqual({
    content: JSON.stringify({
      created: true,
      canonicalCreation: {
        ok: true,
        created: true,
        item: { id: 'telos-live', summary: input.summary },
      },
      id: 'telos-live',
      title: input.summary,
      path: '/todos/telos-live',
      sourceSnapshotId: 'snapshot',
    }),
    isError: false,
  });
  expect(mocks.permissionHandler).toHaveBeenCalledWith(
    'TelosCreateOutcome',
    input,
    expect.objectContaining({ forcePrompt: true, allowSessionGrant: false }),
  );
  expect(fetch).toHaveBeenCalledWith(
    'http://localhost:3100/api/internal/telos/source/execute',
    expect.objectContaining({
      headers: expect.objectContaining({ 'X-Client-Id': 'client' }),
    }),
  );
  mocks.useTls = true;
  mocks.permissionHandler.mockResolvedValueOnce({
    behavior: 'allow',
    updatedInput: { ...input, __mitzoTelosApproval: '00000000-0000-4000-8000-000000000001' },
  });
  await executeTool('TelosCreateOutcome', input, new AbortController().signal, {
    turnId: 'actual-turn',
    callId: 'actual-call',
  });
  expect(fetch).toHaveBeenLastCalledWith(
    'http://localhost:3101/api/internal/telos/source/execute',
    expect.objectContaining({
      headers: expect.objectContaining({ 'X-Client-Id': 'client' }),
    }),
  );
  const artifactInput = {
    requestId: 'save-spec',
    itemId: 'telos-live',
    filename: 'spec.md',
    title: 'Spec',
    path: '/sandbox/spec.md',
  };
  const receipt = { ok: true, artifact: { id: 'a'.repeat(32), revision: 1, sha256: 'hash' } };
  mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'allow', updatedInput: artifactInput });
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
  expect(
    await executeTool('TelosSaveArtifact', artifactInput, new AbortController().signal),
  ).toEqual({ content: JSON.stringify(receipt), isError: false });
  expect(mocks.permissionHandler).toHaveBeenLastCalledWith(
    'TelosSaveArtifact',
    artifactInput,
    expect.objectContaining({ forcePrompt: true, allowSessionGrant: true }),
  );
  expect(fetch).toHaveBeenLastCalledWith(
    'http://localhost:3101/api/internal/telos/artifacts/save',
    expect.anything(),
  );
  mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'deny', message: 'Denied' });
  expect(
    await executeTool('TelosSaveArtifact', artifactInput, new AbortController().signal),
  ).toEqual({ content: 'Denied', isError: true });
  const getInput = { itemId: 'telos-live' };
  const readReceipt = {
    ok: true,
    item: { id: 'telos-live', status: 'active', revision: 'a'.repeat(64) },
  };
  mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'allow', updatedInput: getInput });
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(readReceipt)));
  expect(await executeTool('TelosGetItem', getInput, new AbortController().signal)).toEqual({
    content: JSON.stringify(readReceipt),
    isError: false,
  });
  expect(mocks.permissionHandler).toHaveBeenLastCalledWith(
    'TelosGetItem',
    getInput,
    expect.objectContaining({ forcePrompt: false }),
  );
  const updateInput = {
    itemId: 'telos-live',
    requestId: 'finish',
    expectedRevision: 'a'.repeat(64),
    status: 'completed',
    note: 'Saved research meets all four criteria.',
  };
  mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'deny', message: 'Denied' });
  fetch.mockClear();
  expect(await executeTool('TelosUpdateItem', updateInput, new AbortController().signal)).toEqual({
    content: 'Denied',
    isError: true,
  });
  expect(fetch).not.toHaveBeenCalled();
  mocks.permissionHandler.mockResolvedValueOnce({
    behavior: 'allow',
    updatedInput: { ...updateInput, itemId: 'another-task' },
  });
  expect(
    (await executeTool('TelosUpdateItem', updateInput, new AbortController().signal)).isError,
  ).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  const updateReceipt = {
    ok: true,
    item: { id: 'telos-live', status: 'completed', revision: 'b'.repeat(64) },
    update: { sessionId: 'conversation', note: updateInput.note },
  };
  mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'allow', updatedInput: updateInput });
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(updateReceipt)));
  expect(await executeTool('TelosUpdateItem', updateInput, new AbortController().signal)).toEqual({
    content: JSON.stringify(updateReceipt),
    isError: false,
  });
  expect(mocks.permissionHandler).toHaveBeenLastCalledWith(
    'TelosUpdateItem',
    updateInput,
    expect.objectContaining({ forcePrompt: true, allowSessionGrant: true }),
  );
  expect(fetch).toHaveBeenLastCalledWith(
    'http://localhost:3101/api/internal/telos/items/update',
    expect.objectContaining({ body: JSON.stringify(updateInput) }),
  );
  expect(mocks.conversationOptions?.systemPrompt).toContain('before handover');
  mocks.useTls = false;
  chat.close();
  vi.unstubAllGlobals();
});

it('advertises reviewed per-chat provider grants to a managed OpenShell runtime', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'mitzo-runtime:1');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', '/config/policy.yaml');
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/seed/mgmt');
  vi.stubEnv('MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS', 'google-workspace,github');
  const ensure = vi.spyOn(OpenShellRuntimeManager.prototype, 'ensure').mockResolvedValue({
    sandboxName: 'mitzo-runtime',
    sandboxId: 'verified-resource',
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server',
    cli: 'openshell',
    gateway: 'openshell',
    workspace: 'default',
    gatewayInsecure: false,
  });
  const compile = vi.spyOn(OpenShellRuntimeManager.prototype, 'compileContext').mockResolvedValue({
    type: 'boot_context',
    scope: 'sandbox',
    sourceCount: 0,
    tokenCount: 0,
    tokenBudget: 12000,
    sources: [],
    included: [],
    trimmed: [],
    fullMarkdown: '',
  });
  const grant = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'grantServiceProvider')
    .mockResolvedValue();
  const hasAccess = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'hasServiceProviderAccess')
    .mockResolvedValue({ state: 'absent' });
  const abortController = new AbortController();
  const baseOptions = options(abortController);
  const session = baseOptions.session;
  const registry = {
    get: vi.fn(() => session),
    findBySessionId: vi.fn(() => ({ clientId: 'client', session })),
  } as unknown as import('@mitzo/harness').SessionRegistry;
  try {
    await openCodexChat({
      ...baseOptions,
      conversationId: 'conversation',
      binding: {
        accountId: 'work',
        accountLabel: 'Work',
        provider: 'openai',
        model: 'test-model',
        profileRevision: '1',
      },
      profile: {
        accountId: 'work',
        accountLabel: 'Work',
        email: 'work@example.com',
        planType: 'api',
        model: 'test-model',
        sandboxProvider: 'openai-work',
      },
      session,
      registry,
      prompt: 'Grant Google Workspace access',
      messageId: 'message',
      systemPrompt: 'base prompt',
      env: {},
    });
    expect(mocks.setArtifactRuntime).toHaveBeenCalledWith(
      'conversation',
      expect.objectContaining({ accountId: 'work' }),
      {
        runtime: expect.objectContaining({
          sandboxId: 'verified-resource',
          workdir: '/sandbox/workspaces/mgmt',
        }),
        route: { kind: 'api', provider: 'openai-work', model: 'test-model' },
      },
    );
    expect(mocks.conversationOptions?.tools).toEqual([
      expect.objectContaining({ name: 'ListConnections' }),
      expect.objectContaining({ name: 'RequestConnectionAccess' }),
      expect.objectContaining({ name: 'ConnectionRequest' }),
      expect.objectContaining({ name: 'ConnectionWebSocket' }),
      expect.objectContaining({ name: 'HomeAssistantDashboard' }),
      expect.objectContaining({ name: 'GetConnectionGuide' }),
      expect.objectContaining({ name: 'PrepareConnectionSetup' }),
      expect.objectContaining({ name: 'GetConnectionSetup' }),
      expect.objectContaining({ name: 'ListRepositories' }),
      expect.objectContaining({ name: 'PrepareRepositoryChat' }),
      expect.objectContaining({ name: 'GetRepositoryChatPreparation' }),
      expect.objectContaining({ name: 'SymposiumProposeProfile' }),
      expect.objectContaining({ name: 'SymposiumReadProfiles' }),
      expect.objectContaining({ name: 'TelosCreateOutcome' }),
      expect.objectContaining({ name: 'TelosAdoptSource' }),
      expect.objectContaining({ name: 'TelosGetItem' }),
      expect.objectContaining({ name: 'TelosUpdateItem' }),
      expect.objectContaining({ name: 'TelosSaveArtifact' }),
      expect.objectContaining({ name: 'TelosFindArtifacts' }),
      expect.objectContaining({ name: 'TelosReadArtifact' }),
      expect.objectContaining({
        name: 'GrantIntegrationAccess',
        input_schema: expect.objectContaining({
          properties: expect.objectContaining({
            provider: expect.objectContaining({ enum: ['google-workspace', 'github'] }),
          }),
        }),
      }),
      expect.objectContaining({ name: 'RequestWebAccess' }),
      expect.objectContaining({ name: 'RequestGithubPublish' }),
    ]);
    expect(mocks.conversationOptions?.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'RequestWebAccess' })]),
    );
    expect(mocks.conversationOptions?.systemPrompt).toContain('GrantIntegrationAccess');
    expect(mocks.conversationOptions?.systemPrompt).toContain(
      'Use RequestGithubPublish to publish committed local changes',
    );
    expect(mocks.conversationOptions?.systemPrompt).toContain(
      'Do not substitute direct git push or gh API writes after denial',
    );
    const adoptionEvidence = {
      storeId: 'notes',
      sourceCommit: 'a'.repeat(40),
      payloadSha256: 'b'.repeat(64),
      manifestSha256: 'c'.repeat(64),
      sandboxId: 'verified-resource',
      knowledgeRoot: '/sandbox/workspaces/knowledge/knowledge-' + 'c'.repeat(64) + '/mgmt',
      runtimeContractImageDigest: 'sha256:' + 'd'.repeat(64),
      compilerSha256: 'e'.repeat(64),
      recipeSha256: 'f'.repeat(64),
    };
    const adoption = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'adoptKnowledge')
      .mockResolvedValue({
        adoption: adoptionEvidence,
        sourceCommit: 'a'.repeat(40),
        payloadSha256: 'b'.repeat(64),
        manifestSha256: 'c'.repeat(64),
        knowledgeRoot: '/sandbox/workspaces/knowledge/revision/mgmt',
        context: {
          type: 'boot_context',
          scope: 'sandbox',
          sourceCount: 1,
          tokenCount: 2,
          tokenBudget: 12000,
          sources: [],
          included: [],
          trimmed: [],
          fullMarkdown: 'Fresh knowledge B',
        },
      });
    const prepareContext = mocks.conversationOptions?.prepareSystemPrompt as (
      signal: AbortSignal,
      turn?: { commandId: string },
    ) => Promise<string>;
    const refreshed = await prepareContext(AbortSignal.timeout(5000), { commandId: 'message' });
    expect(mocks.recordKnowledgeAdoption).not.toHaveBeenCalled();
    const acknowledged = mocks.conversationOptions?.onApplicationContextAccepted as (
      command: string,
      thread: string,
      turn: string,
      context: string,
    ) => void;
    acknowledged('message', 'provider-thread', 'provider-turn', refreshed);
    expect(mocks.recordKnowledgeAdoption).toHaveBeenCalledWith(
      'conversation',
      expect.objectContaining({ accountId: 'work' }),
      'message',
      'provider-thread',
      'provider-turn',
      {
        ...adoptionEvidence,
        contextSha256: createHash('sha256')
          .update(
            JSON.stringify({
              developerInstructions: mocks.conversationOptions?.systemPrompt,
              additionalContext: refreshed,
            }),
          )
          .digest('hex'),
      },
    );
    expect(refreshed).toContain('Fresh knowledge B');
    expect(refreshed).toContain('./mgmt: unavailable');
    expect(refreshed).toContain('./command_center/meeting_prep.py: unavailable');
    expect(refreshed).toContain('gws: entrypoint present');
    expect(refreshed).toContain('calendar event first');
    expect(refreshed).toContain('After one classified failure');
    vi.mocked(OpenShellRuntimeManager.prototype.inspectTaskCapabilities).mockResolvedValueOnce(
      undefined,
    );
    adoption.mockResolvedValueOnce(undefined);
    const unknownRuntime = await prepareContext(AbortSignal.timeout(5000));
    expect(unknownRuntime).toContain('inventory unavailable');
    expect(unknownRuntime).toContain('calendar event first');
    expect(refreshed).toContain('/sandbox/workspaces/knowledge/revision/mgmt');
    expect(String(mocks.conversationOptions?.systemPrompt) + refreshed).toContain(
      'GrantIntegrationAccess',
    );
    expect(adoption).toHaveBeenCalledWith(
      'conversation',
      expect.objectContaining({ sandboxId: 'verified-resource' }),
      expect.any(AbortSignal),
      undefined,
      'message',
    );
    expect(ensure.mock.calls[0][5]).toBe('message');
    expect(mocks.conversationOptions?.systemPrompt).toContain(
      'Mitzo preflights explicit requests for grantable integrations',
    );
    const prepareTurn = mocks.conversationOptions?.prepareTurn as (
      turn: { providerPrompt: string; userIntent?: string; turnId: string },
      signal: AbortSignal,
    ) => Promise<string | void>;
    const executeTool = mocks.conversationOptions?.executeTool as (
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<{ content: string; isError: boolean }>;
    const signal = new AbortController().signal;

    mocks.permissionHandler.mockResolvedValueOnce({
      behavior: 'allow',
      updatedInput: { provider: 'google-workspace' },
    });
    await expect(
      prepareTurn(
        {
          providerPrompt: '<context>search Gmail</context>\nlook through my emails and Google Docs',
          userIntent: 'look through my emails and Google Docs',
          turnId: 'initial',
        },
        signal,
      ),
    ).resolves.toBe(undefined);
    const refreshTransport = mocks.conversationOptions?.refreshTransportBeforeTurn as () => boolean;
    expect(refreshTransport()).toBe(true);
    const launch = vi
      .spyOn(CodexAppServerClient, 'launchOpenShell')
      .mockReturnValue({} as CodexAppServerClient);
    const createClient = mocks.conversationOptions?.createClient as (
      callbacks: Record<string, unknown>,
    ) => unknown;
    createClient({});
    expect(refreshTransport()).toBe(false);
    launch.mockRestore();
    expect(hasAccess).toHaveBeenCalledWith(
      'conversation',
      expect.objectContaining({ sandboxName: 'mitzo-runtime' }),
      'google-workspace',
      signal,
    );
    expect(grant).toHaveBeenCalledWith(
      'conversation',
      expect.objectContaining({ sandboxName: 'mitzo-runtime' }),
      'google-workspace',
      signal,
    );
    expect(mocks.permissionHandler).toHaveBeenCalledWith(
      'GrantIntegrationAccess',
      { provider: 'google-workspace' },
      expect.objectContaining({
        forcePrompt: true,
        approvalScope: 'conversation',
        controlPlane: true,
      }),
    );
    vi.clearAllMocks();

    const shouldContinue = mocks.conversationOptions?.shouldContinueAfterToolResult as (
      name: string,
      input: Record<string, unknown>,
      result: { content: string; isError: boolean },
    ) => boolean;
    for (const name of ['RequestConnectionAccess', 'GrantIntegrationAccess']) {
      await prepareTurn(
        { providerPrompt: 'continue', userIntent: 'continue', turnId: `grant-${name}` },
        signal,
      );
      mocks.permissionHandler.mockResolvedValueOnce({
        behavior: 'allow',
        updatedInput: { provider: 'google-workspace' },
      });
      const input =
        name === 'RequestConnectionAccess'
          ? { connectionId: 'openshell:google-workspace' }
          : { provider: 'google-workspace' };
      const result = await executeTool(name, input, signal);
      expect(result.isError).toBe(false);
      expect(shouldContinue(name, input, result)).toBe(true);
      // Merely claiming success (or another tool running while refresh is pending)
      // is not evidence that this exact tool attached a provider.
      expect(shouldContinue(name, input, { content: 'available', isError: false })).toBe(false);
      const reset = vi
        .spyOn(CodexAppServerClient, 'launchOpenShell')
        .mockReturnValue({} as CodexAppServerClient);
      createClient({});
      expect(shouldContinue(name, input, result)).toBe(false);
      reset.mockRestore();
      vi.clearAllMocks();
      hasAccess.mockResolvedValueOnce({ state: 'available' });
      const alreadyAttached = await executeTool(name, input, signal);
      expect(alreadyAttached.isError).toBe(false);
      expect(shouldContinue(name, input, alreadyAttached)).toBe(false);
      expect(refreshTransport()).toBe(false);
      expect(grant).not.toHaveBeenCalled();
      expect(mocks.permissionHandler).not.toHaveBeenCalled();
      vi.clearAllMocks();
    }

    // A persisted approval whose first physical attach failed is recoverable:
    // retry it without showing a second permission prompt in this chat/turn.
    mocks.permissionHandler.mockResolvedValueOnce({
      behavior: 'allow',
      updatedInput: { provider: 'google-workspace' },
    });
    grant.mockRejectedValueOnce(new Error('attach failed'));
    await expect(
      prepareTurn(
        {
          providerPrompt: 'search Gmail for Cat',
          userIntent: 'search Gmail for Cat',
          turnId: 'attach-failed',
        },
        signal,
      ),
    ).resolves.toContain('did not enable Google Workspace');
    expect(refreshTransport()).toBe(false);
    expect(mocks.permissionHandler).toHaveBeenCalledOnce();
    vi.clearAllMocks();

    // A model tool retry in that same failed turn sees the durable approval,
    // retries the attach, and never asks for consent again even if it fails.
    hasAccess.mockResolvedValueOnce({ state: 'approved-detached' });
    grant.mockRejectedValueOnce(new Error('retry attach failed'));
    await expect(
      executeTool('GrantIntegrationAccess', { provider: 'google-workspace' }, signal),
    ).resolves.toMatchObject({ isError: true, content: 'Integration provider attachment failed' });
    expect(mocks.permissionHandler).not.toHaveBeenCalled();
    expect(grant).toHaveBeenCalledOnce();
    vi.clearAllMocks();

    hasAccess
      .mockResolvedValueOnce({ state: 'approved-detached' })
      .mockResolvedValueOnce({ state: 'approved-detached' })
      .mockResolvedValueOnce({ state: 'available' });
    await expect(
      prepareTurn(
        {
          providerPrompt: 'search Gmail for Cat',
          userIntent: 'search Gmail for Cat',
          turnId: 'recover-approved-attachment',
        },
        signal,
      ),
    ).resolves.toBe(undefined);
    await expect(
      executeTool('GrantIntegrationAccess', { provider: 'google-workspace' }, signal),
    ).resolves.toMatchObject({ isError: false });
    expect(mocks.permissionHandler).not.toHaveBeenCalled();
    expect(grant).toHaveBeenCalledOnce();
    vi.clearAllMocks();

    hasAccess.mockResolvedValueOnce({
      state: 'indeterminate',
      error: new Error('OpenShell provider list failed'),
    });
    await expect(
      prepareTurn(
        {
          providerPrompt: 'search Gmail for Cat',
          userIntent: 'search Gmail for Cat',
          turnId: 'provider-list-failed',
        },
        signal,
      ),
    ).rejects.toThrow('OpenShell provider list failed');
    expect(mocks.permissionHandler).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();

    await expect(
      prepareTurn(
        {
          providerPrompt: '<context-file>search Gmail for Cat</context-file>\nwrite a summary',
          userIntent: 'write a summary',
          turnId: 'context-only',
        },
        signal,
      ),
    ).resolves.toBe(undefined);
    expect(mocks.permissionHandler).not.toHaveBeenCalled();

    await expect(
      prepareTurn(
        { providerPrompt: 'search Gmail for Cat', turnId: 'legacy-without-intent' },
        signal,
      ),
    ).resolves.toBe(undefined);
    expect(mocks.permissionHandler).not.toHaveBeenCalled();

    await expect(
      prepareTurn(
        {
          providerPrompt: '<rendered-skill>search Gmail for Cat</rendered-skill>',
          userIntent: 'draft an email to Cat',
          turnId: 'draft',
        },
        signal,
      ),
    ).resolves.toBe(undefined);
    expect(mocks.permissionHandler).not.toHaveBeenCalled();

    hasAccess.mockResolvedValueOnce({ state: 'available' });
    await expect(
      prepareTurn(
        {
          providerPrompt: 'search Gmail again',
          userIntent: 'search Gmail again',
          turnId: 'attached',
        },
        signal,
      ),
    ).resolves.toBe(undefined);
    expect(mocks.permissionHandler).not.toHaveBeenCalled();

    mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'deny', message: 'Denied' });
    await expect(
      prepareTurn(
        {
          providerPrompt: 'find a document in Google Drive',
          userIntent: 'find a document in Google Drive',
          turnId: 'denied',
        },
        signal,
      ),
    ).resolves.toContain('Do not run its CLI or claim a gateway outage');
    expect(grant).not.toHaveBeenCalled();
    vi.clearAllMocks();

    await expect(
      executeTool('GrantIntegrationAccess', { provider: 'google-workspace' }, signal),
    ).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining('denied for this turn'),
    });
    expect(mocks.permissionHandler).not.toHaveBeenCalled();

    mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'deny', message: 'Denied again' });
    await expect(
      prepareTurn(
        {
          providerPrompt: 'find a document in Google Drive',
          userIntent: 'find a document in Google Drive',
          turnId: 'retry',
        },
        signal,
      ),
    ).resolves.toContain('Do not run its CLI or claim a gateway outage');
    expect(mocks.permissionHandler).toHaveBeenCalledOnce();
    vi.clearAllMocks();

    await prepareTurn(
      { providerPrompt: 'continue', userIntent: 'continue', turnId: 'tool-turn' },
      signal,
    );

    await expect(
      executeTool('GrantIntegrationAccess', { provider: 'unreviewed-provider' }, signal),
    ).resolves.toMatchObject({ isError: true });
    expect(mocks.permissionHandler).not.toHaveBeenCalled();

    mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'deny', message: 'Denied' });
    await expect(
      executeTool('GrantIntegrationAccess', { provider: 'google-workspace' }, signal),
    ).resolves.toMatchObject({ isError: true });
    expect(grant).not.toHaveBeenCalled();
    expect(mocks.permissionHandler).toHaveBeenCalledOnce();

    await expect(
      executeTool('GrantIntegrationAccess', { provider: 'google-workspace' }, signal),
    ).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining('denied for this turn'),
    });
    expect(mocks.permissionHandler).toHaveBeenCalledOnce();

    await prepareTurn(
      { providerPrompt: 'continue', userIntent: 'continue', turnId: 'tool-retry' },
      signal,
    );

    mocks.permissionHandler.mockResolvedValueOnce({
      behavior: 'allow',
      updatedInput: { provider: 'google-workspace' },
    });
    await expect(
      executeTool('GrantIntegrationAccess', { provider: 'google-workspace' }, signal),
    ).resolves.toMatchObject({ isError: false });
    expect(grant).toHaveBeenCalledOnce();

    mocks.permissionHandler.mockResolvedValueOnce({
      behavior: 'allow',
      updatedInput: { provider: 'github' },
    });
    await expect(
      executeTool('GrantIntegrationAccess', { provider: 'google-workspace' }, signal),
    ).resolves.toMatchObject({ isError: true });
    expect(grant).toHaveBeenCalledOnce();
    expect(mocks.permissionHandler).toHaveBeenCalledWith(
      'GrantIntegrationAccess',
      { provider: 'google-workspace' },
      expect.objectContaining({
        forcePrompt: true,
        approvalScope: 'conversation',
        rememberSessionGrant: false,
        controlPlane: false,
        title: 'Grant Google Workspace to this conversation?',
        description: expect.stringContaining('across reconnects and Mitzo restarts'),
      }),
    );

    mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'deny', message: 'Denied' });
    await executeTool('GrantIntegrationAccess', { provider: 'github' }, signal);
    expect(mocks.permissionHandler).toHaveBeenLastCalledWith(
      'GrantIntegrationAccess',
      { provider: 'github' },
      expect.objectContaining({
        controlPlane: false,
        title: 'Grant GitHub to this conversation?',
        description: expect.stringContaining('reviewed GitHub provider'),
      }),
    );
  } finally {
    ensure.mockRestore();
    compile.mockRestore();
    grant.mockRestore();
    hasAccess.mockRestore();
    vi.unstubAllEnvs();
  }
});

it('preserves image attachments while binding a trusted capability, forcing approval, and recovering on reconnect', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'mitzo-runtime:1');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', '/config/policy.yaml');
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/seed/mgmt');
  const ensure = vi.spyOn(OpenShellRuntimeManager.prototype, 'ensure').mockResolvedValue({
    sandboxName: 'mitzo-runtime',
    sandboxId: 'verified-resource',
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server',
    cli: 'openshell',
    gateway: 'openshell',
    workspace: 'default',
    gatewayInsecure: false,
  });
  vi.spyOn(OpenShellRuntimeManager.prototype, 'compileContext').mockResolvedValue({
    type: 'boot_context',
    scope: 'sandbox',
    sourceCount: 0,
    tokenCount: 0,
    tokenBudget: 12000,
    sources: [],
    included: [],
    trimmed: [],
    fullMarkdown: '',
  });
  const capability = {
    capabilityId: 'github.publish-pr',
    capabilityVersion: 1,
    connectionId: 'github-connection',
    connectionRevision: 4,
  };
  const capabilityInput = {
    connectionId: 'github-connection',
    repositoryPath: '/workspace',
    baseBranch: 'main',
    title: 'T',
    body: 'B',
    draft: false,
  } satisfies Readonly<Record<string, string | boolean>>;
  const recoverPendingForConversation = vi.fn(async () => []);
  const invoke = vi.fn(
    async (
      request: import('../connections/capabilities/types.js').CapabilityRequest,
      signal: AbortSignal,
      approve: import('../connections/capabilities/types.js').CapabilityApproval,
    ) => {
      // The production service validates unknown tool input before it becomes
      // approval-card data. This session fixture supplies that already-typed
      // capability input rather than bypassing the contract with a cast.
      expect(request.input).toEqual(capabilityInput);
      const approved = await approve(
        {
          capabilityId: capability.capabilityId,
          capabilityVersion: capability.capabilityVersion,
          connectionId: capability.connectionId,
          operationId: 'operation-1',
          input: capabilityInput,
          forcePrompt: true,
        },
        signal,
      );
      return {
        id: 'operation-1',
        status: approved ? 'verification_pending' : 'denied',
        result: null,
      };
    },
  );
  const managedConnection = {
    id: 'github-connection',
    revision: 4,
    templateId: 'github-readonly',
    templateVersion: 1,
    gatewayProviderId: 'provider-id',
    gatewayProviderName: 'provider-name',
    publicConfig: {},
  } as unknown as import('../connections-store.js').Connection;
  const service = {
    withAccountRuntimes: vi.fn(
      async (
        _account: string,
        work: (connections: (typeof managedConnection)[]) => Promise<unknown>,
      ) => work([managedConnection]),
    ),
    withAccountRuntime: vi.fn(
      async (_account: string, work: (connection: typeof managedConnection) => Promise<unknown>) =>
        work(managedConnection),
    ),
    onDemandForAccount: vi.fn(() => []),
    verifyRuntimeSandbox: vi.fn(),
  };
  setConnectionsRuntime({
    service,
    capabilities: {
      eligibleToolsForManagedConnection: vi.fn(() => [capability]),
      recoverPendingForConversation,
      invoke,
    },
  } as unknown as import('../connections-runtime.js').ConnectionsRuntime);
  const abortController = new AbortController();
  const base = options(abortController);
  const session = base.session;
  const registry = {
    findBySessionId: vi.fn(() => ({ clientId: 'client', session })),
  } as unknown as import('@mitzo/harness').SessionRegistry;
  mocks.permissionHandler.mockResolvedValue({ behavior: 'allow' });
  try {
    const chat = await openCodexChat({
      ...base,
      session,
      registry,
      conversationId: 'capability-conversation',
      messageId: 'message',
      prompt: 'publish',
      systemPrompt: 'base',
      env: {},
      images: [{ data: 'cHJldmlldw==', mediaType: 'image/png' }],
      binding: {
        accountId: 'work',
        accountLabel: 'Work',
        provider: 'openai',
        model: 'test-model',
        profileRevision: '1',
      },
      profile: {
        accountId: 'work',
        accountLabel: 'Work',
        email: 'work@example.com',
        planType: 'api',
        model: 'test-model',
        sandboxProvider: 'openai-work',
      },
    });
    const tool = (mocks.conversationOptions?.tools as Array<{ name: string }>).find((item) =>
      item.name.startsWith('Capability_github_publish_pr'),
    );
    expect(tool).toBeDefined();
    expect(mocks.conversationOptions?.systemPrompt).toContain('Use RequestGithubPublish');
    expect(mocks.conversationOptions?.systemPrompt).not.toContain(
      'GitHub publishing is unavailable',
    );
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ images: [{ data: 'cHJldmlldw==', mediaType: 'image/png' }] }),
    );
    expect(getLiveCapabilityConversationBinding('capability-conversation')).toMatchObject({
      accountId: 'work',
      connectionId: 'github-connection',
      connectionRevision: 4,
    });
    expect(recoverPendingForConversation).toHaveBeenCalledWith(
      'work',
      'capability-conversation',
      expect.any(AbortSignal),
    );
    const executeTool = mocks.conversationOptions?.executeTool as (
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
      context: { turnId: string; callId: string },
    ) => Promise<{ content: string; isError: boolean }>;
    await expect(
      executeTool(tool!.name, capabilityInput, new AbortController().signal, {
        turnId: 'turn-1',
        callId: 'call-1',
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'work',
        conversationId: 'capability-conversation',
        connectionId: 'github-connection',
      }),
      expect.any(AbortSignal),
      expect.anything(),
    );
    expect(mocks.permissionHandler).toHaveBeenCalledWith(
      'ExecuteProviderCapability',
      expect.any(Object),
      expect.objectContaining({ forcePrompt: true, approvalScope: 'session' }),
    );
    const beforeReconnect = mocks.conversationOptions?.beforeReconnect as () => Promise<void>;
    mocks.setArtifactRuntime.mockClear();
    ensure.mockResolvedValueOnce({
      ...(await ensure.mock.results[0].value),
      sandboxId: 'recovered-resource',
    });
    const migration = vi
      .spyOn(migrationAdapter, 'prepareRetainedRuntimeMigration')
      .mockImplementationOnce(async (input) => {
        // Reconnect must select the preserved candidate before persisting routing
        // or opening a provider transport against the checkpointed old source.
        expect(mocks.setArtifactRuntime).not.toHaveBeenCalled();
        return {
          ...input.source,
          runtime: { ...input.source.runtime, sandboxName: 'mitzo-migrate-reconnected' },
        };
      });
    await beforeReconnect();
    expect(migration).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source: expect.objectContaining({
          runtime: expect.objectContaining({ sandboxId: 'recovered-resource' }),
        }),
      }),
    );
    expect(mocks.setArtifactRuntime).toHaveBeenLastCalledWith(
      'capability-conversation',
      expect.objectContaining({ accountId: 'work' }),
      expect.objectContaining({
        runtime: expect.objectContaining({
          sandboxId: 'recovered-resource',
          sandboxName: 'mitzo-migrate-reconnected',
        }),
      }),
    );
    expect(recoverPendingForConversation).toHaveBeenCalledTimes(2);
    expect(ensure).toHaveBeenCalled();
    chat.close();
    expect(getLiveCapabilityConversationBinding('capability-conversation')).toBeUndefined();
  } finally {
    setConnectionsRuntime(null);
    vi.unstubAllEnvs();
  }
});

it('registers a newly ensured sandbox before context initialization can fail', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'mitzo-runtime:1');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', '/config/policy.yaml');
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/seed/mgmt');
  const ensure = vi.spyOn(OpenShellRuntimeManager.prototype, 'ensure').mockResolvedValue({
    sandboxName: 'mitzo-runtime',
    sandboxId: 'physical-id',
    created: true,
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server',
    cli: 'openshell',
    gateway: 'openshell',
    workspace: 'default',
    gatewayInsecure: false,
  });
  const provisional = vi.spyOn(lifecycleController, 'registerOpenShellLifecycleProvisional');
  const compile = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'compileContext')
    .mockImplementationOnce(async () => {
      expect(provisional).toHaveBeenCalledWith(
        'conversation',
        expect.objectContaining({ sandboxId: 'physical-id', created: true }),
        expect.objectContaining({ provider: 'openai-work' }),
        'client',
      );
      throw new Error('context initialization failed');
    });
  const abortController = new AbortController();
  const baseOptions = options(abortController);
  const session = baseOptions.session;
  const registry = {
    findBySessionId: vi.fn(() => ({ clientId: 'client', session })),
  } as unknown as import('@mitzo/harness').SessionRegistry;
  try {
    await expect(
      openCodexChat({
        ...baseOptions,
        conversationId: 'conversation',
        binding: {
          accountId: 'work',
          accountLabel: 'Work',
          provider: 'openai',
          model: 'test-model',
          profileRevision: '1',
        },
        profile: {
          accountId: 'work',
          accountLabel: 'Work',
          email: 'work@example.com',
          planType: 'api',
          model: 'test-model',
          sandboxProvider: 'openai-work',
        },
        session,
        registry,
        prompt: 'test',
        messageId: 'message',
        systemPrompt: 'base prompt',
        env: {},
      }),
    ).rejects.toThrow('context initialization failed');
    expect(provisional).toHaveBeenCalledOnce();
    expect(mocks.initialize).not.toHaveBeenCalled();
  } finally {
    ensure.mockRestore();
    provisional.mockRestore();
    compile.mockRestore();
    vi.unstubAllEnvs();
  }
});

it('releases startup reservation before hook or client construction when environment attestation fails', async () => {
  vi.clearAllMocks();
  mocks.conversationOptions = undefined;
  const release = vi.fn();
  const { sharedOpenShellLifecycleCoordinator } = await import('../openshell-lifecycle.js');
  const reserve = vi
    .spyOn(sharedOpenShellLifecycleCoordinator, 'reserve')
    .mockResolvedValue(release);
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'mitzo-runtime:1');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', '/config/policy.yaml');
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/seed/mgmt');
  const ensure = vi.spyOn(OpenShellRuntimeManager.prototype, 'ensure').mockResolvedValue({
    sandboxName: 'mitzo-runtime',
    sandboxId: 'physical-id',
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server',
    cli: 'openshell',
    gateway: 'openshell',
    workspace: 'default',
    gatewayInsecure: false,
  });
  const compile = vi.spyOn(OpenShellRuntimeManager.prototype, 'compileContext').mockResolvedValue({
    type: 'boot_context',
    scope: 'sandbox',
    sourceCount: 0,
    tokenCount: 0,
    tokenBudget: 12000,
    sources: [],
    included: [],
    trimmed: [],
    fullMarkdown: '',
  });
  const nativeHooks = await import('../native-hooks.js');
  const hooks = vi.spyOn(nativeHooks, 'createNativeHooks');
  const client = vi.spyOn(CodexAppServerClient, 'launchOpenShell');
  const failure = new RuntimePolicyAttestationError('Unreviewed public provider profile');
  vi.mocked(OpenShellRuntimeManager.prototype.observeContract).mockRejectedValueOnce(failure);
  try {
    const baseOptions = options(new AbortController());
    await expect(
      openCodexChat({
        ...baseOptions,
        conversationId: 'conversation',
        binding: {
          accountId: 'work',
          accountLabel: 'Work',
          provider: 'openai',
          model: 'test-model',
          profileRevision: '1',
        },
        profile: {
          accountId: 'work',
          accountLabel: 'Work',
          email: 'work@example.com',
          planType: 'api',
          model: 'test-model',
          sandboxProvider: 'openai-work',
        },
        prompt: 'Read Gmail evidence',
        messageId: 'message',
        systemPrompt: 'fixture',
        env: {},
      }),
    ).rejects.toMatchObject({ phase: 'runtime_connection', cause: failure });
    expect(release).toHaveBeenCalledOnce();
    expect(hooks).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.conversationOptions).toBeUndefined();
  } finally {
    reserve.mockRestore();
    ensure.mockRestore();
    compile.mockRestore();
    hooks.mockRestore();
    client.mockRestore();
  }
});

it('rejects the legacy shared-sandbox seam in production', async () => {
  vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'shared-sandbox');
  try {
    await expect(openCodexChat(options(new AbortController()))).rejects.toThrow(
      'disabled in production',
    );
    expect(mocks.initialize).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('rejects OpenShell Ask mode before enabling provider-native tools', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'sandbox');
  try {
    await expect(
      openCodexChat({
        ...options(new AbortController()),
        session: { ...options(new AbortController()).session, mode: 'ask' },
      }),
    ).rejects.toThrow('Ask mode');
    expect(mocks.initialize).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('never loads trusted project hooks on the host for OpenShell sessions', async () => {
  vi.clearAllMocks();
  const cwd = mkdtempSync(join(tmpdir(), 'mitzo-openshell-hooks-'));
  const marker = join(cwd, 'host-hook-ran');
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: `touch ${marker}` }] }],
      },
    }),
  );
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'sandbox');
  vi.stubEnv('MITZO_TRUST_PROJECT_HOOKS', '1');
  try {
    await openCodexChat({
      ...options(new AbortController()),
      session: { ...options(new AbortController()).session, cwd },
    });
    expect(mocks.conversationOptions?.beforeComplete).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it('fails closed instead of substituting API billing for a ChatGPT subscription in OpenShell', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'sandbox');
  await expect(
    openCodexChat({
      ...options(new AbortController()),
      profile: {
        accountId: 'personal',
        accountLabel: 'Personal ChatGPT',
        credentialRef: '/test/login',
        email: 'test@example.invalid',
        planType: 'pro',
        model: 'test-model',
      },
    }),
  ).rejects.toThrow('brokered Codex OAuth');
  expect(mocks.initialize).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});

it('rejects managed OpenShell subscription profiles before provisioning a sandbox', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'mitzo-runtime:1');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', '/config/policy.yaml');
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/seed/mgmt');
  try {
    await expect(
      openCodexChat({
        ...options(new AbortController()),
        profile: {
          accountId: 'personal',
          accountLabel: 'Personal ChatGPT',
          credentialRef: '/test/login',
          email: 'test@example.invalid',
          planType: 'pro',
          model: 'test-model',
          sandboxProvider: 'personal-chatgpt',
        },
      }),
    ).rejects.toThrow('brokered Codex OAuth');
    expect(mocks.initialize).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('rejects managed OpenShell API profiles without an account provider binding', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'mitzo-runtime:1');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', '/config/policy.yaml');
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/seed/mgmt');
  try {
    await expect(openCodexChat(options(new AbortController()))).rejects.toThrow(
      'sandbox provider binding',
    );
    expect(mocks.initialize).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('rejects a grantable account provider before opening a managed OpenShell chat', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'mitzo-runtime:1');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', '/config/policy.yaml');
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/seed/mgmt');
  vi.stubEnv('MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS', 'google-workspace');
  try {
    await expect(
      openCodexChat({
        ...options(new AbortController()),
        binding: {
          accountId: 'work',
          accountLabel: 'Work',
          provider: 'openai',
          model: 'test-model',
          profileRevision: '1',
        },
        profile: {
          accountId: 'work',
          accountLabel: 'Work',
          email: 'work@example.com',
          planType: 'api',
          model: 'test-model',
          sandboxProvider: 'google-workspace',
        },
      }),
    ).rejects.toThrow('account provider cannot also be grantable: google-workspace');
    expect(mocks.initialize).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it.each([
  'send',
  'reattach',
  'failure',
  'revoked',
  'added',
  'retained',
  'unavailable-retained',
  'unavailable-added',
  'jira-retained',
] as const)(
  'releases the real connection reservation before first-turn admission (%s)',
  async (mode) => {
    vi.clearAllMocks();
    vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
    vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'mitzo-runtime:1');
    vi.stubEnv('MITZO_OPENSHELL_POLICY', '/config/policy.yaml');
    vi.stubEnv('MITZO_OPENSHELL_SEED', '/seed/mgmt');
    const service = new ConnectionsService(
      {
        get: () => ({
          archivedAt: null,
          ownerId: 'operator',
          gateway: 'openshell',
          workspace: 'default',
        }),
      } as unknown as import('../connections-store.js').ConnectionStore,
      {
        get: vi.fn(async () => {
          if (mode === 'unavailable-retained' || mode === 'unavailable-added')
            throw new Error('added provider unavailable');
          return {
            name: 'changed-provider',
            id: 'changed-provider',
            workspace: 'default',
            type: mode === 'jira-retained' ? 'jira-readonly' : 'github',
          };
        }),
        validateBinding: vi.fn(),
        sandbox: vi.fn().mockResolvedValue({ name: 'retained' }),
        sandboxProviders: vi.fn().mockResolvedValue([]),
      } as unknown as import('../connections-gateway.js').ConnectionGateway,
    );
    const connection = {
      id: 'changed-connection',
      templateId: mode === 'jira-retained' ? 'jira-readonly' : 'github-readonly',
      publicConfig: { email: 'person@example.com' },
      ownerId: 'operator',
      label: 'Added connection',
      endpoint: 'https://api.github.com',
      gateway: 'openshell',
      submittedEmail: '',
      status: 'active',
      revision: 1,
      desiredAccountIds: ['work'],
      identity: 'test',
      verifiedAt: 1,
      errorCode: null,
      archivedAt: null,
      createdAt: 1,
      updatedAt: 1,
      templateVersion: 1,
      workspace: 'default',
      gatewayProviderName: 'changed-provider',
      gatewayProviderId: 'changed-provider',
    } as import('../connections-store.js').Connection;
    const resolveConnections = vi
      .spyOn(service, 'resolveAutomaticForAccount')
      .mockReturnValue(mode === 'revoked' || mode.endsWith('retained') ? [connection] : []);
    vi.spyOn(service, 'onDemandForAccount').mockReturnValue([]);
    const ensure = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'ensure')
      .mockImplementation(async function (this: OpenShellRuntimeManager) {
        if (mode.endsWith('retained'))
          expect(
            (this as unknown as { config: { serviceProviders: string[] } }).config.serviceProviders,
          ).not.toContain(connection.gatewayProviderName);
        return {
          sandboxName: 'mitzo-lock-test',
          sandboxId: 'physical-lock-test',
          workdir: '/sandbox/workspaces/mgmt',
          appServerCommand: '/sandbox/run-mitzo-app-server',
          cli: 'openshell',
          gateway: 'openshell',
          workspace: 'default',
          gatewayInsecure: false,
        };
      });
    const compile = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'compileContext')
      .mockResolvedValue({
        type: 'boot_context',
        scope: 'sandbox',
        sourceCount: 0,
        tokenCount: 0,
        tokenBudget: 12000,
        sources: [],
        included: [],
        trimmed: [],
        fullMarkdown: '',
      });
    setConnectionsRuntime({
      service,
    } as unknown as import('../connections-runtime.js').ConnectionsRuntime);
    let admitted = false;
    mocks.send.mockImplementationOnce(async () => {
      if (mode === 'revoked') resolveConnections.mockReturnValue([]);
      if (mode === 'added' || mode === 'unavailable-added')
        resolveConnections.mockReturnValue([connection]);
      const guard = mocks.conversationOptions!.reconnectGuard as (
        work: () => Promise<void>,
      ) => Promise<void>;
      await guard(async () => {
        admitted = true;
      });
      if (mode === 'failure') throw new Error('first-turn admission failed');
    });
    const abort = new AbortController();
    try {
      const base = options(abort);
      const session = base.session;
      const request = openCodexChat({
        ...base,
        conversationId: 'lock-' + mode,
        binding: {
          accountId: 'work',
          accountLabel: 'Work',
          provider: 'openai',
          model: 'test-model',
          profileRevision: '1',
        },
        profile: {
          accountId: 'work',
          accountLabel: 'Work',
          email: 'work@example.com',
          planType: 'api',
          model: 'test-model',
          sandboxProvider: 'openai-work',
        },
        registry: {
          findBySessionId: () => ({ clientId: 'client', session }),
        } as unknown as import('@mitzo/harness').SessionRegistry,
        prompt: 'test',
        messageId: 'first-turn',
        systemPrompt: 'base',
        env: {},
        reattachOnly: mode === 'reattach',
        resume: mode.endsWith('retained'),
      });
      let timer: ReturnType<typeof setTimeout>;
      const bounded = Promise.race([
        request,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('connection reservation deadlocked')), 500);
        }),
      ]).finally(() => clearTimeout(timer));
      if (mode === 'failure' || mode === 'revoked') {
        await expect(bounded).rejects.toThrow(
          mode === 'failure'
            ? 'first-turn admission failed'
            : 'Connection permissions changed. Start a new conversation.',
        );
        expect(admitted).toBe(mode === 'failure');
        expect(mocks.close).toHaveBeenCalled();
      } else {
        const chat = await bounded;
        expect(admitted).toBe(mode !== 'reattach');
        if (mode === 'jira-retained')
          expect(mocks.conversationOptions!.systemPrompt).not.toContain(
            'verified read-only Jira access',
          );
        expect(mocks.send).toHaveBeenCalledTimes(mode === 'reattach' ? 0 : 1);
        chat.close();
      }
      // Setup and admission both release the actual service's serial gate.
      resolveConnections.mockReturnValue([]);
      await service.withAccountRuntimes('work', async () => undefined);
    } finally {
      abort.abort();
      setConnectionsRuntime(null);
      ensure.mockRestore();
      compile.mockRestore();
      mocks.send.mockReset();
    }
  },
);

it('preserves first launch and valid restore while failing closed for a replacement with no lifecycle state', async () => {
  vi.clearAllMocks();
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-openshell-chat-resume-'));
  const policy = join(directory, 'policy.yaml');
  writeFileSync(policy, 'reviewed: policy\n');
  mocks.privateDirectory = directory;
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'mitzo-runtime:1');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', policy);
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/seed/mgmt');
  const lifecycle = lifecycleController.initializeOpenShellLifecycle(
    {
      cli: 'openshell',
      image: 'mitzo-runtime:1',
      policy,
      seed: '/seed/mgmt',
      serviceProviders: [],
      grantableServiceProviders: [],
      workspace: 'default',
      gateway: 'openshell',
      gatewayInsecure: false,
      createDetached: true,
      sandboxIdLength: 13,
      workdir: '/sandbox/workspaces/mgmt',
      webSearch: 'disabled',
    },
    {
      registry: { findBySessionId: () => undefined, entries: function* () {} },
      eventStore: { getSession: () => ({}) },
      taskStore: { getTree: () => [], getTelosExecutionBinding: () => null },
      queue: () => ({ queued: 0, running: 0, recovery: false }),
    },
  )!;
  const replacement = {
    sandboxName: 'mitzo-runtime',
    sandboxId: 'replacement-id',
    created: true,
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server' as const,
    cli: 'openshell',
    gateway: 'openshell',
    workspace: 'default',
    gatewayInsecure: false,
  };
  const restored = { ...replacement, sandboxId: 'restored-id', created: false };
  const ensure = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'ensure')
    .mockResolvedValueOnce(replacement)
    .mockResolvedValueOnce(replacement)
    .mockResolvedValueOnce(restored);
  const provisional = vi.spyOn(lifecycleController, 'registerOpenShellLifecycleProvisional');
  const compile = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'compileContext')
    .mockRejectedValueOnce(new Error('context initialization failed'))
    .mockResolvedValue({
      type: 'boot_context',
      scope: 'sandbox',
      sourceCount: 0,
      tokenCount: 0,
      tokenBudget: 12000,
      sources: [],
      included: [],
      trimmed: [],
      fullMarkdown: '',
    });
  const baseOptions = options(new AbortController());
  const session = baseOptions.session;
  const registry = {
    findBySessionId: vi.fn(() => ({ clientId: 'client', session })),
  } as unknown as import('@mitzo/harness').SessionRegistry;
  const binding = {
    accountId: 'work',
    accountLabel: 'Work',
    provider: 'openai',
    model: 'test-model',
    profileRevision: '1',
  };
  const profile = {
    accountId: 'work',
    accountLabel: 'Work',
    email: 'work@example.com',
    planType: 'api' as const,
    model: 'test-model',
    sandboxProvider: 'openai-work',
  };
  const chatOptions = (conversationId: string, resume = false) => ({
    ...baseOptions,
    resume,
    conversationId,
    binding,
    profile,
    session,
    registry,
    prompt: 'resume',
    messageId: 'message',
    systemPrompt: 'base prompt',
    env: {},
  });
  try {
    await expect(openCodexChat(chatOptions('first-launch'))).rejects.toThrow(
      'context initialization failed',
    );
    expect(lifecycle.store.get('first-launch')).toMatchObject({
      physicalSandboxId: 'replacement-id',
      identity: null,
    });

    await expect(openCodexChat(chatOptions('missing-lifecycle-state', true))).rejects.toThrow(
      'OpenShell existing conversation has no verified recovery record',
    );
    expect(provisional).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(lifecycle.store.get('missing-lifecycle-state')).toBeNull();

    lifecycleController.registerOpenShellLifecycle(
      'valid-lifecycle-state',
      restored,
      binding,
      { kind: 'api', provider: 'openai-work', model: 'test-model' },
      'thread',
      'client',
    );
    const checkpointed = lifecycle.store.get('valid-lifecycle-state')!;
    lifecycle.store.upsert({
      ...checkpointed,
      generation: checkpointed.generation + 1,
      checkpoint: {
        path: '/private/checkpoint',
        digest: 'digest',
        version: 1,
        sandboxId: 'restored-id',
        sourceResourceVersion: 'ready-v1',
      },
    });
    const chat = await openCodexChat(chatOptions('valid-lifecycle-state', true));
    expect(mocks.initialize).toHaveBeenCalled();
    expect(lifecycle.store.get('valid-lifecycle-state')).toMatchObject({
      physicalSandboxId: 'restored-id',
      checkpoint: expect.objectContaining({ digest: 'digest' }),
      identity: expect.objectContaining({ threadId: 'thread' }),
    });
    const onThreadChanged = mocks.conversationOptions?.onThreadChanged as
      ((threadId: string) => void) | undefined;
    expect(onThreadChanged).toBeTypeOf('function');
    onThreadChanged!('thread-generation-2');
    expect(lifecycle.store.get('valid-lifecycle-state')).toMatchObject({
      checkpoint: null,
      identity: expect.objectContaining({ threadId: 'thread-generation-2' }),
    });
    chat.close();
    // Enroll a retained task checkout whose boot guidance is older than the
    // accepted publication. It must never become persistent thread instructions.
    const enrollment = vi
      .spyOn(knowledgeStoreConfig, 'knowledgeStoreFromEnvironment')
      .mockReturnValue({
        id: 'mgmt',
        reconcile: vi.fn(),
      });
    ensure.mockResolvedValue(restored);
    compile.mockClear();
    compile.mockResolvedValue({
      type: 'boot_context',
      scope: 'sandbox',
      sourceCount: 1,
      tokenCount: 1,
      tokenBudget: 12000,
      sources: [],
      included: [],
      trimmed: [],
      fullMarkdown: 'OLD TASK CHECKOUT GUIDANCE',
    });
    const adoption = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'adoptKnowledge')
      .mockResolvedValue({
        sourceCommit: 'a'.repeat(40),
        payloadSha256: 'b'.repeat(64),
        manifestSha256: 'c'.repeat(64),
        knowledgeRoot: '/sandbox/workspaces/knowledge/fresh/mgmt',
        adoption: {
          storeId: 'mgmt',
          sourceCommit: 'a'.repeat(40),
          payloadSha256: 'b'.repeat(64),
          manifestSha256: 'c'.repeat(64),
          sandboxId: 'restored-id',
          knowledgeRoot: '/sandbox/workspaces/knowledge/fresh/mgmt',
          runtimeContractImageDigest: 'sha256:' + 'd'.repeat(64),
          compilerSha256: 'e'.repeat(64),
          recipeSha256: 'f'.repeat(64),
        },
        context: {
          type: 'boot_context',
          scope: 'sandbox',
          sourceCount: 1,
          tokenCount: 1,
          tokenBudget: 12000,
          sources: [],
          included: [],
          trimmed: [],
          fullMarkdown: 'FRESH ACCEPTED GUIDANCE',
        },
      });
    try {
      const enrolled = await openCodexChat(chatOptions('valid-lifecycle-state', true));
      // CodexConversation passes systemPrompt to thread/start developerInstructions.
      expect(mocks.conversationOptions?.systemPrompt).not.toContain('OLD TASK CHECKOUT GUIDANCE');
      expect(compile).not.toHaveBeenCalled();
      const prepare = mocks.conversationOptions?.prepareSystemPrompt as (
        signal: AbortSignal,
      ) => Promise<string>;
      const accepted = mocks.conversationOptions?.onApplicationContextAccepted as (
        command: string,
        thread: string,
        turn: string,
        context: string,
      ) => void;
      for (const turn of ['turn-one', 'turn-two']) {
        const context = await prepare(AbortSignal.timeout(5000));
        expect(context).toContain('FRESH ACCEPTED GUIDANCE');
        expect(context).not.toContain('OLD TASK CHECKOUT GUIDANCE');
        accepted(turn, 'thread', turn, context);
        expect(mocks.recordKnowledgeAdoption).toHaveBeenLastCalledWith(
          'valid-lifecycle-state',
          binding,
          turn,
          'thread',
          turn,
          expect.objectContaining({ sourceCommit: 'a'.repeat(40), sandboxId: 'restored-id' }),
        );
      }
      expect(adoption).toHaveBeenCalledTimes(2);
      enrolled.close();
      const profileAccepted = vi.fn();
      compile.mockClear();
      const profileContext = {
        source: 'packs' as const,
        compilerRevision: 'test',
        recipeHash: '1'.repeat(64),
        payloadHash: '2'.repeat(64),
        profileId: 'architect',
        revision: 1,
        profileHash: '3'.repeat(64),
        provenance: {
          packs: [{ id: 'architecture', revision: 1, hash: '4'.repeat(64) }],
          documents: [],
          omissions: [],
        },
        context: {
          type: 'boot_context' as const,
          source: 'contexgin' as const,
          sourceCount: 1,
          tokenCount: 8,
          tokenBudget: 1000,
          sources: [{ path: 'context/architecture.md', kind: 'reference' }],
          included: [],
          trimmed: [],
          fullMarkdown: 'PINNED PROFILE CONTEXT',
        },
      };
      const prepareProfile = vi.fn().mockResolvedValue(undefined);
      await expect(
        openCodexChat({
          ...chatOptions('valid-lifecycle-state', true),
          agentContext: profileContext,
          prepareAgentContext: prepareProfile,
          onAgentContextAccepted: profileAccepted,
        }),
      ).rejects.toThrow(/trusted native continuation barrier/);
      expect(prepareProfile).not.toHaveBeenCalled();
      expect(profileAccepted).not.toHaveBeenCalled();
      expect(compile).not.toHaveBeenCalled();
    } finally {
      enrollment.mockRestore();
      adoption.mockRestore();
    }
  } finally {
    ensure.mockRestore();
    provisional.mockRestore();
    compile.mockRestore();
    lifecycle.store.close();
    mocks.privateDirectory = '/tmp';
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('persists a fake provider profile proposal without saving a reusable profile', async () => {
  vi.clearAllMocks();
  const root = mkdtempSync(join(tmpdir(), 'mitzo-codex-profile-tool-'));
  mkdirSync(join(root, '.mitzo'));
  vi.stubEnv('REPO_PATH', root);
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  const base = options(new AbortController());
  base.session.sessionId = 'conversation';
  base.registry = {
    findBySessionId: () => ({ clientId: 'client', session: base.session }),
    get: () => base.session,
  } as never;
  const chat = await openCodexChat({
    ...base,
    conversationId: 'conversation',
    eventStore: {
      getRecentConversationText: () => [],
      getSession: () => ({ sessionId: 'conversation' }),
    } as never,
  });
  for (const name of ['AgentReadTasks', 'AgentProposeTask'])
    expect(
      (mocks.conversationOptions?.tools as Array<{ name: string }>).map((tool) => tool.name),
    ).not.toContain(name);
  const execute = mocks.conversationOptions?.executeTool as (
    name: string,
    input: unknown,
    signal: AbortSignal,
    context: { turnId: string; callId: string },
  ) => Promise<{ content: string; isError: boolean }>;
  const input = {
    suggestedProfileId: 'reviewer',
    definition: {
      name: 'Reviewer',
      role: 'reviewer',
      instructions: 'Review the change',
      expectedOutput: 'Findings',
      acceptanceCriteria: ['Cite evidence'],
      modelPolicyRole: 'reviewer',
    },
  };
  const result = await execute('SymposiumProposeProfile', input, new AbortController().signal, {
    turnId: 'turn-1',
    callId: 'call-1',
  });
  expect(result.isError).toBe(false);
  const proposalId = JSON.parse(result.content).proposalId;
  const dbPath = join(root, '.mitzo', 'events.db');
  const proposals = new SymposiumProfileProposalStore(dbPath);
  const profiles = new SymposiumProfileStore(dbPath);
  expect(proposals.listPending('user', 'conversation')[0]?.proposalId).toBe(proposalId);
  expect(profiles.list('user')).toEqual([]);
  proposals.close();
  profiles.close();
  chat.close();
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

it.each([
  [
    'Migration storage capacity insufficient: private path secret',
    'insufficient sandbox storage capacity',
  ],
  ['checkpoint: unsupported provider state: private-filename', 'source runtime or provider layout'],
  ['Retained migration target policy differs secret', 'observed sandbox policy'],
  ['checkpoint: sandbox writer is still open secret', 'verified idle boundary'],
])('publishes safe observable migration eligibility for %s', (diagnostic, reason) => {
  const message = publicCodexRuntimeError(new Error(diagnostic));
  expect(message).toContain(reason);
  expect(message).toContain('task files and provider thread are preserved');
  expect(message).not.toContain('secret');
  expect(message).not.toContain('private');
});

it('explains unavailable knowledge without exposing publication transport details', () => {
  expect(publicCodexRuntimeError(new KnowledgePublicationUnavailableError())).toBe(
    'Knowledge publication is unavailable. Check the knowledge publisher before retrying. No provider turn was started.',
  );
});

it('describes an active transport interruption without claiming a failed provider turn', () => {
  expect(
    publicCodexRuntimeError(new Error('Codex transport disconnected; recovery is available')),
  ).toBe(
    'The Codex connection was interrupted. The turn outcome is unknown; inspect saved work before continuing.',
  );
});

it('offers Keychain connection tools inside OpenShell alongside existing host capabilities', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'sandbox');
  try {
    const chat = await openCodexChat({
      ...options(new AbortController()),
      systemPrompt: 'base prompt',
    });
    const tools = mocks.conversationOptions?.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'ListConnections',
        'RequestConnectionAccess',
        'ConnectionRequest',
        'ConnectionWebSocket',
        'HomeAssistantDashboard',
        'GetConnectionGuide',
        'PrepareConnectionSetup',
        'GetConnectionSetup',
        'RequestWebAccess',
      ]),
    );
    chat.close();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('does not require Telos outcome capture for ordinary artifact contributors in OpenShell', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'sandbox');
  const chat = await openCodexChat({
    ...options(new AbortController()),
    systemPrompt: 'Selected artifact contributor instructions.',
    contributorGuidance: 'Contribute to the selected document.',
  });
  expect(mocks.conversationOptions?.systemPrompt).not.toContain(
    'Telos is the de facto persistent home',
  );
  expect(mocks.conversationOptions?.systemPrompt).not.toContain(
    'Use TelosCreateOutcome for durable Telos capture',
  );
  expect(mocks.conversationOptions?.systemPrompt).toContain('Current Mitzo mode');
  chat.close();
});

it('refuses cold repository resume without its artifact identity before ensuring a sandbox', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'mitzo-runtime:1');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', '/config/policy.yaml');
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/seed/mgmt');
  const ensure = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'ensure')
    .mockRejectedValue(new Error('must not ensure'));
  const base = options(new AbortController());
  try {
    await expect(
      openCodexChat({
        ...base,
        resume: true,
        conversationId: 'missing-repository-runtime',
        binding: {
          accountId: 'work',
          accountLabel: 'Work',
          provider: 'openai',
          model: 'test-model',
          profileRevision: '1',
        },
        profile: {
          accountId: 'work',
          accountLabel: 'Work',
          email: 'work@example.invalid',
          planType: 'api',
          model: 'test-model',
          sandboxProvider: 'openai-work',
        },
        repositoryWorkspace: {
          id: 'repository',
          repository: 'example/repo',
          baseBranch: 'main',
          baseOid: 'a'.repeat(40),
          featureBranch: 'mitzo/task',
          sandbox: true,
        },
      }),
    ).rejects.toThrow('Repository sandbox identity is unavailable');
    expect(ensure).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  } finally {
    ensure.mockRestore();
  }
});

it('rejects host Codex profile packs before startup or provider acceptance', async () => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  const { NativeHooks } = await import('../native-hooks.js');
  const startup = vi
    .spyOn(NativeHooks.prototype, 'run')
    .mockResolvedValue({ context: 'UNRELATED DEFAULT CONTEXT', forcePrompt: false });
  const accepted = vi.fn();
  const agentContext = {
    source: 'packs' as const,
    compilerRevision: 'fixture',
    recipeHash: 'a'.repeat(64),
    payloadHash: 'b'.repeat(64),
    profileId: 'architect',
    revision: 1,
    profileHash: 'c'.repeat(64),
    provenance: {
      packs: [{ id: 'architecture', revision: 1, hash: 'd'.repeat(64) }],
      documents: [],
      omissions: [],
    },
    context: {
      type: 'boot_context' as const,
      source: 'contexgin' as const,
      sourceCount: 1,
      tokenCount: 5,
      tokenBudget: 1000,
      sources: [{ path: 'architecture.md', kind: 'reference' }],
      included: [],
      trimmed: [],
      fullMarkdown: 'PINNED HOST PROFILE',
    },
  };
  try {
    await expect(
      openCodexChat({
        ...options(new AbortController()),
        systemPrompt: 'platform\nPINNED HOST PROFILE',
        agentContext,
        onAgentContextAccepted: accepted,
      }),
    ).rejects.toThrow(/trusted native continuation barrier/);
    expect(startup).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  } finally {
    startup.mockRestore();
  }
});
it.each(['new', 'resume', 'revoked', 'compiler failure'])(
  'admits sandbox recipes before provider initialization and preserves their immutable prompt: %s',
  async (phase) => {
    vi.clearAllMocks();
    mocks.initialize.mockResolvedValue(undefined);
    mocks.send.mockResolvedValue(undefined);
    vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
    vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'fixture');
    vi.stubEnv('MITZO_OPENSHELL_POLICY', '/fixture/policy');
    vi.stubEnv('MITZO_OPENSHELL_SEED', '/fixture/seed');
    const { contextDigest } = await import('../agent-context-compiler.js');
    const { resolveSandboxAgentContext, SANDBOX_AGENT_COMPILER_REVISION } =
      await import('../agent-context-sandbox.js');
    const recipe = {
      version: 1 as const,
      source: 'workspace' as const,
      files: ['design.md'],
      tokenBudget: 10000,
      required: [],
      excluded: [],
    };
    const definition = {
      role: 'agent',
      name: 'Bob',
      descriptor: 'The architect',
      instructions: 'Challenge assumptions.',
      expectedOutput: 'Design brief',
      acceptanceCriteria: [],
      modelPolicyRole: 'agent',
      contextRecipe: recipe,
    };
    const agentProfile = {
      profileId: 'bob',
      revision: 3,
      definition,
      contentHash: contextDigest(definition),
    } satisfies import('@mitzo/protocol').AgentLibraryVersion;
    const managed = {
      sandboxName: 'sandbox-one',
      sandboxId: 'physical-one',
      workdir: '/sandbox/workspaces/mgmt',
      appServerCommand: '/sandbox/run-mitzo-app-server' as const,
      cli: 'openshell',
      gateway: 'default',
      workspace: 'default',
      gatewayInsecure: false,
    };
    const scope = {
      sandboxId: managed.sandboxId,
      sandboxName: managed.sandboxName,
      workspaceRoot: managed.workdir,
      runtimeContractImageDigest: 'sha256:' + 'a'.repeat(64),
      compilerSha256: 'b'.repeat(64),
      entrypointSha256: 'c'.repeat(64),
      recipeSha256: 'd'.repeat(64),
      runtimeInputsSha256: 'e'.repeat(64),
    };
    const context = {
      type: 'boot_context' as const,
      source: 'contexgin' as const,
      sourceCount: 1,
      tokenCount: 1000,
      tokenBudget: 10000,
      sources: [{ path: 'design.md', kind: 'markdown' }],
      included: [],
      trimmed: [],
      fullMarkdown: 'REQUIRED ' + '完整内容 '.repeat(1200) + 'RECIPE END',
    };
    const ensure = vi.spyOn(OpenShellRuntimeManager.prototype, 'ensure').mockResolvedValue(managed);
    const verify = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'verifyAgentContextRuntime')
      .mockResolvedValue(scope);
    const compile = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'compileAgentContext')
      .mockResolvedValue({
        compilerRevision: SANDBOX_AGENT_COMPILER_REVISION,
        workspaceIdentity: contextDigest(managed.workdir),
        context,
      });
    const legacy = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'compileContext')
      .mockRejectedValue(Error('Recipe must not trigger legacy compilation'));
    const adoption = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'adoptKnowledge')
      .mockResolvedValue(undefined);
    const lifecycleSpies = [
      vi
        .spyOn(lifecycleController, 'restoreOpenShellLifecycleIfNeeded')
        .mockResolvedValue(undefined),
      vi
        .spyOn(lifecycleController, 'registerOpenShellLifecycleProvisional')
        .mockImplementation(() => {}),
      vi.spyOn(lifecycleController, 'registerOpenShellLifecycle').mockImplementation(() => {}),
      vi.spyOn(lifecycleController, 'markOpenShellLifecycleIdle').mockImplementation(() => {}),
    ];
    const controller = new AbortController();
    const base = options(controller);
    const persist = vi.fn();
    const agentAccepted = vi.fn();
    const authorize = vi.fn(() => {
      if (phase === 'revoked' && compile.mock.calls.length) throw Error('Operator revoked');
    });
    let saved: import('@mitzo/protocol').AgentContextSnapshot | undefined;
    if (phase === 'resume') {
      saved = await resolveSandboxAgentContext({
        profile: agentProfile,
        conversationId: 'recipe-chat',
        runtime: managed,
        manager: Object.create(OpenShellRuntimeManager.prototype),
        signal: controller.signal,
      });
      compile.mockClear();
    }
    if (phase === 'compiler failure')
      compile.mockRejectedValue(Error('Selected context file is unavailable'));
    const input = {
      ...base,
      conversationId: 'recipe-chat',
      resume: phase === 'resume',
      binding: {
        accountId: 'work',
        accountLabel: 'Work',
        provider: 'openai',
        model: 'luna-fixture',
        profileRevision: '1',
      },
      profile: {
        accountId: 'work',
        accountLabel: 'Work',
        planType: 'api',
        email: 'fixture@example.com',
        model: 'luna-fixture',
        sandboxProvider: 'openai-work',
      },
      agentProfile,
      assertAgentContextAuthorization: authorize,
      onAgentContextAccepted: agentAccepted,
      eventStore: {
        ...base.eventStore,
        getSession: () => (saved ? { agentContext: saved } : undefined),
        upsertSession: persist,
      },
      messageId: 'message',
      prompt: 'Design this',
      systemPrompt: 'PLATFORM GUIDANCE',
      env: {},
    } as unknown as Parameters<typeof openCodexChat>[0];
    try {
      if (phase === 'revoked' || phase === 'compiler failure') {
        await expect(openCodexChat(input)).rejects.toThrow();
        expect(mocks.initialize).not.toHaveBeenCalled();
        expect(mocks.send).not.toHaveBeenCalled();
        expect(persist).not.toHaveBeenCalled();
        expect(compile).toHaveBeenCalledOnce();
      } else {
        const chat = await openCodexChat(input);
        expect(compile).toHaveBeenCalledTimes(phase === 'resume' ? 0 : 1);
        expect(legacy).not.toHaveBeenCalled();
        expect(persist).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: 'recipe-chat',
            agentContext: expect.objectContaining({
              sandbox: expect.objectContaining({ sandboxId: 'physical-one' }),
            }),
          }),
        );
        const developerInstructions = mocks.conversationOptions?.systemPrompt as string;
        expect(developerInstructions).not.toContain(context.fullMarkdown);
        expect(developerInstructions).toContain('PLATFORM GUIDANCE');
        expect(mocks.recordAgentContextAdoption).not.toHaveBeenCalled();
        expect(agentAccepted).not.toHaveBeenCalled();
        expect(mocks.conversationOptions?.disableProjectDocuments).toBe(false);
        const prepare = mocks.conversationOptions?.prepareSystemPrompt as (
          signal: AbortSignal,
        ) => Promise<string | undefined>;
        const applicationContext = await prepare(controller.signal);
        expect(applicationContext).toContain(context.fullMarkdown);
        const acknowledge = mocks.conversationOptions?.onApplicationContextAccepted as (
          command: string,
          thread: string,
          turn: string,
          context: string,
        ) => void;
        acknowledge('message', 'thread-one', 'turn-one', applicationContext!);
        expect(mocks.recordAgentContextAdoption).toHaveBeenCalledWith(
          'recipe-chat',
          input.binding,
          'message',
          'thread-one',
          'turn-one',
          expect.objectContaining({ profileId: 'bob', payloadHash: contextDigest(context) }),
        );
        expect(agentAccepted).toHaveBeenCalledWith(
          'message',
          'thread-one',
          'turn-one',
          createHash('sha256')
            .update(
              JSON.stringify({ developerInstructions, additionalContext: applicationContext }),
            )
            .digest('hex'),
        );
        verify.mockResolvedValueOnce({ ...scope, sandboxId: 'physical-other' });
        await expect(prepare(controller.signal)).rejects.toThrow(/runtime changed/);
        chat.close();
      }
    } finally {
      ensure.mockRestore();
      verify.mockRestore();
      compile.mockRestore();
      legacy.mockRestore();
      adoption.mockRestore();
      lifecycleSpies.forEach((spy) => spy.mockRestore());
    }
  },
);

it.each(['supplied', 'retained', 'supplied-host', 'retained-host', 'recipe'] as const)(
  'refuses native pack admission before runtime setup: %s',
  async (location) => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
    const agentContext = {
      source: 'packs' as const,
      compilerRevision: 'fixture',
      recipeHash: 'a'.repeat(64),
      payloadHash: 'b'.repeat(64),
      profileId: 'architect',
      revision: 1,
      profileHash: 'c'.repeat(64),
      provenance: {
        packs: [{ id: 'architecture', revision: 1, hash: 'd'.repeat(64) }],
        documents: [],
        omissions: [],
      },
      sandbox: {
        sandboxId: 'physical-one',
        sandboxName: 'sandbox-one',
        workspaceRoot: '/sandbox/workspaces/mgmt',
        runtimeContractImageDigest: 'sha256:' + 'a'.repeat(64),
        compilerSha256: 'b'.repeat(64),
        entrypointSha256: 'c'.repeat(64),
        recipeSha256: 'd'.repeat(64),
        runtimeInputsSha256: 'e'.repeat(64),
        effectiveRecipeHash: 'f'.repeat(64),
      },
      context: {
        type: 'boot_context' as const,
        source: 'contexgin' as const,
        sourceCount: 1,
        tokenCount: 5,
        tokenBudget: 1000,
        sources: [{ path: 'architecture.md', kind: 'reference' }],
        included: [],
        trimmed: [],
        fullMarkdown: 'PINNED PACK CONTEXT',
      },
    };
    const base = options(new AbortController());
    const hostContext = { ...agentContext, sandbox: undefined };
    const selectedContext = location.endsWith('host') ? hostContext : agentContext;
    const { OpenShellRuntimeManager } = await import('../openshell-runtime.js');
    const ensure = vi.spyOn(OpenShellRuntimeManager.prototype, 'ensure');
    if (location.startsWith('retained')) {
      // Inject intentionally malformed retained metadata through the session lookup boundary.
      const retainedSession = { agentContext: selectedContext } as unknown as ReturnType<
        typeof base.eventStore.getSession
      >;
      vi.spyOn(base.eventStore, 'getSession').mockReturnValue(retainedSession);
    }
    await expect(
      openCodexChat({
        ...base,
        ...(location.startsWith('supplied')
          ? { agentContext: selectedContext }
          : location === 'recipe'
            ? {
                agentProfile: {
                  profileId: 'architect',
                  revision: 1,
                  contentHash: 'c'.repeat(64),
                  definition: {
                    name: 'Architect',
                    role: 'agent',
                    instructions: 'Review.',
                    expectedOutput: 'Review',
                    acceptanceCriteria: [],
                    modelPolicyRole: 'agent',
                    contextRecipe: {
                      version: 2,
                      source: 'packs',
                      tokenBudget: 1000,
                      packs: [{ id: 'architecture', revision: 1, hash: 'd'.repeat(64) }],
                    },
                  },
                },
              }
            : { resume: true }),
      }),
    ).rejects.toThrow(/trusted native continuation barrier/);
    expect(ensure).not.toHaveBeenCalled();
    ensure.mockRestore();
    expect(mocks.reserveStartup).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.recordAgentContextAdoption).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  },
);

it.each(['recipe', 'supplied', 'retained'] as const)(
  'rechecks pack origin after account reservation await before bound runtime setup (%s)',
  async (location) => {
    vi.clearAllMocks();
    mocks.conversationOptions = undefined;
    const base = options(new AbortController());
    Object.assign(base, { conversationId: 'mutation', binding: { accountId: 'work' } });
    const mutate = () => {
      if (location === 'recipe')
        base.agentProfile = { definition: { contextRecipe: { source: 'packs' } } } as never;
      if (location === 'supplied') base.agentContext = { source: 'packs' } as never;
      if (location === 'retained')
        vi.spyOn(base.eventStore, 'getSession').mockReturnValue({
          agentContext: { source: 'packs' },
        } as never);
    };
    vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
    vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'fixture');
    vi.stubEnv('MITZO_OPENSHELL_POLICY', '/fixture/policy');
    vi.stubEnv('MITZO_OPENSHELL_SEED', '/fixture/seed');
    const ensure = vi.spyOn(OpenShellRuntimeManager.prototype, 'ensure');
    setConnectionsRuntime({
      service: {
        withAccountRuntimes: async (
          _account: string,
          callback: (connections: never[]) => Promise<unknown>,
        ) => {
          await Promise.resolve();
          mutate();
          return callback([]);
        },
        onDemandForAccount: () => [],
      },
    } as never);
    try {
      await expect(openCodexChat(base)).rejects.toThrow(/trusted native continuation barrier/);
      expect(ensure).not.toHaveBeenCalled();
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(mocks.conversationOptions).toBeUndefined();
      expect(mocks.initialize).not.toHaveBeenCalled();
      expect(mocks.recordAgentContextAdoption).not.toHaveBeenCalled();
    } finally {
      ensure.mockRestore();
      setConnectionsRuntime(null);
    }
  },
);

it.each(['recipe', 'supplied', 'retained'] as const)(
  'rechecks pack origin after async MCP setup before native constructor (%s)',
  async (location) => {
    vi.clearAllMocks();
    mocks.conversationOptions = undefined;
    const base = options(new AbortController());
    mocks.connect.mockImplementationOnce(async () => {
      await Promise.resolve();
      if (location === 'recipe')
        base.agentProfile = { definition: { contextRecipe: { source: 'packs' } } } as never;
      if (location === 'supplied') base.agentContext = { source: 'packs' } as never;
      if (location === 'retained')
        vi.spyOn(base.eventStore, 'getSession').mockReturnValue({
          agentContext: { source: 'packs' },
        } as never);
      return { definitions: [], close: mocks.mcpClose };
    });
    await expect(openCodexChat(base)).rejects.toThrow(/trusted native continuation barrier/);
    expect(mocks.conversationOptions).toBeUndefined();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.recordAgentContextAdoption).not.toHaveBeenCalled();
    expect(mocks.mcpClose).toHaveBeenCalled();
  },
);

it('rechecks owned command authority immediately before native enqueue and provider dispatch', async () => {
  vi.clearAllMocks();
  mocks.initialize.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue({
    definitions: [],
    close: mocks.mcpClose,
    displayName: (name: string) => name,
  });
  const f = ownedLocalOptions();
  let current = true;
  const guard = vi.fn(() => {
    if (!current) throw Error('Delegated scope revoked');
  });
  const enqueue = vi.spyOn(f.ownedLocal, 'assertBeforeEnqueue');
  const dispatch = vi.spyOn(f.ownedLocal, 'assertBeforeDispatch');
  try {
    const query = await openCodexChat({ ...f.opts, assertAgentContextAuthorization: guard });
    const callbacks = mocks.conversationOptions!;
    current = false;
    expect(() => (callbacks.beforeEnqueue as (input: unknown) => void)({})).toThrow(
      'scope revoked',
    );
    expect(() => (callbacks.onProviderDispatch as (id: string) => void)('owned-command')).toThrow(
      'scope revoked',
    );
    expect(enqueue).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(callbacks.environmentContinuationOwner).toBeUndefined();
    current = true;
    query.close();
  } finally {
    f.eventStore.close();
  }
});

it('uses the already verified owned client locally regardless of global OpenShell settings', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'invalid-global-runtime');
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'legacy-global');
  mocks.initialize.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue({
    definitions: [],
    close: mocks.mcpClose,
    displayName: (name: string) => name,
  });
  const hostLaunch = vi.spyOn(CodexAppServerClient, 'launch'),
    shellLaunch = vi.spyOn(CodexAppServerClient, 'launchOpenShell');
  const f = ownedLocalOptions();
  try {
    const chat = await openCodexChat(f.opts);
    expect(hostLaunch).not.toHaveBeenCalled();
    expect(shellLaunch).not.toHaveBeenCalled();
    expect(mocks.reserveStartup).not.toHaveBeenCalled();
    const config = mocks.conversationOptions!;
    expect(config.systemPrompt).toContain('<mitzo_capabilities>');
    expect(config.systemPrompt).toContain('clickable mockup');
    expect(config.enableCapacityRecovery).toBe(false);
    const callbacks = {
      onNotification: vi.fn(),
      onRequest: vi.fn(async () => ({})),
      onClose: vi.fn(),
    };
    expect(
      (config.createClient as (transportCallbacks: typeof callbacks) => unknown)(callbacks),
    ).toBe(f.lease.client);
    await (config.verifyBinding as () => Promise<unknown>)();
    expect(f.lease.assertCurrent).toHaveBeenCalled();
    (config.beforeEnqueue as (input: unknown) => void)({
      id: 'owned-command',
      prompt: 'Frozen prompt',
      intent: 'Original intent',
      model: 'owned-model',
      reasoningEffort: null,
    });
    (config.onProviderDispatch as (id: string) => void)('owned-command');
    const source = {
      commandId: 'owned-command',
      messageId: 'visible-owned-reply',
      providerThreadId: 'private-owned-thread',
      providerTurnId: 'private-owned-turn',
    };
    (config.onProviderMessageSource as (source: unknown) => void)(source);
    expect(
      f.eventStore.getOrdinaryReplySourceEvents('owned-session', 'visible-owned-reply'),
    ).toEqual([{ version: 1, ...source }]);
    expect(() => (config.onProviderDispatch as (id: string) => void)('owned-command')).toThrow(
      'Owned local Codex chat unavailable',
    );
    await expect(chat.setPermissionMode('auto')).rejects.toThrow(
      'Owned local Codex chat unavailable',
    );
    chat.close();
    expect(f.lease.close).toHaveBeenCalled();
  } finally {
    hostLaunch.mockRestore();
    shellLaunch.mockRestore();
    f.eventStore.close();
  }
});
it('refuses owned local injection in a custodian controller even when dedicated OpenShell is configured', async () => {
  vi.clearAllMocks();
  mocks.initialize.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue({
    definitions: [],
    close: mocks.mcpClose,
    displayName: (name: string) => name,
  });
  mocks.custodianController = true;
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'fixture-reviewed-runtime');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', '/fixture/policy.yaml');
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/fixture/seed');
  const f = ownedLocalOptions();
  try {
    await expect(openCodexChat(f.opts)).rejects.toThrow('Owned local Codex chat unavailable');
    expect(f.lease.assertCurrent).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.reserveStartup).not.toHaveBeenCalled();
  } finally {
    f.eventStore.close();
  }
});
it.each(['prompt', 'systemPrompt'] as const)(
  'rejects an owned initial %s mismatch before hooks, MCP or provider effects',
  async (field) => {
    vi.clearAllMocks();
    const f = ownedLocalOptions();
    try {
      f.opts[field] = 'Changed input';
      await expect(openCodexChat(f.opts)).rejects.toThrow('Owned local Codex chat unavailable');
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(mocks.initialize).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    } finally {
      f.eventStore.close();
    }
  },
);

it('keeps the admitted developer input fixed while asynchronous owned verification waits', async () => {
  vi.clearAllMocks();
  mocks.initialize.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue({
    definitions: [],
    close: mocks.mcpClose,
    displayName: (name: string) => name,
  });
  const f = ownedLocalOptions();
  let release!: () => void;
  f.lease.assertCurrent = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  try {
    const opening = openCodexChat(f.opts);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    f.opts.systemPrompt = 'Changed unadmitted developer instructions';
    release();
    const chat = await opening;
    expect(mocks.conversationOptions?.systemPrompt).not.toContain(
      'Changed unadmitted developer instructions',
    );
    chat.close();
  } finally {
    f.eventStore.close();
  }
});

it('qualifies owned native, MCP, profile and publishing tools and rejects other helpers before effects', async () => {
  vi.clearAllMocks();
  mocks.initialize.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  const mcpExecute = vi.fn(async () => ({ content: 'MCP result', isError: false }));
  const mcpDefinition = {
    name: 'mitzo_mcp_fixture',
    description: 'Fixture MCP',
    input_schema: { type: 'object' },
  };
  mocks.connect.mockResolvedValue({
    definitions: [mcpDefinition],
    execute: mcpExecute,
    close: mocks.mcpClose,
    displayName: (name: string) => name,
  });
  const credentialModule = await import('../session-credential-tools.js');
  const { profileToolDefinitions } = await import('../session-profile-tools.js');
  const connectionExecute = vi.fn(async () => ({
    content: 'Unexpected helper effect',
    isError: false,
  }));
  const connectionFactory = vi
    .spyOn(credentialModule, 'sessionCredentialTools')
    .mockReturnValue({ definitions: profileToolDefinitions, execute: connectionExecute });
  const native = await import('../native-tool-executor.js');
  const nativeExecute = vi.fn(async () => ({ content: 'Native result', is_error: false }));
  const nativeFactory = vi
    .spyOn(native, 'createNativeToolExecutor')
    .mockReturnValue(nativeExecute as never);
  const f = ownedLocalOptions();
  f.opts.session.accountBinding = f.opts.binding;
  f.opts.registry = {
    ...f.opts.registry,
    findBySessionId: () => ({ clientId: 'owned-client', session: f.opts.session }),
    get: () => f.opts.session,
  } as never;
  let chat: Awaited<ReturnType<typeof openCodexChat>> | undefined;
  try {
    chat = await openCodexChat(f.opts);
    const config = mocks.conversationOptions!;
    expect(config.systemPrompt).toContain('RequestGithubPublish');
    expect((config.tools as Array<{ name: string }>).map((tool) => tool.name).sort()).toEqual(
      [
        ...native.nativeToolDefinitions.map((tool) => tool.name),
        ...profileToolDefinitions.map((tool) => tool.name),
        'AgentReadTasks',
        'AgentProposeTask',
        'RequestGithubPublish',
        mcpDefinition.name,
      ].sort(),
    );
    const execute = config.executeTool as (
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
      context: { turnId: string; callId: string },
    ) => Promise<unknown>;
    vi.mocked(f.lease.assertCurrent).mockClear();
    for (const name of [
      'ListConnections',
      'PrepareRepositoryChat',
      'RequestWebAccess',
      'Capability_fixture',
      'UnknownAlias',
    ])
      await expect(
        execute(name, {}, new AbortController().signal, { turnId: 'turn', callId: name }),
      ).rejects.toThrow('Tool unavailable for owned local Codex chat');
    expect(f.lease.assertCurrent).not.toHaveBeenCalled();
    await expect(
      execute('RequestGithubPublish', {}, new AbortController().signal, {
        turnId: 'turn',
        callId: 'publish',
      }),
    ).resolves.toMatchObject({ content: expect.stringContaining('repositoryPath'), isError: true });
    expect(f.lease.assertCurrent).toHaveBeenCalled();
    const connection = {
      id: 'owned-publisher',
      revision: 1,
      templateId: 'github-readonly',
      status: 'active',
      desiredAccountIds: [f.opts.binding.accountId],
      publicConfig: { allowedRepositories: ['example/repo'] },
    };
    const invoke = vi.fn(async () => ({
      id: 'published',
      status: 'succeeded',
      result: { url: 'https://github.com/example/repo/pull/1' },
    }));
    const resolve = vi.fn(async () => 'example/repo');
    setConnectionsRuntime({
      store: { list: () => [connection], get: () => connection },
      verifyGithubPublishingIdentity: vi.fn(async () => true),
      resolveGithubPublishingRepository: resolve,
      capabilityStore: {
        getGrant: () => ({ status: 'active', accountIds: [f.opts.binding.accountId] }),
        hasGithubRepositoryAccess: () => true,
      },
      capabilities: { invoke, recoverPendingForConversation: vi.fn(async () => []) },
    } as unknown as import('../connections-runtime.js').ConnectionsRuntime);
    await expect(
      execute(
        'RequestGithubPublish',
        {
          repositoryPath: f.opts.session.cwd,
          baseBranch: 'main',
          title: 'Owned work',
          body: 'Review',
          draft: true,
        },
        new AbortController().signal,
        { turnId: 'turn', callId: 'real-publication' },
      ),
    ).resolves.toMatchObject({ isError: false });
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: 'host', workspace: realpathSync(f.opts.session.cwd!) }),
      f.opts.session.cwd,
      'main',
      expect.any(AbortSignal),
    );
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: f.opts.binding.accountId }),
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
    );
    setConnectionsRuntime(null);
    expect(connectionExecute).not.toHaveBeenCalled();
    expect(mocks.permissionHandler).not.toHaveBeenCalled();
    expect(nativeExecute).not.toHaveBeenCalled();
    expect(mcpExecute).not.toHaveBeenCalled();
    await expect(
      execute('Read', { file_path: 'task.txt' }, new AbortController().signal, {
        turnId: 'turn',
        callId: 'native',
      }),
    ).resolves.toEqual({ content: 'Native result', isError: false });
    await expect(
      execute(mcpDefinition.name, {}, new AbortController().signal, {
        turnId: 'turn',
        callId: 'mcp',
      }),
    ).resolves.toEqual({ content: 'MCP result', isError: false });
    expect(connectionExecute).not.toHaveBeenCalled();
    expect(nativeExecute).toHaveBeenCalledOnce();
    expect(mcpExecute).toHaveBeenCalledOnce();
  } finally {
    chat?.close();
    setConnectionsRuntime(null);
    f.eventStore.close();
    nativeFactory.mockRestore();
    connectionFactory.mockRestore();
  }
});

it('ignores trusted project command hooks and SessionStart context for the owned frozen prompt', async () => {
  vi.clearAllMocks();
  mocks.initialize.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue({
    definitions: [],
    close: mocks.mcpClose,
    displayName: (name: string) => name,
  });
  vi.stubEnv('MITZO_TRUST_PROJECT_HOOKS', '1');
  const cwd = mkdtempSync(join(tmpdir(), 'mitzo-owned-hooks-')),
    marker = join(cwd, 'hook-executed');
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(
    join(cwd, '.claude/settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `/usr/bin/touch '${marker}'; printf '{"additionalContext":"UNADMITTED PROJECT CONTEXT"}'`,
              },
            ],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: `/usr/bin/touch '${marker}'` }] }],
      },
    }),
  );
  const f = ownedLocalOptions(cwd);
  let chat: Awaited<ReturnType<typeof openCodexChat>> | undefined;
  try {
    chat = await openCodexChat(f.opts);
    expect(existsSync(marker)).toBe(false);
    expect(mocks.conversationOptions?.systemPrompt).not.toContain('UNADMITTED PROJECT CONTEXT');
    expect(mocks.conversationOptions?.systemPrompt).not.toContain('ListConnections');
    const beforeComplete = mocks.conversationOptions?.beforeComplete as (
      signal: AbortSignal,
    ) => Promise<void>;
    await beforeComplete(new AbortController().signal);
    expect(existsSync(marker)).toBe(false);
  } finally {
    chat?.close();
    f.eventStore.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it('keeps owned native web search disabled despite a live runtime preference and refuses grant edits', async () => {
  vi.clearAllMocks();
  mocks.initialize.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue({
    definitions: [],
    close: mocks.mcpClose,
    displayName: (name: string) => name,
  });
  const f = ownedLocalOptions(),
    root = mkdtempSync(join(tmpdir(), 'mitzo-owned-web-ceiling-'));
  const { CodexConversation } = await vi.importActual<typeof import('../codex-conversation.js')>(
    '../codex-conversation.js',
  );
  const { CodexConversationStore } = await vi.importActual<
    typeof import('../codex-conversation-store.js')
  >('../codex-conversation-store.js');
  const store = new CodexConversationStore(join(root, 'private.db'));
  let chat: Awaited<ReturnType<typeof openCodexChat>> | undefined;
  let realConversation: InstanceType<typeof CodexConversation> | undefined;
  try {
    chat = await openCodexChat(f.opts);
    const config = mocks.conversationOptions!;
    expect(config.webSearchDeploymentRevision).toBeUndefined();
    const setWebSearchGrant = chat.setWebSearchGrant;
    expect(setWebSearchGrant).toBeTypeOf('function');
    expect(() => setWebSearchGrant!(0, 'allowed')).toThrow('Owned local Codex chat unavailable');
    expect(mocks.setWebSearchGrant).not.toHaveBeenCalled();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    vi.mocked(f.lease.client.request).mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === 'config/read') return { config: { web_search: 'live' } };
      if (method === 'thread/start')
        return {
          thread: { id: 'owned-native-thread' },
          model: 'owned-model',
          modelProvider: 'openai',
        };
      return {};
    });
    realConversation = new CodexConversation({
      ...config,
      store,
      // This second, real owner has its own queue; the captured adapter callback
      // refers to the mocked conversation used to obtain these route options.
      onQueueChange: () => {},
      onClosed: () => {},
    } as never);
    await realConversation.initialize();
    expect(requests.find((request) => request.method === 'thread/start')?.params).toMatchObject({
      config: { web_search: 'disabled' },
    });
  } finally {
    realConversation?.close();
    chat?.close();
    store.close();
    f.eventStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function ownedOpenShellAdapterFixture(resume = false) {
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-owned-openshell-adapter-'));
  const previousDirectory = mocks.privateDirectory;
  mocks.privateDirectory = directory;
  const policy = join(directory, 'policy.yaml');
  writeFileSync(policy, 'reviewed: fixture\n');
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  const config = {
    cli: '/offline/selected-openshell',
    image: 'selected-image',
    policy,
    seed: '/offline/seed',
    serviceProviders: [],
    grantableServiceProviders: [],
    workspace: 'selected-workspace',
    gateway: 'selected-gateway',
    gatewayInsecure: false,
    createDetached: true,
    sandboxIdLength: 24,
    workdir: '/sandbox/workspaces/task',
    webSearch: 'disabled' as const,
  };
  const physical = {
    sandboxName: 'selected-sandbox',
    sandboxId: 'selected-resource',
    cli: config.cli,
    workspace: config.workspace,
    gateway: config.gateway,
    gatewayInsecure: false,
    workdir: config.workdir,
    appServerCommand: '/sandbox/run-mitzo-app-server' as const,
  };
  const binding = {
    accountId: 'selected-api',
    accountLabel: 'Selected',
    provider: 'openai',
    profileRevision: 'profile',
    model: 'original-model',
  };
  const lifecycle = lifecycleController.initializeOpenShellLifecycle(config, {
    registry: { findBySessionId: () => undefined, entries: function* () {} },
    eventStore: { getSession: () => ({}) },
    taskStore: { getTree: () => [], getTelosExecutionBinding: () => null },
    queue: () => ({ queued: 0, running: 0, recovery: false }),
  })!;
  if (resume)
    lifecycleController.registerOpenShellLifecycle(
      'bound-openshell',
      physical,
      binding as Parameters<typeof lifecycleController.registerOpenShellLifecycle>[2],
      { kind: 'api', provider: 'selected-provider', model: binding.model },
      'thread',
    );
  return {
    cleanup: () => {
      lifecycle.store.close();
      mocks.privateDirectory = previousDirectory;
      rmSync(directory, { recursive: true, force: true });
    },
    config,
    physical,
    binding,
    opts: {
      ...options(new AbortController()),
      conversationId: 'bound-openshell',
      messageId: 'new-command',
      binding,
      profile: {
        accountId: binding.accountId,
        accountLabel: 'Selected',
        email: 'offline@invalid',
        planType: 'api',
        sandboxProvider: 'selected-provider',
        model: 'next-model',
      },
      session: { ...options(new AbortController()).session, cwd: config.workdir, mode: 'agent' },
      prompt: 'Next command',
      systemPrompt: 'Pinned instructions',
      model: 'next-model',
    } as unknown as Parameters<typeof openCodexChat>[0],
  };
}
it('consumes frozen owned OpenShell configuration and executes guarded runtime admission without implicit migration', async () => {
  const { OwnedOpenShellCodexChatAdmission } =
    await import('../owned-openshell-codex-chat-admission.js');
  vi.clearAllMocks();
  const f = ownedOpenShellAdapterFixture();
  const owner = Object.assign(Object.create(OwnedOpenShellCodexChatAdmission.prototype), {
    assertOptions: vi.fn(),
    assertCurrent: vi.fn(async () => {}),
    assertCurrentSync: vi.fn(),
    configuration: () => f.config,
    adoptPhysicalRuntime: vi.fn(),
    assertBeforeEnqueue: vi.fn(),
    assertBeforeDispatch: vi.fn(),
    assertModelSelection: vi.fn(),
    persistNativeCustody: vi.fn(),
    canClaimCommand: vi.fn(() => false),
  });
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '0');
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'unselected-legacy');
  mocks.connect.mockResolvedValue({
    definitions: [],
    displayName: (name: string) => name,
    call: vi.fn(),
    close: mocks.mcpClose,
  });
  mocks.initialize.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  mocks.permissionHandler.mockReturnValue(vi.fn());
  const { CodexConversationStore } = await import('../codex-conversation-store.js');
  const retained = vi
    .spyOn(CodexConversationStore.prototype, 'readArtifactRuntime')
    .mockReturnValue({
      runtime: f.physical,
      route: { kind: 'api', provider: 'selected-provider', model: 'original-model' },
    });
  const ensure = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'ensure')
    .mockResolvedValue(f.physical);
  const verify = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'verifyKnowledgeRuntime')
    .mockResolvedValue({});
  const compile = vi.spyOn(OpenShellRuntimeManager.prototype, 'compileContext').mockResolvedValue({
    type: 'boot_context',
    scope: 'sandbox',
    sourceCount: 0,
    tokenCount: 0,
    tokenBudget: 12000,
    sources: [],
    included: [],
    trimmed: [],
    fullMarkdown: '',
  });
  const query = await openCodexChat({ ...f.opts, ownedOpenShell: owner });
  try {
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalled();
    const captured = mocks.conversationOptions!;
    expect(captured.systemPrompt).toContain('<mitzo_capabilities>');
    expect(captured.systemPrompt).toContain('clickable mockup');
    expect((captured.tools as Array<{ name: string }>).map(({ name }) => name)).toEqual(
      expect.arrayContaining(['AgentReadTasks', 'AgentProposeTask']),
    );
    expect(captured.enableCapacityRecovery).toBe(false);
    const prepare = captured.prepareAgentContext as (signal: AbortSignal) => Promise<void>;
    vi.mocked(owner.assertCurrent).mockClear();
    await prepare(new AbortController().signal);
    expect(owner.assertCurrent).toHaveBeenCalledTimes(2);
    const reconnect = captured.reconnectGuard as <T>(operation: () => Promise<T>) => Promise<T>;
    const operation = vi.fn(async () => 'exact-operation-result');
    await expect(reconnect(operation)).resolves.toBe('exact-operation-result');
    expect(operation).toHaveBeenCalledTimes(1);
    const beforeRuntime = captured.beforeRuntimeAdmission as (
      operation: () => Promise<void>,
    ) => Promise<boolean>;
    await expect(beforeRuntime(async () => {})).resolves.toBe(false);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls.length).toBeGreaterThan(1);
    expect((captured.canClaimCommand as (id: string) => boolean)('future')).toBe(false);
  } finally {
    query.close();
    retained.mockRestore();
    ensure.mockRestore();
    verify.mockRestore();
    compile.mockRestore();
    f.cleanup();
  }
});
it('cold owned OpenShell reuses the original physical mapping while a new turn selects another model', async () => {
  const { OwnedOpenShellCodexChatAdmission } =
    await import('../owned-openshell-codex-chat-admission.js');
  const { CodexConversationStore } = await import('../codex-conversation-store.js');
  vi.clearAllMocks();
  const f = ownedOpenShellAdapterFixture(true);
  const owner = Object.assign(Object.create(OwnedOpenShellCodexChatAdmission.prototype), {
    assertOptions: vi.fn(),
    assertCurrent: vi.fn(async () => {}),
    assertCurrentSync: vi.fn(),
    configuration: () => f.config,
    adoptPhysicalRuntime: vi.fn(),
    assertBeforeEnqueue: vi.fn(),
    assertBeforeDispatch: vi.fn(),
    assertModelSelection: vi.fn(),
    persistNativeCustody: vi.fn(),
    canClaimCommand: vi.fn(() => true),
  });
  mocks.connect.mockResolvedValue({
    definitions: [],
    displayName: (name: string) => name,
    call: vi.fn(),
    close: mocks.mcpClose,
  });
  mocks.initialize.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  mocks.permissionHandler.mockReturnValue(vi.fn());
  const retained = vi
    .spyOn(CodexConversationStore.prototype, 'readArtifactRuntime')
    .mockReturnValue({
      runtime: f.physical,
      route: { kind: 'api', provider: 'selected-provider', model: 'original-model' },
    });
  const ensure = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'ensure')
    .mockRejectedValue(Error('No resource creation during cold resume'));
  const verify = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'verifyKnowledgeRuntime')
    .mockResolvedValue({});
  const compile = vi.spyOn(OpenShellRuntimeManager.prototype, 'compileContext').mockResolvedValue({
    type: 'boot_context',
    scope: 'sandbox',
    sourceCount: 0,
    tokenCount: 0,
    tokenBudget: 12000,
    sources: [],
    included: [],
    trimmed: [],
    fullMarkdown: '',
  });
  const query = await openCodexChat({ ...f.opts, resume: true, ownedOpenShell: owner });
  try {
    expect(ensure).not.toHaveBeenCalled();
    expect(mocks.conversationOptions).toMatchObject({
      storedBinding: f.binding,
      runtimeCwd: f.config.workdir,
    });
    expect(mocks.send).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'next-model' }));
    expect(mocks.setArtifactRuntime).toHaveBeenLastCalledWith('bound-openshell', f.binding, {
      runtime: expect.objectContaining(f.physical),
      route: { kind: 'api', provider: 'selected-provider', model: 'original-model' },
    });
    expect(owner.adoptPhysicalRuntime).toHaveBeenLastCalledWith({
      runtime: f.physical,
      route: { kind: 'api', provider: 'selected-provider', model: 'original-model' },
    });
  } finally {
    query.close();
    retained.mockRestore();
    ensure.mockRestore();
    verify.mockRestore();
    compile.mockRestore();
    f.cleanup();
  }
});

it.each([{ tools: [] }, { tools: [{ id: 'mitzo:Read', version: 1 }] }])(
  'refuses a selected-tool profile before direct Codex startup: %j',
  async ({ tools }) => {
    await expect(
      openCodexChat({
        ...options(new AbortController()),
        agentProfile: { definition: { tools } } as never,
      }),
    ).rejects.toThrow('tool selection is not supported');
  },
);

it('carries the published selected surface and instructions through the owned Local Codex adapter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owned-selected-codex-'));
  const definition = {
    name: 'Owned selected agent',
    role: 'agent',
    instructions: 'Use the published instructions.',
    expectedOutput: 'Evidence',
    acceptanceCriteria: ['Only selected effects'],
    modelPolicyRole: 'agent',
    tools: [{ id: 'mitzo:Read', version: 1 }],
  };
  const profile = {
    profileId: 'owned-agent',
    revision: 1,
    definition,
    contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
  };
  const f = ownedLocalOptions(root, profile);
  const { SessionRegistry } = await import('@mitzo/harness');
  const registry = new SessionRegistry();
  registry.register('owned-client', {
    ...f.opts.session,
    sessionId: 'owned-session',
    sessionAllowList: new Set<string>(),
    transport: { send: () => {}, isOpen: () => true },
  });
  f.opts.registry = registry;
  f.opts.session = registry.get('owned-client')!;
  mocks.connect.mockResolvedValue({
    definitions: [],
    displayName: (name: string) => name,
    close: mocks.mcpClose,
  });
  mocks.permissionHandler.mockImplementation(async (_name, input) => ({
    behavior: 'allow',
    updatedInput: input,
  }));
  mocks.initialize.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  writeFileSync(join(root, 'selected.txt'), 'Owned selected result');
  const query = await openCodexChat(f.opts);
  try {
    expect(mocks.conversationOptions!.systemPrompt).toContain('Use the published instructions.');
    expect(
      (mocks.conversationOptions!.tools as { name: string }[]).map((tool) => tool.name),
    ).toEqual(['AskUserQuestion', 'Read']);
    const execute = mocks.conversationOptions!.executeTool as (
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
      context: { turnId: string; callId: string },
    ) => Promise<{ content: string; isError: boolean }>;
    expect(
      await execute(
        'Read',
        { file_path: join(root, 'selected.txt') },
        new AbortController().signal,
        { turnId: 'turn', callId: 'call' },
      ),
    ).toMatchObject({ content: expect.stringContaining('Owned selected result'), isError: false });
    await expect(
      execute(
        'Write',
        { file_path: join(root, 'blocked.txt'), content: 'not selected' },
        new AbortController().signal,
        { turnId: 'turn', callId: 'blocked' },
      ),
    ).rejects.toThrow(/not selected/);
    expect(existsSync(join(root, 'blocked.txt'))).toBe(false);
  } finally {
    query.close();
    f.eventStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('admits selected MCP through the actual owned Local Codex lifecycle and fences its effects after approval', async () => {
  const { ConfiguredToolCatalog } = await import('../configured-tool-catalog.js');
  const { SessionRegistry } = await import('@mitzo/harness');
  const actualMcp =
    await vi.importActual<typeof import('../codex-mcp-tools.js')>('../codex-mcp-tools.js');
  const root = mkdtempSync(join(tmpdir(), 'owned-selected-mcp-'));
  const catalog = new ConfiguredToolCatalog(':memory:');
  const sources = {
    selected: { command: 'offline-peer', librarySourceId: '11111111-1111-4111-8111-111111111111' },
  };
  const peerCall = vi.fn(async () => ({ content: [{ type: 'text', text: 'Owned MCP result' }] }));
  const peerClose = vi.fn(async () => {});
  const sourceOptions = {
    cwd: root,
    env: {},
    signal: new AbortController().signal,
    readSources: () => sources,
    assertRuntimeCurrent: () => {},
    connect: vi.fn(async () => ({
      listTools: async () => ({ tools: [{ name: 'search', inputSchema: { type: 'object' } }] }),
      callTool: peerCall,
      close: peerClose,
    })),
  };
  let f: ReturnType<typeof ownedLocalOptions> | undefined;
  let query: Awaited<ReturnType<typeof openCodexChat>> | undefined;
  mocks.connect.mockImplementation(actualMcp.connectCodexMcpTools);
  try {
    const entry = (await catalog.refresh(sourceOptions))[0];
    peerClose.mockClear();
    sourceOptions.connect.mockClear();
    const definition = {
      name: 'Owned source',
      role: 'agent',
      instructions: 'Use the selected source.',
      expectedOutput: 'Evidence',
      acceptanceCriteria: ['Original owner only'],
      modelPolicyRole: 'agent',
      tools: [catalog.reference(entry)],
    };
    const profile = {
      profileId: 'owned-agent',
      revision: 1,
      definition,
      contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    };
    f = ownedLocalOptions(root, profile);
    const registry = new SessionRegistry();
    registry.register('owned-client', {
      ...f.opts.session,
      sessionId: 'owned-session',
      sessionAllowList: new Set<string>(),
      transport: { send: () => {}, isOpen: () => true },
    });
    f.opts.session = registry.get('owned-client')!;
    f.opts.registry = registry;
    f.opts.configuredSourceEnv = {};
    f.opts.configuredTools = { catalog, ...sourceOptions };
    f.opts.mcpServers = sources;
    mocks.connect.mockImplementation(actualMcp.connectCodexMcpTools);
    mocks.initialize.mockResolvedValue(undefined);
    mocks.send.mockResolvedValue(undefined);
    mocks.permissionHandler.mockImplementation(async (_name, input) => ({
      behavior: 'allow',
      updatedInput: input,
    }));
    query = await openCodexChat(f.opts);
    const definitions = mocks.conversationOptions!.tools as { name: string }[];
    expect(definitions).toHaveLength(2);
    expect(sourceOptions.connect).toHaveBeenCalledOnce();
    const wire = definitions.find((tool) => tool.name !== 'AskUserQuestion')!.name;
    const execute = mocks.conversationOptions!.executeTool as (
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
      context: { turnId: string; callId: string },
    ) => Promise<{ isError: boolean; content: string }>;
    const call = () =>
      execute(wire, {}, new AbortController().signal, { turnId: 'turn', callId: 'call' });
    expect(await call()).toMatchObject({ content: 'Owned MCP result', isError: false });
    peerCall.mockClear();
    const lease = f.lease;
    mocks.permissionHandler.mockImplementationOnce(async (_name, input) => {
      vi.mocked(lease.assertCurrentSync).mockImplementation(() => {
        throw Error('Original owner revoked');
      });
      return { behavior: 'allow', updatedInput: input };
    });
    expect(await call()).toMatchObject({ isError: true });
    expect(peerCall).not.toHaveBeenCalled();
  } finally {
    query?.close();
    f?.eventStore.close();
    catalog.close();
    rmSync(root, { recursive: true, force: true });
  }
  expect(peerClose).toHaveBeenCalledOnce();
});

it('disposes acquired hooks when the owned admission is revoked before configured source launch', async () => {
  vi.clearAllMocks();
  const nativeHooks = await import('../native-hooks.js');
  const root = mkdtempSync(join(tmpdir(), 'owned-revoked-hooks-'));
  const f = ownedLocalOptions(root);
  const dispose = vi.fn();
  const originalFactory = nativeHooks.createNativeHooks;
  const factory = vi.spyOn(nativeHooks, 'createNativeHooks').mockImplementationOnce((...args) => {
    const acquired = originalFactory(...args);
    vi.mocked(f.lease.assertCurrent).mockRejectedValue(Error('Owned admission revoked'));
    return {
      ...acquired,
      dispose: () => {
        dispose();
        acquired.dispose();
      },
    };
  });
  try {
    await expect(openCodexChat(f.opts)).rejects.toThrow('Owned local Codex chat unavailable');
    expect(dispose).toHaveBeenCalledOnce();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
  } finally {
    factory.mockRestore();
    f.eventStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('exposes exact slice allocation to a retained owned local lead and fences approval and owner changes', async () => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  const f = ownedLocalOptions();
  retainTelosWorkRoleContext(f.eventStore, f.opts.conversationId, f.opts.binding, {
    version: 1,
    itemId: 'outcome',
    role: 'lead',
    brief: {
      revision: 'r1',
      text: 'Reviewed lead brief',
      sha256: createHash('sha256').update('Reviewed lead brief').digest('hex'),
    },
    parentCriteria: [],
    overallGoal: { itemId: 'outcome', revision: 'r1', text: 'Outcome' },
    sources: [],
    artifacts: [],
  });
  let ownerId = 'lead-client';
  f.opts.registry = {
    findBySessionId: () => ({ clientId: ownerId, session: f.opts.session }),
    get: () => f.opts.session,
  } as never;
  const chat = await openCodexChat(f.opts);
  try {
    expect(mocks.conversationOptions?.tools).toContainEqual(
      expect.objectContaining({ name: 'TelosStartSlice' }),
    );
    const execute = mocks.conversationOptions!.executeTool as (
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<{ content: string; isError: boolean }>;
    const input = {
      requestId: 'start-request',
      childItemId: 'slice-one',
      mode: 'start',
      predecessorAttemptId: null,
    };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'deny', message: 'Denied' });
    expect(await execute('TelosStartSlice', input, new AbortController().signal)).toEqual({
      content: 'Denied',
      isError: true,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.permissionHandler).toHaveBeenCalledWith(
      'TelosStartSlice',
      input,
      expect.objectContaining({ allowSessionGrant: true }),
    );
    const policy = mocks.permissionHandler.mock.calls.at(-1)![2];
    expect(policy).not.toHaveProperty('forcePrompt');
    expect(policy).not.toHaveProperty('title');
    const receipt = {
      version: 1,
      state: 'chat_ready',
      execution: 'not_started',
      workerConversationId: 'worker',
      workerPath: '/chat/worker',
      itemPath: '/todos/slice-one',
      leadPath: '/chat/owned-session',
      attempt: {
        version: 1,
        requestId: 'start-request',
        attemptId: 'attempt',
        predecessorAttemptId: null,
        leadConversationId: 'owned-session',
        childItemId: 'slice-one',
        contextSnapshotId: 'source',
        state: 'chat_ready',
        workerConversationId: 'worker',
        allocationReceiptId: 'allocation',
        executionTaskId: 'task',
        accountingGoalId: null,
        turnCommandId: null,
      },
    };
    fetch.mockResolvedValue(new Response(JSON.stringify(receipt)));
    mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'allow', updatedInput: input });
    const result = await execute('TelosStartSlice', input, new AbortController().signal);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual(receipt);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/internal/telos/work/delegate'),
      expect.objectContaining({
        body: JSON.stringify({ clientId: 'lead-client', sessionId: 'owned-session', input }),
      }),
    );
    fetch.mockClear();
    mocks.permissionHandler.mockImplementationOnce(async () => {
      ownerId = 'replacement-client';
      return { behavior: 'allow', updatedInput: input };
    });
    await expect(execute('TelosStartSlice', input, new AbortController().signal)).rejects.toThrow(
      /owner changed/,
    );
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    chat.close();
    f.eventStore.close();
  }
});

it('exposes slice allocation to a retained OpenShell lead without enabling selected profile tool routes', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'sandbox');
  const store = new EventStore(':memory:');
  const binding = {
    accountId: 'lead',
    accountLabel: 'Lead',
    provider: 'openai-codex' as const,
    profileRevision: 'r1',
    model: 'offline-fixture',
  };
  store.upsertSession({ sessionId: 'lead-session', accountBinding: binding });
  retainTelosWorkRoleContext(store, 'lead-session', binding, {
    version: 1,
    itemId: 'outcome',
    role: 'lead',
    brief: {
      revision: 'r1',
      text: 'Brief',
      sha256: createHash('sha256').update('Brief').digest('hex'),
    },
    parentCriteria: [],
    overallGoal: { itemId: 'outcome', revision: 'r1', text: 'Outcome' },
    sources: [],
    artifacts: [],
  });
  const base = options(new AbortController());
  const chat = await openCodexChat({
    ...base,
    eventStore: store,
    conversationId: 'lead-session',
    binding,
    contributorGuidance: store
      .getSessionEvents('lead-session')
      .find((event) => event.type === 'telos_work_role_context')!.payload.guidance as string,
  });
  expect(mocks.conversationOptions?.tools).toContainEqual(
    expect.objectContaining({ name: 'TelosStartSlice' }),
  );
  chat.close();
  store.close();
});

async function openWorkerToolFixture(
  role: 'worker' | 'lead' = 'worker',
  context = true,
  guarded = true,
  owned = true,
) {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'sandbox');
  const store = new EventStore(':memory:');
  const ownedFixture = owned ? ownedOpenShellAdapterFixture() : undefined;
  const binding = (ownedFixture?.binding ?? {
    accountId: 'worker',
    accountLabel: 'Worker',
    provider: 'openai-codex' as const,
    profileRevision: 'r1',
    model: 'offline-fixture',
  }) as Parameters<typeof retainTelosWorkRoleContext>[2];
  store.upsertSession({ sessionId: 'worker-session', accountBinding: binding });
  retainTelosWorkRoleContext(store, 'worker-session', binding, {
    version: 1,
    itemId: 'slice',
    role,
    ...(role === 'worker' ? { leadConversationId: 'lead' } : {}),
    brief: {
      revision: 'r1',
      text: 'Exact slice',
      sha256: createHash('sha256').update('Exact slice').digest('hex'),
    },
    parentCriteria: [],
    overallGoal: { itemId: 'outcome', revision: 'r1', text: 'Outcome' },
    sources: [],
    artifacts: [],
  });
  const opts = ownedFixture?.opts ?? options(new AbortController());
  opts.session.taskContext = context ? { currentTaskId: 'exact-task', goalId: 'exact-task' } : null;
  let clientId = 'worker-client';
  const proof = vi.fn(() => {});
  const restore: Array<() => void> = [];
  let owner: Parameters<typeof openCodexChat>[0]['ownedOpenShell'];
  if (ownedFixture) {
    const { OwnedOpenShellCodexChatAdmission } =
      await import('../owned-openshell-codex-chat-admission.js');
    owner = Object.assign(Object.create(OwnedOpenShellCodexChatAdmission.prototype), {
      assertOptions: vi.fn(),
      assertCurrent: vi.fn(async () => {}),
      assertCurrentSync: vi.fn(),
      configuration: () => ownedFixture.config,
      adoptPhysicalRuntime: vi.fn(),
      assertBeforeEnqueue: vi.fn(),
      assertBeforeDispatch: vi.fn(),
      assertModelSelection: vi.fn(),
      persistNativeCustody: vi.fn(),
      canClaimCommand: vi.fn(() => false),
    });
    const { CodexConversationStore } = await import('../codex-conversation-store.js');
    const retained = vi
      .spyOn(CodexConversationStore.prototype, 'readArtifactRuntime')
      .mockReturnValue({
        runtime: ownedFixture.physical,
        route: { kind: 'api', provider: 'selected-provider', model: binding.model },
      });
    const ensure = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'ensure')
      .mockResolvedValue(ownedFixture.physical);
    const verify = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'verifyKnowledgeRuntime')
      .mockResolvedValue({});
    const compile = vi
      .spyOn(OpenShellRuntimeManager.prototype, 'compileContext')
      .mockResolvedValue({
        type: 'boot_context',
        scope: 'sandbox',
        sourceCount: 0,
        tokenCount: 0,
        tokenBudget: 12000,
        sources: [],
        included: [],
        trimmed: [],
        fullMarkdown: '',
      });
    restore.push(
      () => retained.mockRestore(),
      () => ensure.mockRestore(),
      () => verify.mockRestore(),
      () => compile.mockRestore(),
    );
  }
  const chat = await openCodexChat({
    ...opts,
    eventStore: store,
    conversationId: 'worker-session',
    binding,
    registry: {
      findBySessionId: () => ({ clientId, session: opts.session }),
      get: () => opts.session,
    } as never,
    contributorGuidance: store
      .getSessionEvents('worker-session')
      .find((event) => event.type === 'telos_work_role_context')!.payload.guidance as string,
    ...(guarded ? { assertAgentContextAuthorization: proof } : {}),
    ...(owner ? { ownedOpenShell: owner } : {}),
  });
  return {
    opts,
    proof,
    config: mocks.conversationOptions!,
    replaceOwner() {
      clientId = 'replacement';
    },
    close() {
      chat.close();
      store.close();
      restore.forEach((reset) => reset());
      ownedFixture?.cleanup();
    },
  };
}

it('gives mapped OpenShell workers exact task tools and forwards their saved result through ordinary permissions', async () => {
  const f = await openWorkerToolFixture();
  try {
    const names = (f.config.tools as Array<{ name: string }>).map((tool) => tool.name);
    for (const suffix of ['TaskStatus', 'TaskComplete', 'TaskBlock', 'TaskArtifact'])
      expect(names).toContain(`mcp__task-board__${suffix}`);
    expect(names).not.toContain('mcp__task-board__TaskSet');
    expect(names).not.toContain('TelosStartSlice');
    const execute = f.config.executeTool as (
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<{ content: string; isError: boolean }>;
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ result: 'Task "Slice" marked as pending_review — awaiting approval.' }),
        ),
      );
    vi.stubGlobal('fetch', fetch);
    mocks.permissionHandler.mockResolvedValueOnce({
      behavior: 'allow',
      updatedInput: { summary: 'Saved evidence' },
    });
    const before = f.proof.mock.calls.length;
    expect(
      await execute(
        'mcp__task-board__TaskComplete',
        { summary: 'Saved evidence' },
        new AbortController().signal,
      ),
    ).toEqual({
      content: 'Task "Slice" marked as pending_review — awaiting approval.',
      isError: false,
    });
    expect(f.proof.mock.calls.length).toBeGreaterThan(before);
    expect(mocks.permissionHandler).toHaveBeenCalledWith(
      'mcp__task-board__TaskComplete',
      { summary: 'Saved evidence' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/internal/task-tools/complete'),
      expect.objectContaining({
        body: JSON.stringify({ summary: 'Saved evidence' }),
        headers: expect.objectContaining({
          'X-Client-Id': 'worker-client',
          'X-Task-Session-Id': 'worker-session',
          'X-Task-Id': 'exact-task',
        }),
      }),
    );
    fetch.mockClear();
    mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'deny', message: 'Denied' });
    expect(
      (
        await execute(
          'mcp__task-board__TaskBlock',
          { reason: 'Needs approval' },
          new AbortController().signal,
        )
      ).isError,
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    mocks.permissionHandler.mockImplementationOnce(async () => {
      f.opts.session.taskContext = { currentTaskId: 'other-task', goalId: 'other-task' };
      return { behavior: 'allow', updatedInput: { summary: 'Saved evidence' } };
    });
    await expect(
      execute(
        'mcp__task-board__TaskComplete',
        { summary: 'Saved evidence' },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/task.*scope|context.*changed/i);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it.each([
  ['lead', true, true, true],
  ['worker', false, true, true],
  ['worker', true, false, true],
  ['worker', true, true, false],
] as const)(
  'withholds OpenShell task adapters without exact worker role/context/proof/owner: %s %s %s %s',
  async (role, context, proof, owned) => {
    const f = await openWorkerToolFixture(role, context, proof, owned);
    try {
      const names = (f.config.tools as Array<{ name: string }>).map((tool) => tool.name);
      expect(names.some((name) => name.startsWith('mcp__task-board__'))).toBe(false);
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const execute = f.config.executeTool as (
        name: string,
        input: Record<string, unknown>,
        signal: AbortSignal,
      ) => Promise<{ isError: boolean }>;
      expect(
        (await execute('mcp__task-board__TaskStatus', {}, new AbortController().signal)).isError,
      ).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  },
);

it('keeps explicit owned lead tool selection authoritative over S5 helpers and ambient task MCP servers', async () => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({
    definitions: [],
    displayName: (name: string) => name,
    close: mocks.mcpClose,
  });
  const definition = {
    name: 'Selected lead',
    role: 'agent' as const,
    instructions: 'Plan within the selected tools.',
    expectedOutput: 'Evidence',
    acceptanceCriteria: ['Selected effects only'],
    modelPolicyRole: 'agent' as const,
    tools: [{ id: 'mitzo:Read', version: 1 }],
  };
  const profile = {
    profileId: 'owned-agent',
    revision: 1,
    definition,
    contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
  };
  const f = ownedLocalOptions('/tmp', profile);
  retainTelosWorkRoleContext(f.eventStore, f.opts.conversationId, f.opts.binding, {
    version: 1,
    itemId: 'outcome',
    role: 'lead',
    brief: {
      revision: 'r1',
      text: 'Lead',
      sha256: createHash('sha256').update('Lead').digest('hex'),
    },
    parentCriteria: [],
    overallGoal: { itemId: 'outcome', revision: 'r1', text: 'Outcome' },
    sources: [],
    artifacts: [],
  });
  f.opts.mcpServers = {
    'task-board': { command: 'offline-task-board', args: [] },
    telos: { command: 'offline-telos', args: [] },
  };
  f.opts.registry = {
    findBySessionId: () => ({ clientId: 'selected-lead', session: f.opts.session }),
    get: () => f.opts.session,
  } as never;
  const query = await openCodexChat(f.opts);
  try {
    expect(
      (mocks.conversationOptions!.tools as Array<{ name: string }>).map((tool) => tool.name),
    ).toEqual(['AskUserQuestion', 'Read']);
    expect(mocks.connect).toHaveBeenCalledWith({}, expect.anything());
    const execute = mocks.conversationOptions!.executeTool as (
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<unknown>;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    mocks.permissionHandler.mockClear();
    for (const name of [
      'TelosStartSlice',
      'mcp__task-board__TaskComplete',
      'mcp__telos__TelosStartSlice',
    ])
      await expect(execute(name, {}, new AbortController().signal)).rejects.toThrow(/not selected/);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.permissionHandler).not.toHaveBeenCalled();
  } finally {
    query.close();
    f.eventStore.close();
  }
});
it('routes qualified owned Codex task provider calls to durable review proposals without saving tasks', async () => {
  const { bindAgentLibraryTransport } = await import('../agent-library-transport.js');
  const { default: Database } = await import('better-sqlite3');
  vi.clearAllMocks();
  mocks.initialize.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue({
    definitions: [],
    close: mocks.mcpClose,
    displayName: (name: string) => name,
  });
  const root = mkdtempSync(join(tmpdir(), 'owned-codex-task-route-'));
  vi.stubEnv('REPO_PATH', root);
  const f = ownedLocalOptions(root);
  f.opts.session.sessionId = 'owned-session';
  f.opts.registry = {
    findBySessionId: () => ({ clientId: 'owned-task-client', session: f.opts.session }),
    get: () => f.opts.session,
  } as never;
  const release = bindAgentLibraryTransport('owned-task-client', {
    id: 'owned-task-login',
    expiresAt: Date.now() + 60000,
  });
  let chat: Awaited<ReturnType<typeof openCodexChat>> | undefined;
  try {
    chat = await openCodexChat(f.opts);
    const config = mocks.conversationOptions!;
    expect((config.tools as Array<{ name: string }>).map(({ name }) => name)).toEqual(
      expect.arrayContaining(['AgentReadTasks', 'AgentProposeTask']),
    );
    const execute = config.executeTool as (
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
      context: { turnId: string; callId: string },
    ) => Promise<{ content: string; isError: boolean }>;
    const input = {
      taskId: 'owned-daily',
      expectedRevision: 0,
      definition: {
        name: 'Owned daily',
        objective: '',
        profile: { profileId: 'trace', revision: 3, contentHash: 'a'.repeat(64) },
        execution: null,
        workspace: null,
        schedule: null,
        notificationPolicy: 'results',
        outputPolicy: 'session',
      },
    };
    const context = { turnId: 'owned-provider-turn', callId: 'owned-provider-call' };
    const signal = new AbortController().signal;
    const first = await execute('AgentProposeTask', input, signal, context);
    expect(first).toMatchObject({ isError: false });
    expect(JSON.parse(first.content)).toMatchObject({
      status: 'awaiting_user_review',
      taskId: 'owned-daily',
      expectedRevision: 0,
    });
    expect(await execute('AgentProposeTask', input, signal, context)).toEqual(first);
    const db = new Database(join(root, '.mitzo', 'events.db'), { readonly: true });
    try {
      expect(
        db
          .prepare("SELECT idempotency_key FROM symposium_profile_proposals WHERE kind='task'")
          .all(),
      ).toEqual([
        {
          idempotency_key: createHash('sha256')
            .update(JSON.stringify(['task', 'owned-session', context.turnId, context.callId]))
            .digest('hex'),
        },
      ]);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'agent_task_%'").all(),
      ).toEqual([]);
    } finally {
      db.close();
    }
    expect(f.lease.assertCurrent).toHaveBeenCalled();
    expect(f.lease.assertCurrentSync).toHaveBeenCalled();
  } finally {
    chat?.close();
    release();
    f.eventStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'composes the published task selection with the qualified owned Codex surface (selected=%s)',
  async (selected) => {
    const { bindAgentLibraryTransport } = await import('../agent-library-transport.js');
    const { SessionRegistry } = await import('@mitzo/harness');
    const root = mkdtempSync(join(tmpdir(), 'owned-selected-builder-tasks-'));
    vi.stubEnv('REPO_PATH', root);
    const definition = {
      name: 'Task author',
      role: 'agent',
      instructions: 'Propose reviewed task definitions only.',
      expectedOutput: 'A task proposal',
      acceptanceCriteria: ['No task saved'],
      modelPolicyRole: 'agent',
      tools: selected
        ? [
            { id: 'mitzo:AgentReadTasks', version: 1 },
            { id: 'mitzo:AgentProposeTask', version: 1 },
          ]
        : [],
    };
    const profile = {
      profileId: 'owned-agent',
      revision: 1,
      definition,
      contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    };
    const f = ownedLocalOptions(root, profile);
    const registry = new SessionRegistry();
    registry.register('selected-task-client', {
      ...f.opts.session,
      sessionId: 'owned-session',
      sessionAllowList: new Set(),
      transport: { send() {}, isOpen: () => true },
    });
    f.opts.session = registry.get('selected-task-client')!;
    f.opts.registry = registry;
    mocks.connect.mockResolvedValue({
      definitions: [],
      displayName: (name: string) => name,
      close: mocks.mcpClose,
    });
    mocks.initialize.mockResolvedValue(undefined);
    mocks.send.mockResolvedValue(undefined);
    const release = bindAgentLibraryTransport('selected-task-client', {
      id: 'selected-task-login',
      expiresAt: Date.now() + 60000,
    });
    let query: Awaited<ReturnType<typeof openCodexChat>> | undefined;
    try {
      query = await openCodexChat(f.opts);
      const config = mocks.conversationOptions!;
      expect((config.tools as { name: string }[]).map(({ name }) => name).sort()).toEqual(
        (selected
          ? ['AskUserQuestion', 'AgentReadTasks', 'AgentProposeTask']
          : ['AskUserQuestion']
        ).sort(),
      );
      const execute = config.executeTool as (
        name: string,
        input: Record<string, unknown>,
        signal: AbortSignal,
        context: { turnId: string; callId: string },
      ) => Promise<{ content: string; isError: boolean }>;
      const input = {
        taskId: 'selected-task',
        expectedRevision: 0,
        definition: {
          name: 'Selected task',
          objective: '',
          profile: { profileId: 'reviewer', revision: 3, contentHash: 'a'.repeat(64) },
          execution: null,
          workspace: null,
          schedule: null,
          notificationPolicy: 'results',
          outputPolicy: 'session',
        },
      };
      vi.mocked(f.lease.assertCurrent).mockClear();
      const call = () =>
        execute('AgentProposeTask', input, new AbortController().signal, {
          turnId: 'verified-turn',
          callId: 'verified-call',
        });
      if (!selected) {
        await expect(call()).rejects.toThrow(/not selected/);
        expect(f.lease.assertCurrent).not.toHaveBeenCalled();
        expect(existsSync(join(root, '.mitzo', 'events.db'))).toBe(false);
      } else {
        const first = await call();
        expect(first.isError).toBe(false);
        expect(JSON.parse(first.content)).toMatchObject({
          status: 'awaiting_user_review',
          taskId: 'selected-task',
          expectedRevision: 0,
        });
        expect(await call()).toEqual(first);
        const store = new SymposiumProfileProposalStore(join(root, '.mitzo', 'events.db'));
        try {
          expect(store.listTaskProposals('user', 'owned-session')).toHaveLength(1);
        } finally {
          store.close();
        }
        await expect(
          execute('Read', { file_path: 'excluded' }, new AbortController().signal, {
            turnId: 'verified-turn',
            callId: 'excluded',
          }),
        ).rejects.toThrow(/not selected/);
      }
    } finally {
      query?.close();
      release();
      registry.dispose();
      f.eventStore.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
