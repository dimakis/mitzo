import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../account-profiles.js';
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: vi.fn(),
}));
vi.mock('../session-index.js', async (original) => ({
  ...(await original<object>()),
  registerSession: vi.fn(),
}));
vi.mock('../prompt-compare.js', () => ({
  capturePromptComparison: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it.each([
  ['agent', 'ask', 'plan'],
  ['ask', 'agent', 'default'],
] as const)(
  'persists binding and boot context and applies startup mode change %s → %s',
  async (initialMode, updatedMode, sdkMode) => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'mitzo-account-start-'));
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        chat.registry.setMode('binding-test', updatedMode);
        return new Response(JSON.stringify({ boot: { tokens: 1, fullMarkdown: 'boot evidence' } }));
      }),
    );
    const chat = await import('../chat.js');
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const profiles = new AccountProfiles([
      {
        id: 'work',
        label: 'Work',
        provider: 'anthropic-vertex',
        projectId: 'test-project',
        region: 'us-east5',
        credentialRef: '/test/adc.json',
        models: [{ id: 'claude-sonnet-4-6', label: 'Sonnet' }],
      },
    ]);
    let sdkId: string | undefined;
    let persistedBeforeQuery = false;
    vi.mocked(query).mockImplementation((args) => {
      expect(args.options?.permissionMode).toBe(sdkMode);
      sdkId = args.options?.sessionId;
      if (!sdkId) throw new Error('missing preallocated ID');
      const meta = chat.eventStore.getSession(sdkId);
      expect(meta?.accountBinding).toEqual(profiles.resolve('work', 'claude-sonnet-4-6'));
      expect(meta?.bootContext).toBeTruthy();
      expect(meta?.mode).toBe(updatedMode);
      persistedBeforeQuery = true;
      throw new Error('simulated process failure before first SDK event');
    });
    try {
      await chat.startChat({ send: () => {}, isOpen: () => true }, 'binding-test', 'hello', {
        cwd: root,
        isolation: false,
        mode: initialMode,
        accountId: 'work',
        model: 'claude-sonnet-4-6',
        accountProfiles: profiles,
      });
      expect(persistedBeforeQuery).toBe(true);
      expect(sdkId).toMatch(/^[0-9a-f-]{36}$/);
      expect(chat.eventStore.getSession(sdkId!)?.accountBinding?.accountId).toBe('work');
      expect(chat.eventStore.getSession(sdkId!)?.state).toBe('ENDED');
      expect(chat.eventStore.getSession(sdkId!)?.isActive).toBe(false);
    } finally {
      chat.eventStore.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  'restores authoritative resume mode when no server mode was supplied (live=%s)',
  async (live) => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'mitzo-resume-mode-'));
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(JSON.stringify({ boot: { tokens: 1, fullMarkdown: 'boot evidence' } })),
        ),
    );
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    const chat = await import('../chat.js');
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const profiles = new AccountProfiles([
      {
        id: 'work',
        label: 'Work',
        provider: 'anthropic-vertex',
        projectId: 'test-project',
        region: 'us-east5',
        credentialRef: '/test/adc.json',
        models: [{ id: 'claude-sonnet-4-6', label: 'Sonnet' }],
      },
    ]);
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    chat.eventStore.upsertSession({
      sessionId,
      cwd: root,
      mode: live ? 'auto' : 'ask',
      accountBinding: profiles.resolve('work', 'claude-sonnet-4-6'),
    });
    const transport = { send: () => {}, isOpen: () => true };
    if (live) {
      chat.registry.register('old-client', {
        transport,
        abortController: new AbortController(),
        mode: 'auto',
        sessionAllowList: new Set(),
      });
      const old = chat.registry.get('old-client')!;
      old.sessionId = sessionId;
      old.pendingPermissionModes = new Map([[Symbol('pending-ask'), 'ask']]);
    }
    let actualMode: string | undefined;
    vi.mocked(query).mockImplementation((args) => {
      actualMode = args.options?.permissionMode;
      throw new Error('stop after recording startup policy');
    });
    try {
      await chat.startChat(transport, 'resumed-client', 'continue', {
        resume: sessionId,
        cwd: root,
        isolation: false,
        accountId: 'work',
        model: 'claude-sonnet-4-6',
        accountProfiles: profiles,
      });
      expect(actualMode).toBe('plan');
    } finally {
      chat.registry.dispose();
      chat.eventStore.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('rejects a cold resume when its persisted Anthropic model left the account catalog', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-stale-anthropic-model-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  const chat = await import('../chat.js');
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  vi.mocked(query).mockClear();
  const profile = {
    id: 'work',
    label: 'Work',
    provider: 'anthropic-vertex' as const,
    projectId: 'test-project',
    region: 'us-east5',
    credentialRef: '/test/adc.json',
  };
  const oldProfiles = new AccountProfiles([
    {
      ...profile,
      models: [
        { id: 'claude-sonnet-4-6', label: 'Sonnet' },
        { id: 'claude-opus-4-6', label: 'Opus' },
      ],
    },
  ]);
  const currentProfiles = new AccountProfiles([
    { ...profile, models: [{ id: 'claude-sonnet-4-6', label: 'Sonnet' }] },
  ]);
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
  chat.eventStore.upsertSession({
    sessionId,
    cwd: root,
    accountBinding: oldProfiles.resolve('work', 'claude-sonnet-4-6'),
    selectedModel: 'claude-opus-4-6',
  });
  const sent: Record<string, unknown>[] = [];

  try {
    await chat.startChat(
      { send: (message) => sent.push(message), isOpen: () => true },
      'stale-anthropic-model',
      'continue',
      {
        resume: sessionId,
        cwd: root,
        isolation: false,
        accountProfiles: currentProfiles,
      },
    );
    expect(query).not.toHaveBeenCalled();
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.stringContaining('Model is unavailable'),
      }),
    );
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['cold', 'zombie-downgrade', 'zombie-aba', 'zombie-unchanged'] as const)(
  'uses the latest acknowledged permission after delayed account verification (%s)',
  async (scenario) => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'mitzo-delayed-resume-'));
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(JSON.stringify({ boot: { tokens: 1, fullMarkdown: 'boot evidence' } })),
        ),
    );
    const chat = await import('../chat.js');
    const { CodexAppServerClient } = await import('../codex-app-server-client.js');
    const account = await import('../codex-account.js');
    const codex = await import('../codex-chat-session.js');
    const revisions = await import('../session-permission-revision.js');
    const profiles = new AccountProfiles(
      [
        {
          id: 'personal',
          label: 'Personal',
          provider: 'openai-codex',
          credentialRef: '/test/codex',
          email: 'test@example.com',
          planType: 'pro',
          models: [{ id: 'luna', label: 'Luna' }],
        },
      ],
      { codexEnabled: true },
    );
    const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const binding = profiles.resolve('personal', 'luna');
    chat.eventStore.upsertSession({ sessionId, cwd: root, mode: 'auto', accountBinding: binding });
    const revision = revisions.permissionRevision(chat.eventStore, sessionId);
    let finish!: () => void;
    vi.spyOn(CodexAppServerClient, 'launch').mockReturnValue({
      initialize: async () => {},
      close: () => {},
    } as never);
    const verify = vi.spyOn(account, 'verifyCodexAccount').mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return binding;
    });
    let actualMode: string | undefined;
    vi.spyOn(codex, 'openCodexChat').mockImplementation(async (options) => {
      actualMode = options.session.mode;
      throw new Error('stop after recording startup policy');
    });
    try {
      const startup = chat.startChat(
        { send: () => {}, isOpen: () => true },
        'delayed-resume',
        'continue',
        {
          resume: sessionId,
          cwd: root,
          isolation: false,
          accountId: 'personal',
          model: 'luna',
          accountProfiles: profiles,
          mode: scenario === 'cold' ? 'auto' : 'ask',
          // Server only supplies this snapshot when replacing an old runtime.
          ...(scenario !== 'cold' ? { resumePermission: { mode: 'ask' as const, revision } } : {}),
        },
      );
      await vi.waitFor(() => expect(verify).toHaveBeenCalled());
      if (scenario !== 'zombie-unchanged') {
        chat.eventStore.upsertSession({ sessionId, mode: 'ask', updatedAt: 100 });
        revisions.recordPermissionChange(chat.eventStore, sessionId);
        if (scenario === 'zombie-aba') {
          chat.eventStore.upsertSession({ sessionId, mode: 'auto', updatedAt: 100 });
          revisions.recordPermissionChange(chat.eventStore, sessionId);
        }
      }
      finish();
      await startup;
      expect(actualMode).toBe(scenario === 'zombie-aba' ? 'auto' : 'ask');
      expect(chat.eventStore.getSession(sessionId)?.mode).toBe(actualMode);
    } finally {
      vi.restoreAllMocks();
      chat.registry.dispose();
      chat.eventStore.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('fences all ordinary startup and active-runtime entrypoints for Symposium sessions', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-symposium-fence-'));
  vi.stubEnv('REPO_PATH', root);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const chat = await import('../chat.js');
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  vi.mocked(query).mockClear();
  chat.eventStore.upsertSession({ sessionId: 'symposium' });
  chat.eventStore.setSymposiumConfig(
    'symposium',
    {
      version: 2,
      revision: 1,
      state: 'draft',
      anchorSeatId: 'primary',
      activeSeatCap: 3,
      seats: [
        {
          id: 'primary',
          name: 'Builder',
          role: 'coder',
          model: 'gpt-5.6-luna',
          systemPrompt: 'Build',
          color: '#335577',
        },
      ],
      turnRules: { mode: 'directed', maxTurns: 8 },
      interceptMode: 'manual',
    },
    0,
  );
  const transport = { send: vi.fn(), isOpen: () => true };
  try {
    for (const options of [{ resume: 'symposium' }, { initialSessionId: 'symposium' }])
      await expect(chat.startChat(transport, 'fenced', 'hello', options)).rejects.toThrow(
        'Symposium directed prompts',
      );
    const get = vi.spyOn(chat.registry, 'get').mockReturnValue({ sessionId: 'symposium' } as never);
    await expect(chat.sendToChat('fenced', 'hello')).rejects.toThrow('Symposium directed prompts');
    await expect(chat.interruptChat('fenced', 'hello')).rejects.toThrow(
      'Symposium directed prompts',
    );
    get.mockRestore();
    expect(fetch).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(chat.eventStore.getSessionEvents('symposium')).toEqual([]);
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('serializes paused ordinary resume and draft conversion in both orderings', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-conversion-race-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '0');
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', '');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const chat = await import('../chat.js');
  const { CodexAppServerClient } = await import('../codex-app-server-client.js');
  const { createSymposiumDirectorRouter } = await import('../symposium-director-routes.js');
  const express = (await import('express')).default;
  const request = (await import('supertest')).default;
  const accounts = new AccountProfiles(
    [
      {
        id: 'personal-race',
        label: 'Personal test',
        provider: 'openai-codex',
        credentialRef: '/mock/private-auth',
        email: 'personal@example.test',
        planType: 'plus',
        models: [{ id: 'gpt-5.6-luna', label: 'Luna' }],
      },
    ],
    { codexEnabled: true },
  );
  const binding = accounts.resolve('personal-race', 'gpt-5.6-luna');
  chat.eventStore.upsertSession({
    sessionId: 'convert-race',
    accountBinding: binding,
    isActive: false,
  });
  let rejectInitialize!: (reason: Error) => void;
  const initialization = new Promise<void>((_resolve, reject) => {
    rejectInitialize = reject;
  });
  const initialize = vi.fn(() => initialization);
  const launch = vi
    .spyOn(CodexAppServerClient, 'launch')
    .mockReturnValue({ initialize, close: vi.fn() } as never);
  const app = express();
  app.use(express.json());
  app.use(
    '/sessions/:id/symposium',
    createSymposiumDirectorRouter({ store: chat.eventStore, validateSelection: () => {} } as never),
  );
  const transport = { send: vi.fn(), isOpen: () => true };
  try {
    const startup = chat.startChat(transport, 'paused-resume', 'hello', {
      resume: 'convert-race',
      accountProfiles: accounts,
    });
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    // Paused in account verification: neither active-runtime nor durable executing checks cover it.
    expect(chat.eventStore.getSession('convert-race')?.isActive).toBe(false);
    expect(chat.registry.findBySessionId('convert-race')).toBeNull();
    const blocked = await request(app).post('/sessions/convert-race/symposium/draft').send({});
    expect(blocked.status).toBe(409);
    const configAttempt = await request(app)
      .put('/sessions/convert-race/symposium/config')
      .send({
        expectedRevision: 0,
        config: {
          version: 2,
          revision: 1,
          state: 'draft',
          anchorSeatId: 'primary',
          activeSeatCap: 3,
          seats: [
            {
              id: 'primary',
              name: 'Builder',
              role: 'coder',
              model: binding.model,
              accountBinding: binding,
              systemPrompt: 'Build',
              color: '#335577',
            },
          ],
          turnRules: { mode: 'directed', maxTurns: 8 },
          interceptMode: 'manual',
        },
      });
    expect(configAttempt.status).toBe(409);
    expect(configAttempt.body.error).toContain('Ordinary startup');
    expect(chat.eventStore.getSession('convert-race')?.symposiumConfig).toBeNull();
    rejectInitialize(new Error('Mock account verification cancelled'));
    await startup;
    // Reservation is released on failure; conversion succeeds, then the opposite ordering fences startup.
    expect(
      (await request(app).post('/sessions/convert-race/symposium/draft').send({})).status,
    ).toBe(200);
    await expect(
      chat.startChat(transport, 'after-conversion', 'hello', {
        resume: 'convert-race',
        accountProfiles: accounts,
      }),
    ).rejects.toThrow('Symposium directed prompts');
    expect(launch).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(chat.eventStore.getSessionEvents('convert-race')).toEqual([]);
  } finally {
    rejectInitialize(new Error('cleanup'));
    launch.mockRestore();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});
