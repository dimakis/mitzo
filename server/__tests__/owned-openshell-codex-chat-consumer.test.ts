import { OpenShellRuntimeManager } from '../openshell-runtime.js';
import {
  SANDBOX_AGENT_COMPILER_REVISION,
  resolveSandboxAgentContext,
} from '../agent-context-sandbox.js';
import { contextDigest } from '../agent-context-compiler.js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProviderSchema } from '@mitzo/protocol';
import { AccountProfiles } from '../account-profiles.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import { OwnedOpenShellCodexChatAdmission } from '../owned-openshell-codex-chat-admission.js';
import type { OrdinaryOpenShellCodexExpectation } from '../owned-openshell-codex-chat-admission.js';
import {
  ordinaryOpenShellCodexTarget,
  projectOrdinaryOpenShellCodexCapabilities,
} from '../ordinary-openshell-codex-route.js';
import type { OpenShellRuntimeConfig } from '../openshell-runtime.js';
import { openCodexChat } from '../codex-chat-session.js';
vi.mock('../codex-chat-session.js', () => ({
  openCodexChat: vi.fn(),
  getCodexRuntime: () => undefined,
  publicCodexStartupError: () => 'Offline native startup failure',
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../worktree.js', async (original) => ({
  ...(await original<object>()),
  createWorktree: vi.fn(() => {
    throw Error('No worktree effects allowed');
  }),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
    throw Error('No model calls allowed');
  }),
}));
vi.mock('../auto-rename.js', () => ({
  shouldAutoRename: () => {
    throw Error('No automatic model naming');
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
let native: CodexConversationStore;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-openshell-consumer-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No network in consumer fixture');
    }),
  );
  chat = await import('../chat.js');
  native = new CodexConversationStore(join(root, 'native.db'));
});
afterAll(() => {
  native?.close();
  chat?.eventStore.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function fixture(withContext = false, sessionId = 'session') {
  const profiles = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Personal',
        provider: 'openai-codex',
        email: 'fixture@example.test',
        planType: 'plus',
        sandboxProvider: 'broker',
        sandboxProviderType: 'openai-codex-oauth',
        sandboxProviderId: 'provider-id',
        sandboxGrantId: 'grant-id',
        models: [
          { id: 'fixture-model', label: 'Offline' },
          { id: 'next-model', label: 'Next' },
        ],
      },
    ],
    { codexEnabled: true },
  );
  const account = profiles.resolve('personal', 'fixture-model');
  const profile = profiles.codexProfile(account);
  const config: OpenShellRuntimeConfig = {
    cli: '/offline/openshell',
    image: 'offline-image',
    policy: '/offline/policy',
    seed: '/offline/seed',
    serviceProviders: [],
    grantableServiceProviders: [],
    workspace: 'workspace',
    gateway: 'gateway',
    gatewayInsecure: false,
    createDetached: true,
    sandboxIdLength: 24,
    workdir: '/sandbox/workspaces/task',
    webSearch: 'disabled',
  };
  const target = ordinaryOpenShellCodexTarget({
    targetId: 'target',
    runtimeContractRevision: 'contract',
    config,
    openaiApi: 'disabled',
  });
  const projection = projectOrdinaryOpenShellCodexCapabilities({
    profiles,
    target,
    deployment: 'ordinary',
  });
  const agentProfile = {
    profileId: 'agent',
    revision: 1,
    contentHash: 'a'.repeat(64),
    definition: {
      name: 'Agent',
      descriptor: 'Offline',
      role: 'agent' as const,
      instructions: 'Offline',
      expectedOutput: 'Evidence',
      acceptanceCriteria: ['Evidence'],
      modelPolicyRole: 'agent' as const,
      ...(withContext
        ? {
            contextRecipe: {
              version: 1 as const,
              source: 'workspace' as const,
              files: ['context.md'],
              tokenBudget: 1000,
              required: [],
              excluded: [],
            },
          }
        : {}),
    },
  };
  agentProfile.contentHash = contextDigest(agentProfile.definition);
  const expected: OrdinaryOpenShellCodexExpectation = {
    binding: {
      version: 2 as const,
      account: {
        accountId: account.accountId,
        provider: AccountProviderSchema.parse(account.provider),
        profileRevision: account.profileRevision,
      },
      harness: { implementation: 'codex' as const },
      execution: {
        location: 'openshell' as const,
        targetId: target.targetId,
        targetRevision: target.targetRevision,
      },
    },
    workspace: { workspaceId: 'workspace', cwd: config.workdir },
    selection: {
      version: 1 as const,
      agent: { profileId: 'agent', revision: 1 },
      context: withContext
        ? {
            source: 'workspace' as const,
            revision: contextDigest(agentProfile.definition.contextRecipe),
          }
        : { source: 'none' as const, revision: null },
      permission: { mode: 'agent' as const, revision: 0 },
      model: 'fixture-model',
      thinking: null,
    },
    agentProfile,
  };
  const meta = {
    sessionId: sessionId,
    repositoryWorkspaceId: 'workspace',
    cwd: config.workdir,
    accountBinding: account,
    mode: 'agent' as const,
    selectedModel: 'fixture-model',
    reasoningEffort: null,
    agentProfile,
  };
  const artifact = {
    runtime: {
      sandboxName: 'sandbox-session',
      sandboxId: 'physical-session',
      cli: config.cli,
      gateway: config.gateway,
      workspace: config.workspace,
      gatewayInsecure: false,
      workdir: config.workdir,
      appServerCommand: '/sandbox/run-mitzo-subscription-app-server' as const,
    },
    route: {
      kind: 'chatgpt-subscription' as const,
      provider: 'broker',
      providerType: 'openai-codex-oauth' as const,
      providerId: 'provider-id',
      grantId: 'grant-id',
      model: 'fixture-model',
    },
  };
  const owner = {
    events: chat.eventStore,
    nativeStore: native,
    sessionId: sessionId,
    expected,
    account,
    profiles,
    profilesCurrent: () => profiles,
    catalog: projection.catalog,
    target,
    config,
    authSessionId: 'signed-auth',
    assertCurrentSync: vi.fn(),
    assertSelectionCurrentSync: vi.fn(),
    assertCurrent: vi.fn(async () => {}),
    readRetained: () => native.readArtifactRuntime(sessionId, account) ?? undefined,
    assertRetainedAuthority: vi.fn(),
    close: vi.fn(),
  };
  native.create(sessionId, account, config.workdir);
  const workspace = {
    seed: '/offline/repository-seed',
    id: 'workspace',
    connectionId: 'github',
    connectionRevision: 1,
    binding: account,
    repository: 'owner/repo',
    baseBranch: 'main',
    baseOid: 'a'.repeat(40),
    featureBranch: 'branch',
    sourceDigest: 'b'.repeat(64),
    conversationId: sessionId,
    sandbox: true,
    state: 'claimed' as const,
    createdAt: 1,
  };
  const manager = new OpenShellRuntimeManager({ ...config, account: artifact.route }, async () => {
    throw Error('No OpenShell CLI calls allowed');
  });
  const scope = {
    sandboxId: artifact.runtime.sandboxId,
    sandboxName: artifact.runtime.sandboxName,
    workspaceRoot: config.workdir,
    runtimeContractImageDigest: 'sha256:' + 'a'.repeat(64),
    compilerSha256: 'b'.repeat(64),
    entrypointSha256: 'c'.repeat(64),
    recipeSha256: 'd'.repeat(64),
    runtimeInputsSha256: 'e'.repeat(64),
  };
  vi.spyOn(manager, 'verifyAgentContextRuntime').mockResolvedValue(scope);
  const compile = vi.spyOn(manager, 'compileAgentContext').mockResolvedValue({
    compilerRevision: SANDBOX_AGENT_COMPILER_REVISION,
    workspaceIdentity: contextDigest(config.workdir),
    context: {
      type: 'boot_context',
      source: 'contexgin',
      sourceCount: 1,
      tokenCount: 5,
      tokenBudget: 1000,
      sources: [{ path: 'context.md', kind: 'markdown' }],
      included: [],
      trimmed: [],
      fullMarkdown: 'PINNED SANDBOX CONTEXT',
    },
  });
  const transport = { send: vi.fn(), isOpen: () => true };
  return {
    profiles,
    profile,
    account,
    config,
    expected,
    meta,
    artifact,
    owner,
    workspace,
    transport,
    manager,
    compile,
  };
}
function mockedProvider(f: ReturnType<typeof fixture>) {
  const closed = vi.fn();
  vi.mocked(openCodexChat).mockImplementation(async (options) => {
    expect(options.ownedLocal).toBeUndefined();
    expect(options.ownedOpenShell).toBeInstanceOf(OwnedOpenShellCodexChatAdmission);
    options.ownedOpenShell!.assertOptions(options);
    native.setArtifactRuntime('session', f.account, f.artifact);
    options.ownedOpenShell!.adoptPhysicalRuntime(f.artifact);
    if (options.agentProfile?.definition.contextRecipe) {
      options.assertAgentContextAuthorization?.();
      const snapshot = await resolveSandboxAgentContext({
        profile: options.agentProfile,
        stored: options.agentContext,
        conversationId: options.conversationId,
        runtime: f.artifact.runtime,
        manager: f.manager,
        signal: options.session.abortController.signal,
      });
      options.assertAgentContextAuthorization?.();
      options.ownedOpenShell!.adoptAgentContext(snapshot!);
    }
    options.ownedOpenShell!.persistNativeCustody(native);
    if (!options.resume) native.bindThread('session', f.account, 'original-thread');
    options.ownedOpenShell!.assertBeforeEnqueue({
      id: options.messageId,
      prompt: options.prompt,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    });
    native.enqueue('session', f.account, {
      id: options.messageId,
      prompt: options.prompt,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    });
    native.claimNext('session', f.account);
    options.ownedOpenShell!.assertBeforeDispatch(options.messageId);
    native.finish(
      'session',
      f.account,
      options.messageId,
      'completed',
      `turn-${options.messageId}`,
    );
    if (options.agentProfile?.definition.contextRecipe)
      options.onAgentContextAccepted?.(
        options.messageId,
        'original-thread',
        `turn-${options.messageId}`,
        'f'.repeat(64),
      );
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'session' };
        yield {
          type: 'stream_event',
          event: {
            type: 'message_start',
            message: {
              id: `reply-${options.messageId}`,
              model: 'fixture-model',
              content: [],
              usage: {},
            },
          },
        };
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        };
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Offline reply' },
          },
        };
        yield { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } };
        yield { type: 'stream_event', event: { type: 'message_stop' } };
        yield { type: 'result', is_error: false, usage: {}, num_turns: 1 };
      },
      close: closed,
      interrupt: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),
      stopTask: vi.fn(async () => {
        throw new Error('Native task stop is unsupported');
      }),
      setWebSearchGrant: (revision: number, grant: 'allowed' | 'denied') =>
        Promise.resolve(native.setWebSearchGrant('session', f.account, revision, grant)),
      getWebSearchGrant: () => native.readWebSearchGrant('session', f.account),
    };
  });
  return closed;
}
it('uses the shared event consumer for first launch and exact cold continuation custody with pinned measured context', async () => {
  const f = fixture(true);
  const payload = { text: 'First prompt', systemPrompt: 'Pinned instructions' };
  chat.eventStore.admitOrdinaryOpenShellCommand(f.meta, f.expected.binding, {
    clientMsgId: 'first',
    requestFingerprint: 'first-fp',
    selection: f.expected.selection,
    payload,
  });
  chat.eventStore.claimOrdinaryOpenShellCommandDispatch('first');
  const first = OwnedOpenShellCodexChatAdmission.capture(f.owner, 'first');
  const closed = mockedProvider(f);
  const prepared = await chat.prepareOwnedCodexChat(
    f.transport,
    'client-first',
    {
      sessionId: 'session',
      commandId: 'first',
      account: f.account,
      profile: f.profile,
      expected: f.expected,
      workspace: f.workspace,
      payload,
      admission: first,
    },
    { ownerAuthSessionId: 'signed-auth', onEnded: vi.fn() },
  );
  chat.eventStore.completeOrdinaryOpenShellCommand('first');
  await prepared.run();
  expect(closed).toHaveBeenCalled();
  expect(native.readOpenShellCustody('session', f.account)?.authSessionId).toBe('signed-auth');
  expect(f.workspace).not.toHaveProperty('directory');
  native.close();
  native = new CodexConversationStore(join(root, 'native.db'));
  f.owner.nativeStore = native;
  const next = { text: 'After restart', systemPrompt: 'Pinned instructions' };
  const nextExpected = {
    ...f.expected,
    selection: { ...f.expected.selection, model: 'next-model' },
  };
  const nextMeta = {
    ...f.meta,
    agentContext: f.expected.agentContext,
    accountBinding: { ...f.account, model: 'next-model' },
    selectedModel: 'next-model',
  };
  chat.eventStore.admitOrdinaryOpenShellContinuation(nextMeta, f.expected.binding, {
    clientMsgId: 'next',
    requestFingerprint: 'next-fp',
    selection: nextExpected.selection,
    payload: next,
  });
  chat.eventStore.claimOrdinaryOpenShellCommandDispatch('next');
  const resumed = OwnedOpenShellCodexChatAdmission.captureResume(
    { ...f.owner, expected: nextExpected, expectedRetained: f.artifact },
    'next',
  );
  const recovered = await chat.prepareOwnedCodexChat(
    f.transport,
    'client-resume',
    {
      sessionId: 'session',
      commandId: 'next',
      resume: true,
      account: f.account,
      profile: { ...f.profile, model: 'next-model' },
      expected: nextExpected,
      workspace: f.workspace,
      payload: next,
      admission: resumed,
    },
    { ownerAuthSessionId: 'signed-auth', onEnded: vi.fn() },
  );
  chat.eventStore.completeOrdinaryOpenShellCommand('next');
  await recovered.run();
  expect(vi.mocked(openCodexChat).mock.calls[1][0]).toMatchObject({
    resume: true,
    conversationId: 'session',
    binding: f.account,
    model: 'next-model',
  });
  expect(native.read('session', f.account).threadId).toBe('original-thread');
  expect(native.readArtifactRuntime('session', f.account)).toEqual(f.artifact);
  expect(native.commands('session', f.account).map((command) => command.id)).toEqual([
    'first',
    'next',
  ]);
  expect(native.commands('session', f.account).map((command) => command.model)).toEqual([
    'fixture-model',
    'next-model',
  ]);
  expect(chat.eventStore.getSessionRuntimeBinding('session')).toEqual(f.expected.binding);
  expect(f.compile).toHaveBeenCalledOnce();
  expect(chat.eventStore.getSession('session')?.agentContext?.context.fullMarkdown).toBe(
    'PINNED SANDBOX CONTEXT',
  );
  expect(JSON.parse(chat.eventStore.getSession('session')!.bootContext!).receipt.status).toBe(
    'accepted',
  );
  expect(
    f.transport.send.mock.calls.some(
      ([event]) => event.type === 'block_delta' || event.type === 'block_start',
    ),
  ).toBe(true);
});
it('denies retained role corruption arriving during awaited final OpenShell admission validation', async () => {
  const f = fixture(true, 'role-final-session');
  chat.eventStore.admitOrdinaryOpenShellCommand(f.meta, f.expected.binding, {
    clientMsgId: 'role-final',
    requestFingerprint: 'role-final-fp',
    selection: f.expected.selection,
    payload: { text: 'Explicit command', systemPrompt: 'Pinned instructions' },
  });
  chat.eventStore.claimOrdinaryOpenShellCommandDispatch('role-final');
  const admission = OwnedOpenShellCodexChatAdmission.capture(f.owner, 'role-final');
  f.owner.assertCurrent.mockImplementationOnce(async () => {
    chat.eventStore.append(f.meta.sessionId, 'telos_work_role_context', {
      version: 1,
      selection: { role: 'lead' },
    });
  });
  await expect(admission.assertCurrent()).rejects.toThrow();
  expect(f.owner.assertCurrent).toHaveBeenCalledOnce();
  expect(
    chat.eventStore
      .getSessionEvents(f.meta.sessionId)
      .some((event) => event.type === 'telos_work_role_context'),
  ).toBe(true);
});

