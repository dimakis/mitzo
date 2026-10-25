import { AgentContextSnapshotSchema } from '@mitzo/protocol';
import { AGENT_CONTEXT_COMPILER_REVISION, contextDigest } from '../agent-context-compiler.js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { AccountProfiles } from '../account-profiles.js';
import { OwnedLocalCodexChatAdmission } from '../owned-local-codex-chat-admission.js';
import { OwnedCodexLifecycleBridge } from '../owned-codex-lifecycle-bridge.js';
import type { OrdinaryLocalCodexOwnedDispatch } from '../ordinary-local-codex-owned-runtime.js';
import type { FrozenHostCodexBootstrapLease } from '../frozen-host-codex-bootstrap.js';
import { openCodexChat } from '../codex-chat-session.js';
import { createWorktree } from '../worktree.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as nativeHost from '../native-host-tool-context.js';
import * as operatorTransport from '../agent-library-transport.js';
import { authenticateToken, login, setAuthRevocationStore } from '../auth.js';
import { AdviserTaskScope } from '../adviser-task-scope.js';

const nativeQueues = vi.hoisted(() => new WeakMap<object, { startQueued(): Promise<void> }>());
vi.mock('../codex-chat-session.js', () => ({
  openCodexChat: vi.fn(),
  getCodexRuntime: (session: object) => nativeQueues.get(session),
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
let sequence = 0;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-owned-chat-consumer-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No network in consumer fixture');
    }),
  );
  chat = await import('../chat.js');
});
afterAll(() => {
  chat?.eventStore.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function fixture(store?: EventStore, withContext = false) {
  vi.clearAllMocks();
  const events = store ?? chat.eventStore;
  const id = `owned-consumer-${++sequence}`;
  const profiles = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Personal',
        provider: 'openai-codex',
        credentialRef: '/offline/source',
        email: 'fixture@example.test',
        planType: 'plus',
        models: [{ id: 'fixture-model', label: 'Offline' }],
      },
    ],
    { codexEnabled: true },
  );
  const binding = profiles.resolve('personal', 'fixture-model');
  const profile = profiles.codexProfile(binding);
  const definition = {
    name: 'Agent',
    descriptor: 'Offline',
    role: 'agent' as const,
    instructions: 'Work offline',
    expectedOutput: 'Evidence',
    acceptanceCriteria: ['Use evidence'],
    modelPolicyRole: 'agent' as const,
    ...(withContext
      ? {
          contextRecipe: {
            version: 1 as const,
            source: 'contexgin' as const,
            agentName: 'fixture-agent',
          },
        }
      : {}),
  };
  const agentProfile = {
    profileId: 'agent',
    revision: 1,
    definition,
    contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
  };
  const context = {
    type: 'boot_context' as const,
    source: 'contexgin' as const,
    sourceCount: 1,
    tokenCount: 5,
    tokenBudget: 1000,
    sources: [{ path: 'source.md', kind: 'reference' as const }],
    included: [],
    trimmed: [],
    fullMarkdown: 'PINNED CONTEXT',
  };
  const agentContext = withContext
    ? AgentContextSnapshotSchema.parse({
        profileId: agentProfile.profileId,
        revision: agentProfile.revision,
        profileHash: agentProfile.contentHash,
        source: 'contexgin',
        recipeHash: contextDigest(definition.contextRecipe),
        compilerRevision: AGENT_CONTEXT_COMPILER_REVISION,
        payloadHash: contextDigest(context),
        context,
      })
    : undefined;
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
    workspace: { workspaceId: id, cwd: root },
    selection: {
      version: 1 as const,
      agent: { profileId: 'agent', revision: 1 },
      context: withContext
        ? { source: 'contexgin' as const, revision: contextDigest(definition.contextRecipe) }
        : { source: 'none' as const, revision: null },
      permission: { mode: 'agent' as const, revision: 0 },
      model: 'fixture-model',
      thinking: null,
    },
    agentProfile,
    agentContext,
  };
  const payload = {
    text: 'Frozen provider input',
    intent: 'Original intent',
    systemPrompt: 'Frozen developer instructions',
  };
  const commandId = `${id}-command`;
  events.admitOrdinaryLocalCommand(
    {
      sessionId: id,
      cwd: root,
      repositoryWorkspaceId: id,
      accountBinding: binding,
      agentProfile,
      agentContext,
      mode: 'agent',
      selectedModel: 'fixture-model',
      reasoningEffort: null,
    },
    expected.binding,
    {
      clientMsgId: commandId,
      requestFingerprint: `${id}-fp`,
      selection: expected.selection,
      payload,
    },
  );
  events.claimOrdinaryLocalCommandDispatch(commandId);
  const lease: FrozenHostCodexBootstrapLease = {
    client: { initialize: vi.fn(async () => {}), request: vi.fn(async () => ({})), close: vi.fn() },
    binding,
    profile,
    privateHome: '/offline/private-home',
    executableSha256: 'a'.repeat(64),
    assertCurrent: vi.fn(async () => {}),
    assertCurrentSync: vi.fn(),
    close: vi.fn(),
  };
  const admission = OwnedLocalCodexChatAdmission.capture({
    eventStore: events,
    sessionId: id,
    commandId,
    expected,
    lease,
    bridge: new OwnedCodexLifecycleBridge(() => lease),
  });
  const workspace = {
    id,
    connectionId: 'github',
    connectionRevision: 1,
    binding,
    repository: 'owner/repo',
    baseBranch: 'main',
    baseOid: 'a'.repeat(40),
    featureBranch: `mitzo/${id}`,
    sourceDigest: 'b'.repeat(64),
    conversationId: id,
    directory: root,
    sandbox: false,
    state: 'claimed' as const,
    createdAt: Date.now(),
  };
  const input: OrdinaryLocalCodexOwnedDispatch = {
    admission,
    lease,
    profile,
    expected,
    workspace,
    payload,
    sessionId: id,
    commandId,
  };
  const transport = { send: vi.fn(), isOpen: () => true };
  const nativeState = { dispatchCount: 0 };
  const nativeQuery = {
    [Symbol.asyncIterator]: vi.fn(async function* () {
      expect(nativeState.dispatchCount).toBe(1);
      yield { type: 'system', subtype: 'init', session_id: id };
      yield {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: `${id}-reply`, model: 'fixture-model', content: [], usage: {} },
        },
      };
      yield {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
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
    }),
    close: vi.fn(),
    interrupt: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
    stopTask: vi.fn(async () => {
      throw Error('Offline native subagents unavailable');
    }),
  };
  vi.mocked(openCodexChat).mockImplementation(async (options) => {
    options.ownedLocal!.assertOptions(options);
    options.ownedLocal!.assertBeforeEnqueue({
      id: options.messageId,
      prompt: options.prompt,
      intent: options.intent,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    });
    expect(options.ownedLocal!.canClaimCommand(options.messageId)).toBe(false);
    expect(() => options.ownedLocal!.assertBeforeDispatch(options.messageId)).toThrow();
    // Model the original native queue. Only the production prepared run may
    // wake it after its coordinator commits consumed; tests never pump it.
    nativeQueues.set(options.session, {
      startQueued: async () => {
        expect(events.getOrdinaryLocalCommandAdmission(commandId)?.state).toBe('consumed');
        expect(options.ownedLocal!.canClaimCommand(options.messageId)).toBe(true);
        options.ownedLocal!.assertBeforeDispatch(options.messageId);
        nativeState.dispatchCount++;
        if (withContext) {
          await options.prepareAgentContext?.(options.session.abortController.signal);
          options.onAgentContextAccepted?.(
            options.messageId,
            'retained-thread',
            'accepted-turn',
            'f'.repeat(64),
          );
        }
      },
    });
    return nativeQuery;
  });
  const ended = vi.fn();
  return {
    input,
    events,
    id,
    commandId,
    transport,
    nativeQuery,
    nativeState,
    lease,
    ended,
    serverOptions: { onEnded: ended },
  };
}

