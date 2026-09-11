import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AccountProfiles } from '../account-profiles.js';
import { openResponsesChat } from '../responses-chat-session.js';
import { credentials } from '../credentials.js';
import { openCodexChat } from '../codex-chat-session.js';
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
}));
vi.mock('../codex-app-server-client.js', () => ({
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
    });
    expect(id).toBe('5f68a371-73d1-4994-a512-b71d4bc44c65');
    expect(opened?.messageId).toBe('durable-next-prompt');
    expect(query).not.toHaveBeenCalled();
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('routes API accounts through the referenced secret store without passing keys to child environments', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-api-dispatch-'));
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
    expect(JSON.stringify(options.env)).not.toContain('key');
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

it('routes API accounts through OpenShell in production without resolving host credentials', async () => {
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
    expect(chat.eventStore.getSession('subscription-app')?.accountBinding).toEqual(
      profiles.resolve('personal', 'gpt-test'),
    );
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('fails closed for unsupported account providers when OpenShell is enabled', async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-openshell-unsupported-'));
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
  const send = vi.fn();
  try {
    await chat.startChat({ send, isOpen: () => true }, 'unsupported', 'hello', {
      cwd: root,
      isolation: false,
      accountId: 'vertex',
      model: 'gemini-test',
      accountProfiles: profiles,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        error: expect.stringContaining('does not yet support google-vertex'),
      }),
    );
    expect(openResponsesChat).not.toHaveBeenCalled();
    expect(openCodexChat).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
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
