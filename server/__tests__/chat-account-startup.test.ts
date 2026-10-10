import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../account-profiles.js';
import { createHash } from 'node:crypto';
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
vi.mock('../mcp-config.js', () => ({ loadMcpServers: vi.fn(() => ({})) }));
vi.mock('../auto-rename.js', async (original) => ({
  ...(await original<object>()),
  shouldAutoRename: () => false,
}));
vi.mock('../hook-bridge.js', async (original) => ({
  ...(await original<object>()),
  loadProjectHooks: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('delivers the exact dated briefing snapshot to the mocked Codex provider and durable user history', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-source-provider-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ boot: {} }))),
  );
  const profiles = new AccountProfiles(
    [
      {
        id: 'work',
        label: 'OpenAI Work fixture',
        provider: 'openai-codex',
        credentialRef: '/test/codex',
        email: 'fixture@example.com',
        planType: 'pro',
        models: [{ id: 'luna', label: 'Luna fixture' }],
      },
    ],
    { codexEnabled: true },
  );
  const account = await import('../codex-account.js');
  vi.spyOn(account, 'verifyCodexAccount').mockResolvedValue(
    profiles.resolve('work', 'luna') as never,
  );
  const { CodexAppServerClient } = await import('../codex-app-server-client.js');
  vi.spyOn(CodexAppServerClient, 'launch').mockReturnValue({
    initialize: async () => {},
    close: vi.fn(),
  } as never);
  const codex = await import('../codex-chat-session.js');
  const open = vi
    .spyOn(codex, 'openCodexChat')
    .mockRejectedValue(new Error('Mocked provider captured input; do not start a real model'));
  const chat = await import('../chat.js');
  const content =
    '# Morning briefing\n## 09:30 Meeting\n' +
    'Source detail\n'.repeat(9000) +
    'Final detail beyond 100 KB';
  const snapshot = {
    kind: 'briefing' as const,
    date: '2026-10-09',
    revision: createHash('sha256').update(content).digest('hex'),
    content,
  };
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-343434343434';
  try {
    await chat.startChat(
      { send: () => {}, isOpen: () => true },
      'source-provider',
      'Discuss the saved report',
      {
        cwd: root,
        isolation: false,
        accountId: 'work',
        model: 'luna',
        accountProfiles: profiles,
        initialSessionId: sessionId,
        clientMsgId: 'source-message',
        sourceSnapshots: [snapshot],
      },
    );
    expect(open).toHaveBeenCalledOnce();
    const actual = open.mock.calls[0][0].prompt;
    expect(actual.includes(content)).toBe(true);
    expect(actual).toContain(snapshot.revision);
    expect(actual).toContain(snapshot.date);
    expect(actual).toContain('Discuss the saved report');
    const user = chat.eventStore
      .getSessionEvents(sessionId)
      .find((event) => event.type === 'user_message');
    expect(user?.payload.sourceSnapshots).toEqual([snapshot]);
    expect(user?.payload.text).toBe('Discuss the saved report');
    const restored = await chat.getMessages(sessionId);
    expect(restored.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(restored[0].sourceSnapshots).toEqual([snapshot]);
    expect(restored[0].blocks[0].content).toBe('Discuss the saved report');
    open.mockClear();
    const rejectedTransport = { send: vi.fn(), isOpen: () => true };
    const rejected = await chat
      .startChat(rejectedTransport, 'invalid-source-provider', 'Discuss', {
        cwd: root,
        isolation: false,
        accountId: 'work',
        model: 'luna',
        accountProfiles: profiles,
        sourceSnapshots: [{ ...snapshot, content: 'Changed source with an old revision' }],
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(open).not.toHaveBeenCalled();
    const reported =
      rejected instanceof Error
        ? rejected.message
        : rejectedTransport.send.mock.calls.map(([event]) => String(event.error ?? '')).join(' ');
    expect(reported).toMatch(/revision/);
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'pins Library guidance and skill limits before offline SDK dispatch (resume=%s)',
  async (resume) => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'mitzo-library-startup-'));
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ boot: {} }))),
    );
    const { createHash } = await import('node:crypto');
    const definition = {
      name: 'Bob',
      descriptor: 'The architect',
      role: 'agent',
      instructions: 'Challenge architecture assumptions.',
      expectedOutput: 'Decision brief',
      acceptanceCriteria: ['Use evidence'],
      modelPolicyRole: 'agent',
    };
    const snapshot = {
      profileId: 'bob',
      revision: 3,
      definition,
      contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    };
    const transport = await import('../agent-library-transport.js');
    const read = vi.spyOn(transport, 'readAgentLibraryProfile').mockResolvedValue(snapshot);
    const chat = await import('../chat.js');
    const existingId = 'aaaaaaaa-bbbb-4ccc-8ddd-343434343434';
    if (resume)
      chat.eventStore.upsertSession({ sessionId: existingId, cwd: root, agentProfile: snapshot });
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    let dispatched = false;
    let permissionCheck: Promise<unknown> | undefined;
    vi.mocked(query).mockImplementation((args) => {
      expect(args.options?.systemPrompt).toMatchObject({
        append: expect.stringContaining('Bob · The architect'),
      });
      expect(args.options?.systemPrompt).toMatchObject({
        append: expect.stringContaining('Challenge architecture assumptions.'),
      });
      expect(
        chat.eventStore.getSession(args.options!.resume ?? args.options!.sessionId!)?.agentProfile,
      ).toEqual(snapshot);
      permissionCheck = Promise.resolve(
        args.options!.canUseTool!(
          'Bash',
          { command: 'pwd' },
          {
            signal: new AbortController().signal,
            toolUseID: 'restricted-call',
          },
        ),
      );
      dispatched = true;
      throw Error('Offline SDK dispatch intercepted');
    });
    try {
      await chat.startChat({ send: () => {}, isOpen: () => true }, 'library-startup', 'hello', {
        cwd: root,
        isolation: false,
        model: 'luna',
        mode: 'auto',
        skillAllowedTools: ['Read'],
        ...(resume ? { resume: existingId } : { agentProfile: { profileId: 'bob', revision: 3 } }),
        operatorConnectionId: 'verified-transport',
      });
      expect(dispatched).toBe(true);
      if (!resume)
        expect(read).toHaveBeenCalledWith({ profileId: 'bob', revision: 3 }, 'verified-transport');
      else expect(read).not.toHaveBeenCalled();
      await expect(permissionCheck).resolves.toMatchObject({ behavior: 'deny' });
    } finally {
      read.mockRestore();
      chat.eventStore.close();
      chat.registry.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
it('links a startup error to safe logged diagnostics and the saved session', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-startup-error-reference-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ boot: {} }))),
  );
  const logger = await import('../logger.js');
  const logError = vi.fn();
  vi.spyOn(logger, 'createLogger').mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: logError,
  });
  const { CodexStartupError } = await import('../codex-startup-error.js');
  const failure = new CodexStartupError(
    'sandbox_preparation',
    Object.assign(new Error('ssh PRIVATE_COMMAND Bearer sk-secret'), { code: 'ENOSPC' }),
  );
  const codex = await import('../codex-chat-session.js');
  vi.spyOn(codex, 'openCodexChat').mockRejectedValue(failure);
  const { CodexAppServerClient } = await import('../codex-app-server-client.js');
  vi.spyOn(CodexAppServerClient, 'launch').mockReturnValue({
    initialize: async () => {},
    close: vi.fn(),
  } as never);
  const account = await import('../codex-account.js');
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
  vi.spyOn(account, 'verifyCodexAccount').mockResolvedValue(
    profiles.resolve('personal', 'luna') as never,
  );
  const chat = await import('../chat.js');
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-121212121212';
  const send = vi.fn();
  const onStartupAdmission = vi.fn();
  try {
    await chat.startChat({ send, isOpen: () => true }, 'error-reference', 'hello', {
      cwd: root,
      isolation: false,
      accountId: 'personal',
      model: 'luna',
      accountProfiles: profiles,
      initialSessionId: sessionId,
      onStartupAdmission,
    });
    const errors = send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === 'error');
    expect(errors).toEqual([
      expect.objectContaining({
        sessionId,
        error: expect.stringContaining(failure.diagnosticId),
      }),
    ]);
    expect(logError).toHaveBeenCalledWith(
      'startChat failed after register, cleaning up',
      expect.objectContaining({
        sessionId,
        startupPhase: 'sandbox_preparation',
        startupErrorCode: 'ENOSPC',
        diagnosticId: failure.diagnosticId,
      }),
    );
    expect(JSON.stringify([errors, logError.mock.calls])).not.toMatch(
      /PRIVATE_COMMAND|sk-secret|queued work/,
    );
    expect(onStartupAdmission).toHaveBeenCalledOnce();
    const admittedError = onStartupAdmission.mock.calls[0][0];
    expect(admittedError.message).toContain(failure.diagnosticId);
    expect(admittedError.stack).not.toMatch(/PRIVATE_COMMAND|sk-secret/);
    expect(admittedError.cause).toBeUndefined();
    expect(chat.registry.get('error-reference')).toBeUndefined();
    expect(chat.eventStore.getSession(sessionId)?.state).toBe('ENDED');
  } finally {
    vi.restoreAllMocks();
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects unregistered and internal resumes before provider dispatch', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-owned-resume-'));
  vi.stubEnv('REPO_PATH', root);
  const chat = await import('../chat.js');
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  vi.mocked(query).mockClear();
  chat.eventStore.upsertSession({ sessionId: 'parent' });
  chat.eventStore.registerInternalSdkExecution({
    sdkSessionId: 'helper',
    parentSessionId: 'parent',
    operationId: 'tool-call',
    purpose: 'web_search',
    cwd: '/private/sdk-tools/helper',
  });
  try {
    for (const id of ['unknown', 'helper'])
      await expect(
        chat.startChat({ send() {}, isOpen: () => true }, 'invalid-resume', 'continue', {
          resume: id,
        }),
      ).rejects.toThrow(/import|conversation/i);
    expect(query).not.toHaveBeenCalled();
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('sanitizes typed host account preflight errors before session registration', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-preflight-diagnostic-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  const chat = await import('../chat.js');
  const { CodexAppServerClient, CodexRequestError } = await import('../codex-app-server-client.js');
  const account = await import('../codex-account.js');
  const close = vi.fn();
  vi.spyOn(CodexAppServerClient, 'launch').mockReturnValue({
    initialize: async () => {},
    close,
  } as never);
  const verify = vi
    .spyOn(account, 'verifyCodexAccount')
    .mockRejectedValue(new CodexRequestError('account/read', 'routing_unauthorized', 401));
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
  const send = vi.fn();
  try {
    await chat.startChat({ send, isOpen: () => true }, 'preflight-error', 'hello', {
      cwd: root,
      isolation: false,
      accountId: 'personal',
      model: 'luna',
      accountProfiles: profiles,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        error: expect.stringMatching(/workspace routing/),
      }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(chat.registry.get('preflight-error')).toBeUndefined();
  } finally {
    verify.mockRestore();
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
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
      expect(chat.registry.get('binding-test')?.accountBinding).toEqual(
        profiles.resolve('work', 'claude-sonnet-4-6'),
      );
      expect(args.options?.allowedTools).toContain('mcp__mitzo-web-access__RequestWebAccess');
      expect(args.options?.mcpServers?.['mitzo-web-access']).toMatchObject({
        type: 'sdk',
        name: 'mitzo-web-access',
      });
      expect(args.options?.disallowedTools).toEqual(['WebSearch', 'WebFetch']);
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

it('confines protected SDK sessions and excludes configured MCPs and parent project hooks in Auto mode', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-sdk-protected-start-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '1');
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_DIR', join(root, 'private'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  const { loadMcpServers } = await import('../mcp-config.js');
  vi.mocked(loadMcpServers).mockReturnValue({
    dangerous: { command: '/bin/sh', args: ['-c', 'cat private/controller.json'] },
  });
  const chat = await import('../chat.js');
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { loadProjectHooks } = await import('../hook-bridge.js');
  vi.mocked(loadProjectHooks).mockClear();
  let inspected = false;
  vi.mocked(query).mockImplementation(({ options }) => {
    expect(options?.spawnClaudeCodeProcess).toBeTypeOf('function');
    expect(options?.settingSources).toEqual([]);
    expect(options?.strictMcpConfig).toBe(true);
    expect(options?.mcpServers).not.toHaveProperty('dangerous');
    expect(options?.allowedTools).not.toContain('mcp__dangerous__*');
    expect(options?.mcpServers).toHaveProperty('mitzo-connections');
    expect(options?.permissionMode).toBe('default');
    inspected = true;
    throw new Error('fixture stops before any model request');
  });
  try {
    await chat.startChat({ send: () => {}, isOpen: () => true }, 'protected-sdk', 'hello', {
      cwd: root,
      isolation: false,
      mode: 'auto',
    });
    expect(inspected).toBe(true);
    expect(loadProjectHooks).not.toHaveBeenCalled();
  } finally {
    vi.mocked(loadMcpServers).mockReturnValue({});
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('retains project hooks, settings, configured MCPs and legacy boot context under a runtime-only SDK fence', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-sdk-runtime-only-start-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '0');
  vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', join(root, 'operator-enrollment.json'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
  const { loadMcpServers } = await import('../mcp-config.js');
  vi.mocked(loadMcpServers).mockReturnValue({
    project: { command: '/bin/echo', args: ['synthetic MCP'] },
  });
  const { loadProjectHooks } = await import('../hook-bridge.js');
  vi.mocked(loadProjectHooks).mockClear();
  const projectHooks = { SessionStart: [{ hooks: [vi.fn()] }] };
  vi.mocked(loadProjectHooks).mockReturnValue(projectHooks as never);
  const boundary = await import('../credential-sdk-boundary.js');
  const protectedCommands = await import('../protected-sdk-command.js');
  const projectRunner = vi.fn().mockResolvedValue({
    stdout: '{"additionalContext":"synthetic local boot context"}',
    stderr: '',
  });
  const runnerFactory = vi
    .spyOn(protectedCommands, 'createWorkspaceRuntimeCommandRunner')
    .mockReturnValue(projectRunner);
  const outerSpawn = vi.fn();
  const fence = vi.spyOn(boundary, 'credentialSdkBoundary').mockReturnValue({
    credentialIsolation: false,
    deniedRoots: [],
    spawnClaudeCodeProcess: outerSpawn,
  });
  await mkdir(join(root, 'scripts'));
  await writeFile(
    join(root, 'scripts', 'build_boot_context.py'),
    `print('{"additionalContext":"synthetic local boot context"}')\n`,
  );
  const send = vi.fn();
  const chat = await import('../chat.js');
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let inspected = false;
  vi.mocked(query).mockImplementation(({ options }) => {
    expect(options?.spawnClaudeCodeProcess).toBe(outerSpawn);
    expect(options?.settingSources).toEqual(['project']);
    expect(options?.strictMcpConfig).toBeUndefined();
    expect(options?.mcpServers).toHaveProperty('project');
    expect(options?.allowedTools).toContain('mcp__project__*');
    expect(options?.hooks?.SessionStart).toBe(projectHooks.SessionStart);
    inspected = true;
    throw new Error('fixture stops before any model request');
  });
  try {
    await chat.startChat({ send, isOpen: () => true }, 'runtime-only-sdk', 'hello', {
      cwd: root,
      isolation: false,
      mode: 'auto',
    });
    expect(inspected).toBe(true);
    expect(loadProjectHooks).toHaveBeenCalledWith(root, expect.any(Object), projectRunner);
    expect(projectRunner).toHaveBeenCalledWith(
      'python3',
      [join(root, 'scripts', 'build_boot_context.py'), '--json'],
      expect.objectContaining({ cwd: root, timeout: 5000 }),
    );
    expect(send.mock.calls.map(([message]) => message)).toContainEqual(
      expect.objectContaining({
        type: 'boot_context',
        fullMarkdown: 'synthetic local boot context',
      }),
    );
    expect(outerSpawn).not.toHaveBeenCalled();
  } finally {
    fence.mockRestore();
    runnerFactory.mockRestore();
    vi.mocked(loadProjectHooks).mockReturnValue(undefined);
    vi.mocked(loadMcpServers).mockReturnValue({});
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});
