import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AccountProfiles } from '../account-profiles.js';
import { openResponsesChat } from '../responses-chat-session.js';
import { credentials } from '../credentials.js';
import { openCodexChat } from '../codex-chat-session.js';
import { ConnectionRegistry } from '@mitzo/harness';
import { capturePromptComparison } from '../prompt-compare.js';
import { registerSession } from '../session-index.js';
import { createWorktree } from '../worktree.js';
const codexLaunch = vi.hoisted(() =>
  vi.fn(() => ({
    initialize: async () => {},
    request: async () => ({
      account: { type: 'chatgpt', email: 'test@example.com', planType: 'test' },
    }),
    close: () => {},
  })),
);
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: vi.fn(),
}));
vi.mock('../session-index.js', async (original) => ({
  ...(await original<object>()),
  registerSession: vi.fn(),
}));
vi.mock('../worktree.js', async (original) => ({
  ...(await original<object>()),
  createWorktree: vi.fn(() => '/host/worktree/must-not-be-created'),
}));
vi.mock('../prompt-compare.js', () => ({
  capturePromptComparison: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../responses-chat-session.js', () => ({ openResponsesChat: vi.fn() }));
vi.mock('../credentials.js', async (original) => ({
  ...(await original<object>()),
  credentials: { resolve: vi.fn(async () => 'private-work-key') },
}));
vi.mock('../codex-chat-session.js', () => ({
  openCodexChat: vi.fn(),
  getCodexRuntime: () => undefined,
  publicCodexRuntimeError: (error: Error) => error.message,
  publicCodexStartupError: (error: Error) => error.message,
}));
vi.mock('../codex-app-server-client.js', async (original) => ({
  ...(await original<object>()),
  CodexAppServerClient: {
    launch: codexLaunch,
  },
  codexEnvironment: () => ({ PATH: '/bin' }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('routes a bound Codex account to its controller with context and canonical durable identity, never the Anthropic SDK', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-codex-dispatch-'));
  await writeFile(join(root, 'context.md'), 'attached context');
  await writeFile(
    join(root, '.mitzo.json'),
    JSON.stringify({ contextBlocks: { attached: 'context.md' } }),
  );
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ boot: { tokens: 1, content: 'boot evidence' } })),
      ),
  );
  const chat = await import('../chat.js');
  const profiles = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'ChatGPT',
        provider: 'openai-codex',
        credentialRef: '/login',
        email: 'test@example.com',
        planType: 'test',
        models: [{ id: 'luna', label: 'Luna' }],
      },
    ],
    { codexEnabled: true },
  );
  let id = '';
  let opened: Parameters<typeof openCodexChat>[0] | undefined;
  let persisted: unknown;
  vi.mocked(openCodexChat).mockImplementation(async (options) => {
    id = options.conversationId;
    opened = options;
    persisted = chat.eventStore.getSession(id)?.accountBinding;
    throw new Error('simulated Codex startup failure');
  });
  try {
    await chat.startChat({ send: () => {}, isOpen: () => true }, 'codex-test', 'hello', {
      cwd: root,
      isolation: false,
      accountId: 'personal',
      model: 'luna',
      accountProfiles: profiles,
      contextBlocks: ['attached'],
      initialSessionId: '5f68a371-73d1-4994-a512-b71d4bc44c65',
      clientMsgId: 'durable-first-prompt',
      images: [{ data: 'aGVsbG8=', mediaType: 'image/png' }],
      reasoningEffort: 'high',
    });
    expect(openCodexChat).toHaveBeenCalledOnce();
    expect(persisted).toEqual(profiles.resolve('personal', 'luna'));
    expect(opened?.systemPrompt).toContain('boot evidence');
    expect(opened?.systemPrompt).toContain('Telos is the de facto persistent home');
    expect(opened?.prompt).toContain('attached context');
    expect(query).not.toHaveBeenCalled();
    expect(id).toBe('5f68a371-73d1-4994-a512-b71d4bc44c65');
    expect(opened?.messageId).toBe('durable-first-prompt');
    expect(opened?.images).toEqual([{ data: 'aGVsbG8=', mediaType: 'image/png' }]);
    expect(opened?.reasoningEffort).toBe('high');
    expect(opened?.prompt).not.toContain('Read them using the Read tool');
    expect(chat.eventStore.getSession(id)?.state).toBe('ENDED');
    await chat.startChat({ send: () => {}, isOpen: () => true }, 'codex-resume', 'next', {
      cwd: root,
      isolation: false,
      accountId: 'personal',
      model: 'luna',
      accountProfiles: profiles,
      resume: id,
      clientMsgId: 'durable-next-prompt',
      contributorGuidance: 'Contribute to this selected document. Outcome capture is optional.',
    });
    expect(id).toBe('5f68a371-73d1-4994-a512-b71d4bc44c65');
    expect(opened?.messageId).toBe('durable-next-prompt');
    expect(opened?.systemPrompt).toContain('Outcome capture is optional.');
    expect(opened?.systemPrompt).not.toContain('Telos is the de facto persistent home');
    await chat.startChat({ send: () => {}, isOpen: () => true }, 'cold-child-ui', 'continue', {
      cwd: root,
      accountId: 'personal',
      model: 'luna',
      accountProfiles: profiles,
      resume: id,
      clientMsgId: 'cold-child-prompt',
    });
    expect(opened?.systemPrompt).toContain('Outcome capture is optional.');
    expect(opened?.systemPrompt?.match(/Outcome capture is optional\./g)).toHaveLength(1);
    expect(opened?.systemPrompt).not.toContain('Telos is the de facto persistent home');
    expect(query).not.toHaveBeenCalled();
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('connects trusted contributor observers to the real ordinary query loop and exact child identity', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-contributor-query-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ boot: { tokens: 1, content: 'boot' } }))),
  );
  const chat = await import('../chat.js');
  const profiles = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Personal',
        provider: 'openai-codex',
        credentialRef: '/login',
        email: 'test@example.com',
        planType: 'test',
        models: [{ id: 'offline-luna', label: 'Offline fixture' }],
      },
    ],
    { codexEnabled: true },
  );
  const lifecycle = { beforeDispatch: vi.fn(), accepted: vi.fn(), terminal: vi.fn() };
  const ready = vi.fn();
  const result = vi.fn();
  const queryEvents = vi.fn();
  const childId = '5f68a371-73d1-4994-a512-b71d4bc44c66';
  const viewer = { send: vi.fn(), isOpen: () => true };
  const viewers = new ConnectionRegistry();
  viewers.register('child-viewer', viewer);
  viewers.watch('child-viewer', childId);
  chat.setConnectionRegistry(viewers);
  vi.mocked(openCodexChat).mockImplementation(async (options) => {
    expect(options.ordinaryTurnLifecycle).toBe(lifecycle);
    expect(options.contributorGuidance).toBe('Selected contributor guidance.');
    expect(options.conversationId).toBe(childId);
    return {
      interrupt: async () => {},
      setPermissionMode: async () => {},
      close: () => {},
      stopTask: async () => {
        throw new Error('Offline fixture has no subagents');
      },
      async *[Symbol.asyncIterator]() {
        options.ordinaryTurnLifecycle!.beforeDispatch('exact-recipient');
        options.ordinaryTurnLifecycle!.accepted('exact-recipient', 'raw-thread', 'raw-turn');
        yield { type: 'system', subtype: 'init', session_id: childId };
        yield {
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'reply-message' } },
        };
        yield {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        };
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Complete ' },
          },
        };
        // Viewing the child replaces its UI driver but must not replace the query observer.
        chat.registry.get('private-contributor-client')!.transport = viewer;
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'reply.' },
          },
        };
        yield { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } };
        options.ordinaryTurnLifecycle!.terminal('exact-recipient', 'raw-turn', 'completed');
        yield { type: 'result', session_id: childId, is_error: false };
      },
    };
  });
  try {
    await chat.startChat(
      { send: () => {}, isOpen: () => true },
      'private-contributor-client',
      'Exact selected excerpt.',
      {
        cwd: root,
        accountId: 'personal',
        model: 'offline-luna',
        accountProfiles: profiles,
        initialSessionId: childId,
        clientMsgId: 'exact-recipient',
        contributorGuidance: 'Selected contributor guidance.',
        retainWorkspace: true,
        ordinaryTurnLifecycle: lifecycle,
        onQueryReady: ready,
        onTurnResult: result,
        onQueryEvent: queryEvents,
      },
    );
    expect(ready).toHaveBeenCalledOnce();
    expect(result).toHaveBeenCalledOnce();
    expect(
      queryEvents.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === 'block_delta'),
    ).toEqual([
      expect.objectContaining({ sessionId: childId, delta: 'Complete ' }),
      expect.objectContaining({ sessionId: childId, delta: 'reply.' }),
    ]);
    expect(lifecycle.terminal).toHaveBeenCalledWith('exact-recipient', 'raw-turn', 'completed');
    expect(chat.eventStore.getSessionEvents(childId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'workspace_retention' })]),
    );
    expect(chat.registry.findBySessionId(childId)).toBeNull();
    expect(query).not.toHaveBeenCalled();
  } finally {
    viewers.remove('child-viewer');
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('routes API accounts through the referenced secret store without passing keys to child environments', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-api-dispatch-'));
  await writeFile(
    join(root, '.mitzo.json'),
    JSON.stringify({ venvPaths: ['notebooks/.venv/bin'] }),
  );
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('OPENAI_API_KEY', 'inherited-wrong-key');
  const hostFetch = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', hostFetch);
  const chat = await import('../chat.js');
  const ref = { provider: 'keychain', service: 'mitzo', account: 'work' };
  const profiles = new AccountProfiles([
    {
      id: 'work-api',
      label: 'Work',
      provider: 'openai',
      credentialRef: ref,
      sandboxProvider: 'openai-work',
      models: [{ id: 'test', label: 'Test' }],
    },
  ]);
  vi.mocked(openResponsesChat).mockRejectedValue(new Error('simulated API startup failure'));
  try {
    await chat.startChat({ send: () => {}, isOpen: () => true }, 'api-test', 'hello', {
      cwd: root,
      isolation: false,
      accountId: 'work-api',
      model: 'test',
      accountProfiles: profiles,
      initialSessionId: 'test-api-app',
    });
    expect(credentials.resolve).toHaveBeenCalledWith(ref);
    expect(openResponsesChat).toHaveBeenCalledOnce();
    const options = vi.mocked(openResponsesChat).mock.calls[0][0];
    expect(options.apiKey).toBe('private-work-key');
    expect(JSON.stringify(options.env)).not.toContain('private-work-key');
    expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(options.env.PATH).toBe(`${join(root, 'notebooks/.venv/bin')}:${process.env.PATH}`);
    expect(options.conversationId).toBe('test-api-app');
    await expect(chat.renameSessionById('test-api-app', 'Work task')).resolves.toBeUndefined();
    expect(chat.eventStore.getSession('test-api-app')?.summary).toBe('Work task');
    expect(query).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects an unsupported initial native reasoning level before opening the provider', async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-api-effort-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  const chat = await import('../chat.js');
  const profiles = new AccountProfiles([
    {
      id: 'work-api',
      label: 'Work',
      provider: 'openai',
      credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
      models: [{ id: 'test', label: 'Test', reasoningEfforts: ['low'] }],
    },
  ]);
  const events: Record<string, unknown>[] = [];
  try {
    await chat.startChat(
      { send: (event) => events.push(event), isOpen: () => true },
      'invalid-effort',
      'hello',
      {
        cwd: root,
        isolation: false,
        accountId: 'work-api',
        model: 'test',
        reasoningEffort: 'high',
        accountProfiles: profiles,
        initialSessionId: 'invalid-effort-app',
      },
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', error: expect.stringMatching(/thinking/i) }),
    );
    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(openResponsesChat).not.toHaveBeenCalled();
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('restores the persisted native model and reasoning level on a field-less cold resume', async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-api-resume-selection-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  const chat = await import('../chat.js');
  const profiles = new AccountProfiles([
    {
      id: 'work-api',
      label: 'Work',
      provider: 'openai',
      credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
      models: [
        { id: 'original', label: 'Original', reasoningEfforts: ['low'] },
        { id: 'selected', label: 'Selected', reasoningEfforts: ['high'] },
      ],
    },
  ]);
  const sessionId = 'persisted-native-selection';
  chat.eventStore.upsertSession({
    sessionId,
    cwd: root,
    mode: 'agent',
    accountBinding: profiles.resolve('work-api', 'original'),
    selectedModel: 'selected',
    reasoningEffort: 'high',
  });
  vi.mocked(openResponsesChat).mockRejectedValue(new Error('stop after selection capture'));
  try {
    await chat.startChat({ send: () => {}, isOpen: () => true }, 'resume-selection', 'continue', {
      resume: sessionId,
      cwd: root,
      isolation: false,
      accountProfiles: profiles,
    });
    expect(openResponsesChat).toHaveBeenCalledOnce();
    expect(vi.mocked(openResponsesChat).mock.calls[0][0]).toMatchObject({
      selectedModel: 'selected',
      reasoningEffort: 'high',
    });
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('clears persisted reasoning when a cold resume explicitly changes native models', async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-api-resume-model-switch-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  const chat = await import('../chat.js');
  const profiles = new AccountProfiles([
    {
      id: 'work-api',
      label: 'Work',
      provider: 'openai',
      credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
      models: [
        { id: 'reasoning-model', label: 'Reasoning', reasoningEfforts: ['high'] },
        { id: 'plain-model', label: 'Plain' },
      ],
    },
  ]);
  const sessionId = 'persisted-native-model-switch';
  chat.eventStore.upsertSession({
    sessionId,
    cwd: root,
    mode: 'agent',
    accountBinding: profiles.resolve('work-api', 'reasoning-model'),
    selectedModel: 'reasoning-model',
    reasoningEffort: 'high',
  });
  vi.mocked(openResponsesChat).mockRejectedValue(new Error('stop after selection capture'));
  try {
    await chat.startChat(
      { send: () => {}, isOpen: () => true },
      'resume-model-switch',
      'continue',
      {
        resume: sessionId,
        cwd: root,
        isolation: false,
        accountId: 'work-api',
        model: 'plain-model',
        accountProfiles: profiles,
      },
    );
    expect(openResponsesChat).toHaveBeenCalledOnce();
    expect(vi.mocked(openResponsesChat).mock.calls[0][0]).toMatchObject({
      selectedModel: 'plain-model',
      reasoningEffort: null,
    });
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('routes API accounts through OpenShell by default without resolving host credentials', async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-openshell-api-dispatch-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_WORKDIR', '/sandbox/workspaces/wrong-legacy-override');
  const hostFetch = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', hostFetch);
  const chat = await import('../chat.js');
  const profiles = new AccountProfiles([
    {
      id: 'work-api',
      label: 'Work',
      provider: 'openai',
      credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
      sandboxProvider: 'openai-work',
      models: [{ id: 'test', label: 'Test' }],
    },
  ]);
  vi.mocked(openCodexChat).mockImplementation(async (options) => {
    options.onBootContext?.({
      type: 'boot_context',
      scope: 'sandbox',
      sourceCount: 1,
      tokenCount: 2,
      tokenBudget: 12000,
      sources: [{ path: 'AGENTS.md', kind: 'instructions' }],
      included: [],
      trimmed: [],
      fullMarkdown: '# Sandbox context',
    });
    throw new Error('simulated OpenShell startup failure');
  });
  try {
    await chat.startChat({ send: () => {}, isOpen: () => true }, 'openshell-api', 'hello', {
      accountId: 'work-api',
      model: 'test',
      accountProfiles: profiles,
      initialSessionId: 'openshell-api-app',
    });
    expect(credentials.resolve).not.toHaveBeenCalled();
    // The remaining request loads UI agent metadata; the second host request
    // that previously fetched boot context must not occur for OpenShell.
    expect(hostFetch).toHaveBeenCalledTimes(1);
    expect(openResponsesChat).not.toHaveBeenCalled();
    expect(openCodexChat).toHaveBeenCalledOnce();
    expect(createWorktree).not.toHaveBeenCalled();
    expect(registerSession).not.toHaveBeenCalled();
    expect(capturePromptComparison).not.toHaveBeenCalled();
    const options = vi.mocked(openCodexChat).mock.calls[0][0];
    expect(options.profile.planType).toBe('api');
    expect(options.profile.sandboxProvider).toBe('openai-work');
    expect(options.session.cwd).toBe('/sandbox/workspaces/mgmt');
    expect(options.session.cwd).not.toContain('wrong-legacy-override');
    expect(options.systemPrompt).toContain('/sandbox/workspaces/mgmt');
    expect(options.systemPrompt).not.toContain(root);
    expect(chat.eventStore.getSession('openshell-api-app')?.bootContext).toContain(
      '"source":"sandbox"',
    );
    expect(chat.eventStore.getSession('openshell-api-app')?.cwd).toBe('/sandbox/workspaces/mgmt');
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('routes an explicitly broker-bound ChatGPT subscription without reading a host login', async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-openshell-subscription-dispatch-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  const chat = await import('../chat.js');
  const profiles = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Personal ChatGPT',
        provider: 'openai-codex',
        email: 'person@example.test',
        planType: 'pro',
        sandboxProvider: 'personal-chatgpt',
        sandboxProviderType: 'openai-codex-oauth',
        sandboxProviderId: 'provider-object-1',
        sandboxGrantId: 'grant-generation-1',
        models: [{ id: 'gpt-test', label: 'GPT test' }],
      },
    ],
    { codexEnabled: true },
  );
  vi.mocked(openCodexChat).mockRejectedValue(new Error('simulated brokered startup failure'));
  try {
    await chat.startChat({ send: () => {}, isOpen: () => true }, 'subscription', 'hello', {
      accountId: 'personal',
      model: 'gpt-test',
      accountProfiles: profiles,
      initialSessionId: 'subscription-app',
      images: [{ data: 'aGVsbG8=', mediaType: 'image/png' }],
    });
    expect(openCodexChat).toHaveBeenCalledOnce();
    expect(codexLaunch).not.toHaveBeenCalled();
    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(vi.mocked(openCodexChat).mock.calls[0][0].profile).toMatchObject({
      planType: 'pro',
      sandboxProviderType: 'openai-codex-oauth',
      sandboxProviderId: 'provider-object-1',
      sandboxGrantId: 'grant-generation-1',
    });
    expect(vi.mocked(openCodexChat).mock.calls[0][0].images).toEqual([
      { data: 'aGVsbG8=', mediaType: 'image/png' },
    ]);
    expect(chat.eventStore.getSession('subscription-app')?.accountBinding).toEqual(
      profiles.resolve('personal', 'gpt-test'),
    );
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps Vertex on its native route when OpenShell is enabled', async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-openshell-unsupported-'));
  await writeFile(
    join(root, '.mitzo.json'),
    JSON.stringify({ venvPaths: ['notebooks/.venv/bin'] }),
  );
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  const chat = await import('../chat.js');
  const profiles = new AccountProfiles([
    {
      id: 'vertex',
      label: 'Vertex',
      provider: 'google-vertex',
      projectId: 'synthetic',
      region: 'global',
      credentialRef: '/must/not/be/read.json',
      models: [{ id: 'gemini-test', label: 'Gemini test' }],
    },
  ]);
  vi.mocked(openResponsesChat).mockRejectedValue(new Error('stop after native routing'));
  try {
    await chat.startChat({ send: () => {}, isOpen: () => true }, 'vertex-native', 'hello', {
      cwd: root,
      isolation: false,
      accountId: 'vertex',
      model: 'gemini-test',
      accountProfiles: profiles,
    });
    expect(openResponsesChat).toHaveBeenCalledOnce();
    expect(vi.mocked(openResponsesChat).mock.calls[0][0].gemini).toMatchObject({
      accountId: 'vertex',
      projectId: 'synthetic',
      region: 'global',
    });
    expect(vi.mocked(openResponsesChat).mock.calls[0][0].env.PATH).toBe(
      `${join(root, 'notebooks/.venv/bin')}:${process.env.PATH}`,
    );
    expect(openCodexChat).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('can bypass OpenShell for API accounts during a proxy incident', async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-openshell-api-bypass-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_OPENAI_API_ENABLED', '0');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  const chat = await import('../chat.js');
  const profiles = new AccountProfiles([
    {
      id: 'work-api',
      label: 'Work',
      provider: 'openai',
      credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
      sandboxProvider: 'openai-work',
      models: [{ id: 'test', label: 'Test' }],
    },
  ]);
  vi.mocked(openResponsesChat).mockRejectedValue(new Error('stop after native routing'));
  try {
    await chat.startChat({ send: () => {}, isOpen: () => true }, 'api-native', 'hello', {
      cwd: root,
      isolation: false,
      accountId: 'work-api',
      model: 'test',
      accountProfiles: profiles,
    });
    expect(credentials.resolve).toHaveBeenCalledOnce();
    expect(openResponsesChat).toHaveBeenCalledOnce();
    expect(vi.mocked(openResponsesChat).mock.calls[0][0].apiKey).toBe('private-work-key');
    expect(openCodexChat).not.toHaveBeenCalled();
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects legacy OpenShell subscription routing before host credential preflight', async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-openshell-legacy-subscription-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'legacy-sandbox');
  const chat = await import('../chat.js');
  const profiles = new AccountProfiles(
    [
      {
        id: 'personal',
        label: 'Personal ChatGPT',
        provider: 'openai-codex',
        credentialRef: '/host/private/codex',
        email: 'test@example.com',
        planType: 'test',
        sandboxProvider: 'personal-chatgpt',
        models: [{ id: 'test-model', label: 'Test model' }],
      },
    ],
    { codexEnabled: true },
  );
  const send = vi.fn();
  try {
    await chat.startChat({ send, isOpen: () => true }, 'legacy-subscription', 'hello', {
      accountId: 'personal',
      model: 'test-model',
      accountProfiles: profiles,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', error: expect.stringContaining('brokered') }),
    );
    expect(codexLaunch).not.toHaveBeenCalled();
    expect(openCodexChat).not.toHaveBeenCalled();
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('fails closed for unbound legacy starts when OpenShell is enabled', async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-openshell-unbound-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  const chat = await import('../chat.js');
  const send = vi.fn();
  try {
    await chat.startChat({ send, isOpen: () => true }, 'unbound', 'hello', {
      cwd: root,
      isolation: false,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        error: expect.stringContaining('explicit account selection'),
      }),
    );
    expect(query).not.toHaveBeenCalled();
    expect(openResponsesChat).not.toHaveBeenCalled();
    expect(openCodexChat).not.toHaveBeenCalled();
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getAccessToken() {
      return 'private-google-token';
    }
  },
}));
it('routes a Gemini account to native chat with its own token source and resumable application identity', async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-gemini-dispatch-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/wrong/inherited-adc.json');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  const chat = await import('../chat.js');
  const profiles = new AccountProfiles([
    {
      id: 'google-work',
      label: 'Work Gemini',
      provider: 'google-vertex',
      projectId: 'work-project',
      region: 'global',
      credentialRef: '/work/adc.json',
      models: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }],
    },
  ]);
  vi.mocked(openResponsesChat).mockRejectedValue(new Error('simulated native startup failure'));
  try {
    await chat.startChat({ send: () => {}, isOpen: () => true }, 'gemini-test', 'hello', {
      cwd: root,
      isolation: false,
      accountId: 'google-work',
      model: 'gemini-3.8-flash',
      accountProfiles: profiles,
      initialSessionId: 'gemini-app',
    });
    const opts = vi.mocked(openResponsesChat).mock.calls[0][0];
    expect(opts.gemini).toMatchObject({
      accountId: 'google-work',
      projectId: 'work-project',
      region: 'global',
    });
    expect(await opts.gemini!.getAccessToken()).toBe('private-google-token');
    expect(opts.apiKey).toBeUndefined();
    expect(opts.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    expect(chat.eventStore.getSession('gemini-app')?.accountBinding).toEqual(
      profiles.resolve('google-work', 'gemini-3.8-flash'),
    );
    await chat.startChat({ send: () => {}, isOpen: () => true }, 'gemini-resume', 'continue', {
      cwd: root,
      isolation: false,
      resume: 'gemini-app',
      accountProfiles: profiles,
    });
    expect(vi.mocked(openResponsesChat).mock.calls[1][0].conversationId).toBe('gemini-app');
    await expect(chat.renameSessionById('gemini-app', 'Gemini task')).resolves.toBeUndefined();
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['contexgin', 'slow-contexgin', 'slow-fallback'] as const)(
  'delivers %s boot context to Work API instructions and persists the same bundle on startup and cold resume',
  async (source) => {
    vi.resetModules();
    vi.clearAllMocks();
    const root = await mkdtemp(join(tmpdir(), 'mitzo-api-boot-'));
    const markdown = '# Profile\nThe user works on RHOAI.\n# Tone\nUse a direct tone.';
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    // No provider or live account is contacted. Only boot compilation is delayed.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (source === 'slow-fallback') throw new Error('ECONNREFUSED');
        if (source === 'slow-contexgin') await new Promise((resolve) => setTimeout(resolve, 2200));
        return new Response(
          JSON.stringify({
            boot: {
              content: markdown,
              tokens: 20,
              tokenBudget: 12000,
              sources: ['profile.md'],
            },
          }),
        );
      }),
    );
    if (source === 'slow-fallback') {
      await mkdir(join(root, 'scripts'));
      await writeFile(
        join(root, 'scripts/build_boot_context.py'),
        `import time\nimport json\ntime.sleep(2.2)\nprint(json.dumps({'additionalContext': ${JSON.stringify(markdown)}}))\n`,
      );
    }
    const profiles = new AccountProfiles([
      {
        id: 'work-api',
        label: 'Work API',
        provider: 'openai',
        credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
        models: [{ id: 'test', label: 'Offline test' }],
      },
    ]);
    vi.mocked(openResponsesChat).mockRejectedValue(new Error('offline provider boundary'));
    const chat = await import('../chat.js');
    const sessionId = `api-boot-${source}`;
    try {
      for (const resume of [false, true]) {
        const send = vi.fn();
        await chat.startChat({ send, isOpen: () => true }, `boot-${source}-${resume}`, 'hello', {
          cwd: root,
          isolation: false,
          accountId: 'work-api',
          model: 'test',
          accountProfiles: profiles,
          ...(resume ? { resume: sessionId } : { initialSessionId: sessionId }),
          clientMsgId: `message-${resume}`,
        });
        const opened = vi.mocked(openResponsesChat).mock.calls.at(-1)?.[0];
        expect(opened?.systemPrompt).toContain(`# Boot Context\n${markdown}`);
        const saved = JSON.parse(chat.eventStore.getSession(sessionId)!.bootContext!);
        expect(saved.fullMarkdown).toBe(markdown);
        expect(saved.source).toBe(source === 'slow-fallback' ? 'local-fallback' : 'contexgin');
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'boot_context',
            fullMarkdown: markdown,
            sessionId,
          }),
        );
        expect(opened?.binding.accountId).toBe('work-api');
        expect(JSON.stringify(opened?.env)).not.toContain('private-work-key');
      }
      expect(openResponsesChat).toHaveBeenCalledTimes(2);
    } finally {
      chat.registry.dispose();
      chat.eventStore.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