it('shares one fresh session ownership projection and sees owner-callback mutations', () => {
  const f = fixture(false, 'ownership-session');
  chat.eventStore.admitOrdinaryOpenShellCommand(f.meta, f.expected.binding, {
    clientMsgId: 'ownership-command',
    requestFingerprint: 'ownership-fp',
    selection: f.expected.selection,
    payload: { text: 'Read', systemPrompt: 'Instructions' },
  });
  chat.eventStore.claimOrdinaryOpenShellCommandDispatch('ownership-command');
  const admission = OwnedOpenShellCodexChatAdmission.capture(f.owner, 'ownership-command');
  const projection = vi.spyOn(chat.eventStore, 'observeSessionOwnership');
  const separate = vi.spyOn(chat.eventStore, 'getSessionRuntimeBinding');
  try {
    admission.assertCurrentSync();
    expect(projection).toHaveBeenCalledTimes(1);
    expect(separate).not.toHaveBeenCalled();
    f.owner.assertCurrentSync.mockImplementation(() => {
      chat.eventStore.upsertSession({ sessionId: 'ownership-session', mode: 'ask' });
    });
    expect(() => admission.assertCurrentSync()).toThrow('Owned OpenShell Codex chat unavailable');
    expect(projection).toHaveBeenCalledTimes(2);
  } finally {
    projection.mockRestore();
    separate.mockRestore();
  }
});