it.each([false, true])(
  'retains native-tool startup authorization and releases it on close or startup failure (failure: %s)',
  async (failStartup) => {
    const f = fixture();
    const release = vi.fn();
    const retain = vi
      .spyOn(nativeHost, 'retainNativeHostToolOperator')
      .mockImplementation((session, operatorConnectionId) => {
        expect(operatorConnectionId).toBe('retained-startup-operator');
        expect(session.ownerConnectionId).toBe('browser');
        expect(session.ownedLocalAuthSessionId).toBe('admitted-login');
        return release;
      });
    if (failStartup)
      vi.mocked(openCodexChat).mockRejectedValueOnce(Error('Offline startup failed'));
    try {
      const preparation = chat.prepareOwnedLocalCodexChat(f.transport, f.id, f.input, {
        operatorConnectionId: 'retained-startup-operator',
        ownerConnectionId: 'browser',
        ownerAuthSessionId: 'admitted-login',
        onEnded: f.ended,
      });
      if (failStartup) await expect(preparation).rejects.toThrow();
      else {
        const prepared = await preparation;
        expect(release).not.toHaveBeenCalled();
        prepared.close();
        prepared.close();
      }
      expect(retain).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      retain.mockRestore();
    }
  },
);

it.each([false, true])(
  'composes scoped adviser preparation with the exact retained login and cleanup (failure: %s)',
  async (failStartup) => {
    const f = fixture();
    setAuthRevocationStore(chat.eventStore);
    const token = await login(process.env.AUTH_PASSPHRASE!);
    const auth = token && (await authenticateToken(token));
    if (!auth) throw Error('Synthetic interactive login unavailable');
    const operatorId = `${f.id}:feature-operator`;
    const viewerId = `${f.id}:viewer`;
    const releaseOperator = operatorTransport.bindAgentLibraryTransport(operatorId, auth);
    const releaseViewer = operatorTransport.bindAgentLibraryTransport(viewerId, auth);
    const authority = operatorTransport.captureAgentLibraryAuthorization(operatorId);
    const scope = new AdviserTaskScope(
      {
        authSessionId: auth.id,
        feature: { kind: 'terminal', terminalId: 'offline-terminal' },
        accountId: f.input.lease.binding.accountId,
        model: f.input.lease.binding.model,
        reasoningEffort: null,
        instructions: 'Review only the selected text.',
        messages: [{ role: 'user', content: 'Exact reviewed context.' }],
      },
      () => authority.assertCurrent(),
      new AbortController().signal,
    );
    scope.bindCommand(f.id, f.commandId);
    const bindings = vi.spyOn(operatorTransport, 'bindAgentLibraryTransport');
    if (failStartup)
      vi.mocked(openCodexChat).mockRejectedValueOnce(Error('Offline startup failed'));
    try {
      const preparing = chat.prepareOwnedLocalCodexChat(f.transport, f.id, f.input, {
        ...f.serverOptions,
        operatorConnectionId: operatorId,
        ownerConnectionId: viewerId,
        ownerAuthSessionId: auth.id,
        adviserScope: scope,
      });
      if (failStartup) await expect(preparing).rejects.toThrow();
      else {
        const prepared = await preparing;
        const opened = vi.mocked(openCodexChat).mock.calls.at(-1)![0];
        expect(opened.adviserScope).toBe(scope);
        expect(opened.mcpServers).toEqual({});
        expect(chat.registry.get(f.id)?.ownedLocalAuthSessionId).toBe(auth.id);
        releaseViewer();
        expect(() => scope.assertCurrent()).not.toThrow();
        const [nativeOperator, retainedAuth] = bindings.mock.calls.find(([id]) =>
          id.startsWith('native-host:'),
        )!;
        expect(retainedAuth.id).toBe(auth.id);
        expect(() =>
          operatorTransport.captureAgentLibraryAuthorization(nativeOperator).assertCurrent(),
        ).not.toThrow();
        prepared.close();
        prepared.close();
      }
      const nativeBindings = bindings.mock.calls.filter(([id]) => id.startsWith('native-host:'));
      expect(nativeBindings).toHaveLength(1);
      expect(nativeBindings[0][1].id).toBe(auth.id);
      expect(() =>
        operatorTransport.captureAgentLibraryAuthorization(nativeBindings[0][0]),
      ).toThrow();
      expect(() => authority.assertCurrent()).not.toThrow();
      expect(f.ended).toHaveBeenCalledOnce();
    } finally {
      releaseViewer();
      releaseOperator();
      bindings.mockRestore();
    }
  },
);

