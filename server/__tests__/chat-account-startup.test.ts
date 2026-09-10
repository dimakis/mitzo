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