it('prepares exact existing native ownership under uncertainty and runs shared stream translation only after consumed', async () => {
  const f = fixture();
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('AUTH_SECRET', 'private-controller-secret');
  vi.stubEnv('GH_TOKEN', 'private-github-token');
  const prepared = await chat.prepareOwnedLocalCodexChat(f.transport, f.id, f.input, {
    ownerConnectionId: 'browser',
    onEnded: f.ended,
  });
  expect(f.events.getOrdinaryLocalCommandAdmission(f.commandId)?.state).toBe('uncertain');
  expect(f.nativeQuery[Symbol.asyncIterator]).not.toHaveBeenCalled();
  expect(f.nativeState.dispatchCount).toBe(0);
  const options = vi.mocked(openCodexChat).mock.calls.at(-1)![0];
  expect(options).toMatchObject({
    ownedLocal: f.input.admission,
    profile: f.input.profile,
    prompt: f.input.payload.text,
    systemPrompt: f.input.payload.systemPrompt,
    intent: f.input.payload.intent,
    conversationId: f.id,
    messageId: f.commandId,
    repositoryWorkspace: f.input.workspace,
  });
  expect(options.env.AUTH_SECRET).toBeUndefined();
  expect(options.env.GH_TOKEN).toBeUndefined();
  expect(f.lease.client.initialize).not.toHaveBeenCalled();
  expect(createWorktree).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
  await expect(prepared.run()).rejects.toThrow('Owned local Codex chat unavailable');
  f.events.completeOrdinaryLocalCommand(f.commandId);
  await prepared.run();
  expect(f.nativeState.dispatchCount).toBe(1);
  expect(f.nativeQuery[Symbol.asyncIterator]).toHaveBeenCalledOnce();
  expect(
    f.events.getSessionEvents(f.id).filter((event) => event.type === 'user_message'),
  ).toHaveLength(1);
  expect(
    f.events
      .getSessionEvents(f.id)
      .some((event) => event.type === 'block_delta' && event.payload.delta === 'Offline reply'),
  ).toBe(true);
  expect(f.events.getSession(f.id)?.state).toBe('ENDED');
  expect(f.events.getOrdinaryLocalCommandAdmission(f.commandId)?.state).toBe('consumed');
  expect(f.ended).toHaveBeenCalledOnce();
  await expect(prepared.run()).rejects.toThrow('Owned local Codex chat unavailable');
});

it('rejects a brand owned by another EventStore before registry, native or transcript effects', async () => {
  const other = new EventStore(':memory:');
  const f = fixture(other);
  try {
    await expect(
      chat.prepareOwnedLocalCodexChat(f.transport, f.id, f.input, f.serverOptions),
    ).rejects.toThrow('Owned local Codex chat unavailable');
    expect(chat.registry.get(f.id)).toBeUndefined();
    expect(f.transport.send).not.toHaveBeenCalled();
    expect(openCodexChat).not.toHaveBeenCalled();
    expect(f.events.hasUserMessage(f.id, f.commandId)).toBe(false);
  } finally {
    other.close();
  }
});

it.each(['payload', 'profile', 'workspace', 'sessionId', 'commandId'] as const)(
  'rejects a changed trusted dispatch %s before registry or transcript effects',
  async (field) => {
    const f = fixture();
    const changed = { ...f.input };
    if (field === 'payload') changed.payload = { ...changed.payload, text: 'Changed input' };
    if (field === 'profile') changed.profile = { ...changed.profile, email: 'other@example.test' };
    if (field === 'workspace') changed.workspace = { ...changed.workspace, state: 'claiming' };
    if (field === 'sessionId') changed.sessionId = 'other-session';
    if (field === 'commandId') changed.commandId = 'other-command';
    await expect(
      chat.prepareOwnedLocalCodexChat(f.transport, f.id, changed, f.serverOptions),
    ).rejects.toThrow('Owned local Codex chat unavailable');
    expect(chat.registry.get(f.id)).toBeUndefined();
    expect(openCodexChat).not.toHaveBeenCalled();
    expect(f.transport.send).not.toHaveBeenCalled();
    expect(f.events.hasUserMessage(f.id, f.commandId)).toBe(false);
  },
);

it('rejects unbranded input and an occupied client ID without replacing the existing session', async () => {
  const f = fixture();
  await expect(
    chat.prepareOwnedLocalCodexChat(
      f.transport,
      f.id,
      {
        ...f.input,
        admission: {} as OwnedLocalCodexChatAdmission,
      },
      f.serverOptions,
    ),
  ).rejects.toThrow('Owned local Codex chat unavailable');
  chat.registry.register(f.id, {
    transport: f.transport,
    abortController: new AbortController(),
    mode: 'ask',
    sessionId: 'existing',
    sessionAllowList: new Set(),
  });
  try {
    await expect(
      chat.prepareOwnedLocalCodexChat(f.transport, f.id, f.input, f.serverOptions),
    ).rejects.toThrow('Owned local Codex chat unavailable');
    expect(chat.registry.get(f.id)?.sessionId).toBe('existing');
    expect(openCodexChat).not.toHaveBeenCalled();
  } finally {
    chat.registry.abort(f.id);
  }
});

it('closes prepared ownership without consuming its uncertain receipt or discarding the claimed workspace', async () => {
  const f = fixture();
  const prepared = await chat.prepareOwnedLocalCodexChat(
    f.transport,
    f.id,
    f.input,
    f.serverOptions,
  );
  prepared.close();
  prepared.close();
  expect(f.nativeQuery.close).toHaveBeenCalledOnce();
  expect(f.lease.close).toHaveBeenCalledOnce();
  expect(f.ended).toHaveBeenCalledOnce();
  expect(f.events.getOrdinaryLocalCommandAdmission(f.commandId)?.state).toBe('uncertain');
  expect(f.events.getSession(f.id)?.repositoryWorkspaceId).toBe(f.input.workspace.id);
  expect(chat.registry.get(f.id)).toBeUndefined();
  await expect(prepared.run()).rejects.toThrow('Owned local Codex chat unavailable');
});

it('supports existing detach/reattach and Stop while retaining the same claimed workspace and receipt', async () => {
  const f = fixture();
  const prepared = await chat.prepareOwnedLocalCodexChat(
    f.transport,
    f.id,
    f.input,
    f.serverOptions,
  );
  f.events.completeOrdinaryLocalCommand(f.commandId);
  chat.detachChat(f.id);
  expect(chat.registry.isAttached(f.id)).toBe(false);
  expect(chat.reattachChat(f.id, f.transport)).toBe(true);
  chat.stopChat(f.id);
  prepared.close();
  expect(f.nativeQuery.close).toHaveBeenCalled();
  expect(f.events.getOrdinaryLocalCommandAdmission(f.commandId)?.state).toBe('consumed');
  expect(f.events.getSession(f.id)?.cwd).toBe(root);
});

it('retains uncertainty and tears down only the new session after native startup fails', async () => {
  const f = fixture();
  vi.mocked(openCodexChat).mockRejectedValue(new Error('private provider contents'));
  await expect(
    chat.prepareOwnedLocalCodexChat(f.transport, f.id, f.input, f.serverOptions),
  ).rejects.toThrow('Owned local Codex chat unavailable');
  expect(chat.registry.get(f.id)).toBeUndefined();
  expect(f.events.getOrdinaryLocalCommandAdmission(f.commandId)?.state).toBe('uncertain');
  expect(f.events.getSession(f.id)?.repositoryWorkspaceId).toBe(f.input.workspace.id);
  expect(f.events.getSession(f.id)?.state).toBe('ENDED');
  expect(f.lease.close).toHaveBeenCalledOnce();
});

it('bounds a native stream failure, closes ownership and preserves the consumed receipt', async () => {
  const f = fixture();
  f.nativeQuery[Symbol.asyncIterator].mockImplementationOnce(async function* () {
    yield { type: 'system', subtype: 'init', session_id: f.id };
    throw Error('private provider contents');
  });
  const prepared = await chat.prepareOwnedLocalCodexChat(
    f.transport,
    f.id,
    f.input,
    f.serverOptions,
  );
  f.events.completeOrdinaryLocalCommand(f.commandId);
  await prepared.run();
  expect(chat.registry.get(f.id)).toBeUndefined();
  expect(f.nativeQuery.close).toHaveBeenCalledOnce();
  expect(f.lease.close).toHaveBeenCalledOnce();
  expect(f.ended).toHaveBeenCalledOnce();
  expect(f.events.getOrdinaryLocalCommandAdmission(f.commandId)?.state).toBe('consumed');
  expect(f.events.getSession(f.id)?.repositoryWorkspaceId).toBe(f.input.workspace.id);
  expect(f.transport.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'error', error: 'Owned local Codex chat unavailable' }),
  );
  expect(JSON.stringify(f.transport.send.mock.calls)).not.toContain('private provider contents');
});

it('closes prepared ownership when its existing registry abort fires, without pumping or clearing uncertainty', async () => {
  const f = fixture();
  const prepared = await chat.prepareOwnedLocalCodexChat(
    f.transport,
    f.id,
    f.input,
    f.serverOptions,
  );
  chat.registry.get(f.id)!.abortController.abort();
  expect(f.nativeQuery[Symbol.asyncIterator]).not.toHaveBeenCalled();
  expect(f.lease.close).toHaveBeenCalledOnce();
  expect(f.ended).toHaveBeenCalledOnce();
  expect(f.events.getOrdinaryLocalCommandAdmission(f.commandId)?.state).toBe('uncertain');
  expect(f.events.getSession(f.id)?.cwd).toBe(root);
  await expect(prepared.run()).rejects.toThrow('Owned local Codex chat unavailable');
});

it('closes a native query that becomes ready after Stop during preparation without changing its uncertain receipt', async () => {
  const f = fixture();
  let ready!: (query: typeof f.nativeQuery) => void;
  vi.mocked(openCodexChat).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  );
  const preparation = chat.prepareOwnedLocalCodexChat(f.transport, f.id, f.input, f.serverOptions);
  await vi.waitFor(() => expect(openCodexChat).toHaveBeenCalledOnce());
  chat.stopChat(f.id);
  ready(f.nativeQuery);
  await expect(preparation).rejects.toThrow('Owned local Codex chat unavailable');
  expect(f.nativeQuery.close).toHaveBeenCalledOnce();
  expect(f.nativeQuery[Symbol.asyncIterator]).not.toHaveBeenCalled();
  expect(f.events.getOrdinaryLocalCommandAdmission(f.commandId)?.state).toBe('uncertain');
  expect(f.events.getSession(f.id)?.cwd).toBe(root);
  expect(chat.registry.get(f.id)).toBeUndefined();
});

it('preserves an existing query owned by the same session under another client ID', async () => {
  const f = fixture();
  const otherClient = `${f.id}-existing`;
  chat.registry.register(otherClient, {
    transport: f.transport,
    abortController: new AbortController(),
    mode: 'agent',
    sessionId: f.id,
    sessionAllowList: new Set(),
  });
  const existing = chat.registry.get(otherClient);
  try {
    await expect(
      chat.prepareOwnedLocalCodexChat(f.transport, f.id, f.input, f.serverOptions),
    ).rejects.toThrow('Owned local Codex chat unavailable');
    expect(chat.registry.get(otherClient)).toBe(existing);
    expect(f.events.hasUserMessage(f.id, f.commandId)).toBe(false);
    expect(f.lease.close).not.toHaveBeenCalled();
    expect(openCodexChat).not.toHaveBeenCalled();
  } finally {
    chat.registry.abort(otherClient);
  }
});

it('bounds shutdown failure while still removing only the owned registry entry and retaining evidence', async () => {
  const f = fixture();
  const ended = vi.fn();
  const prepared = await chat.prepareOwnedLocalCodexChat(f.transport, f.id, f.input, {
    onEnded: ended,
  });
  f.nativeQuery.close.mockImplementationOnce(() => {
    throw Error('private shutdown error');
  });
  expect(() => prepared.close()).toThrow('Owned local Codex chat unavailable');
  expect(ended).toHaveBeenCalledOnce();
  expect(chat.registry.get(f.id)).toBeUndefined();
  expect(f.lease.close).toHaveBeenCalledOnce();
  expect(f.events.getOrdinaryLocalCommandAdmission(f.commandId)?.state).toBe('uncertain');
  expect(f.events.getSession(f.id)?.repositoryWorkspaceId).toBe(f.input.workspace.id);
});

it('requires an explicit server-owned lifecycle release before registry or transcript effects', async () => {
  const f = fixture();
  await expect(
    chat.prepareOwnedLocalCodexChat(
      f.transport,
      f.id,
      f.input,
      {} as Parameters<typeof chat.prepareOwnedLocalCodexChat>[3],
    ),
  ).rejects.toThrow('Owned local Codex chat unavailable');
  expect(chat.registry.get(f.id)).toBeUndefined();
  expect(f.events.hasUserMessage(f.id, f.commandId)).toBe(false);
  expect(openCodexChat).not.toHaveBeenCalled();
  expect(f.ended).not.toHaveBeenCalled();
});

it('starts the shared query loop from the exact owner key after rekeying before run', async () => {
  const f = fixture();
  const prepared = await chat.prepareOwnedLocalCodexChat(
    f.transport,
    f.id,
    f.input,
    f.serverOptions,
  );
  f.events.completeOrdinaryLocalCommand(f.commandId);
  const currentClientId = `${f.id}-rekeyed`;
  expect(chat.rekeyChat(f.id, currentClientId)).toBe(true);
  await prepared.run();
  expect(
    f.events
      .getSessionEvents(f.id)
      .some((event) => event.type === 'block_delta' && event.payload.delta === 'Offline reply'),
  ).toBe(true);
  expect(chat.registry.get(currentClientId)).toBeUndefined();
  expect(f.ended).toHaveBeenCalledOnce();
  expect(f.events.getOrdinaryLocalCommandAdmission(f.commandId)?.state).toBe('consumed');
});

it('never captures an unrelated replacement in the original client slot when the owner rekeys before run', async () => {
  const f = fixture();
  const prepared = await chat.prepareOwnedLocalCodexChat(
    f.transport,
    f.id,
    f.input,
    f.serverOptions,
  );
  f.events.completeOrdinaryLocalCommand(f.commandId);
  const currentClientId = `${f.id}-rekeyed`;
  expect(chat.rekeyChat(f.id, currentClientId)).toBe(true);
  const unrelatedId = `${f.id}-unrelated`;
  const unrelatedTransport = { send: vi.fn(), isOpen: () => true };
  const unrelatedQueue = { push: vi.fn(), close: vi.fn() };
  const unrelatedQuery = {
    close: vi.fn(),
    interrupt: vi.fn(async () => {}),
    stopTask: vi.fn(async () => {}),
  };
  f.events.upsertSession({ sessionId: unrelatedId, cwd: root, mode: 'ask' });
  chat.registry.register(f.id, {
    transport: unrelatedTransport,
    abortController: new AbortController(),
    sessionId: unrelatedId,
    cwd: root,
    mode: 'ask',
    sessionAllowList: new Set(),
  });
  const unrelated = chat.registry.get(f.id)!;
  const sessionChange = vi.fn();
  chat.setSessionChangeCallback(sessionChange);
  unrelated.inputQueue = unrelatedQueue;
  unrelated.queryInstance = unrelatedQuery;
  try {
    await prepared.run();
    expect(
      f.events
        .getSessionEvents(f.id)
        .some((event) => event.type === 'block_delta' && event.payload.delta === 'Offline reply'),
    ).toBe(true);
    expect(chat.registry.get(f.id)).toBe(unrelated);
    expect(unrelated.sessionId).toBe(unrelatedId);
    expect(unrelated.mode).toBe('ask');
    expect(unrelatedTransport.send).not.toHaveBeenCalled();
    expect(unrelatedQueue.push).not.toHaveBeenCalled();
    expect(unrelatedQuery.close).not.toHaveBeenCalled();
    expect(f.events.getSessionEvents(unrelatedId)).toHaveLength(0);
    expect(f.events.getOrdinaryLocalCommandAdmission(f.commandId)?.state).toBe('consumed');
    expect(sessionChange).toHaveBeenCalledWith(currentClientId, 'end', f.id);
    expect(sessionChange).not.toHaveBeenCalledWith(f.id, 'end', f.id);
  } finally {
    chat.setSessionChangeCallback(() => {});
    chat.registry.abort(f.id);
  }
});

it('leaves async context qualification to the owned host wrapper while preserving synchronous revocation', async () => {
  const f = fixture(undefined, true);
  const prepared = await chat.prepareOwnedCodexChat(
    f.transport,
    `client-${f.id}`,
    f.input,
    f.serverOptions,
  );
  try {
    const options = vi.mocked(openCodexChat).mock.calls.at(-1)![0];
    vi.mocked(f.lease.assertCurrent).mockClear();
    await options.prepareAgentContext!(new AbortController().signal);
    expect(f.lease.assertCurrent).not.toHaveBeenCalled();
    vi.mocked(f.lease.assertCurrentSync).mockImplementationOnce(() => {
      throw Error('Offline owner revoked');
    });
    await expect(options.prepareAgentContext!(new AbortController().signal)).rejects.toThrow();
  } finally {
    prepared.close();
  }
});

it('delivers the pinned context through shared owned startup and records only provider-confirmed acceptance', async () => {
  const f = fixture(undefined, true);
  const prepared = await chat.prepareOwnedCodexChat(
    f.transport,
    `client-${f.id}`,
    f.input,
    f.serverOptions,
  );
  const options = vi.mocked(openCodexChat).mock.calls.at(-1)![0];
  expect(options.agentContext).toEqual(f.input.expected.agentContext);
  expect(JSON.parse(f.events.getSession(f.id)!.bootContext!).receipt.status).toBe('prepared');
  expect(
    f.events.getSessionEvents(f.id).some((event) => event.type === 'agent_context_accepted'),
  ).toBe(false);
  f.events.completeOrdinaryLocalCommand(f.commandId);
  await prepared.run();
  expect(JSON.parse(f.events.getSession(f.id)!.bootContext!).receipt.status).toBe('accepted');
  expect(
    f.events.getSessionEvents(f.id).find((event) => event.type === 'agent_context_accepted')
      ?.payload,
  ).toMatchObject({
    commandId: f.commandId,
    providerThreadId: 'retained-thread',
    providerTurnId: 'accepted-turn',
    payloadHash: f.input.expected.agentContext!.payloadHash,
  });
});
