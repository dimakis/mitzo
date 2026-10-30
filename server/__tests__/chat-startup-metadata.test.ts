import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../account-profiles.js';
const metadata = vi.hoisted(() => ({
  isGitDirectory: vi.fn(),
  readWorkspaceBranch: vi.fn(),
  readSshAuthSock: vi.fn(),
}));
vi.mock('../chat-metadata.js', () => metadata);
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getAccessToken() {
      return 'offline-google-token';
    }
  },
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: vi.fn(),
}));
vi.mock('../session-index.js', async (original) => ({
  ...(await original<object>()),
  registerSession: vi.fn(),
}));
vi.mock('../prompt-compare.js', () => ({ capturePromptComparison: vi.fn(async () => {}) }));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../hook-bridge.js', async (original) => ({
  ...(await original<object>()),
  loadProjectHooks: vi.fn(),
}));
vi.mock('../auto-rename.js', async (original) => ({
  ...(await original<object>()),
  shouldAutoRename: vi.fn(() => false),
}));
let root: string;
let chat: typeof import('../chat.js');
const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-343434343434';
const profiles = () =>
  new AccountProfiles([
    {
      id: 'work',
      label: 'Selected Vertex',
      provider: 'anthropic-vertex',
      projectId: 'fixture-project',
      region: 'us-east5',
      credentialRef: '/synthetic/selected.json',
      models: [{ id: 'claude-sonnet-4-6', label: 'Fixture' }],
    },
  ]);
beforeEach(async () => {
  vi.resetModules();
  root = await mkdtemp(join(tmpdir(), 'mitzo-metadata-startup-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ boot: {} }))),
  );
  metadata.isGitDirectory.mockReset().mockResolvedValue(true);
  metadata.readWorkspaceBranch.mockReset().mockResolvedValue('main');
  metadata.readSshAuthSock.mockReset().mockResolvedValue(null);
  chat = await import('../chat.js');
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  vi.mocked(query)
    .mockReset()
    .mockImplementation(() => {
      throw Error('Offline provider boundary');
    });
});
afterEach(async () => {
  chat?.registry.dispose();
  chat?.eventStore.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});
it.each(['branch', 'environment'] as const)(
  'cleans the original startup on cancellation during %s metadata',
  async (phase) => {
    const controller = new AbortController();
    const { AdviserTaskScope } = await import('../adviser-task-scope.js');
    const scope = new AdviserTaskScope(
      {
        authSessionId: 'operator',
        feature: { kind: 'agent-library' },
        accountId: 'work',
        model: 'claude-sonnet-4-6',
        instructions: 'Read reviewed input only',
        messages: [{ role: 'user', content: 'Review' }],
      },
      () => {},
      controller.signal,
    );
    scope.bindCommand(sessionId, 'command');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const changes = vi.fn();
    chat.setSessionChangeCallback(changes);
    let entered = false;
    const pending = (signal?: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        entered = true;
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      });
    if (phase === 'branch')
      metadata.readWorkspaceBranch.mockImplementation((_cwd, signal) => pending(signal));
    else metadata.readSshAuthSock.mockImplementation((signal) => pending(signal));
    const startup = chat
      .startChat({ send: () => {}, isOpen: () => true }, 'metadata-startup', 'Review', {
        initialSessionId: sessionId,
        clientMsgId: 'command',
        cwd: root,
        isolation: false,
        ...(phase === 'branch'
          ? {
              accountId: 'work',
              model: 'claude-sonnet-4-6',
              accountProfiles: profiles(),
              adviserScope: scope,
            }
          : {}),
      })
      .catch((error) => error);
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(chat.eventStore.getSession(sessionId)?.state).toBe('CREATED');
    const original = chat.registry.get('metadata-startup')!;
    const closed = vi.spyOn(original.inputQueue!, 'close');
    if (phase === 'branch') controller.abort(Error('scope cancelled'));
    else original.abortController.abort(Error('startup cancelled'));
    await startup;
    expect(chat.registry.get('metadata-startup')).toBeUndefined();
    expect(closed).toHaveBeenCalledOnce();
    expect(chat.eventStore.getSession(sessionId)?.state).toBe('ENDED');
    expect(changes).toHaveBeenCalledWith('metadata-startup', 'end', sessionId);
    if (phase === 'branch') expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    expect(query).not.toHaveBeenCalled();
  },
);
it.each(['resume-validation', 'branch'] as const)(
  'keeps acknowledged Ask permission while %s metadata is pending',
  async (phase) => {
    const accountProfiles = profiles();
    chat.eventStore.upsertSession({
      sessionId,
      cwd: root,
      mode: 'auto',
      accountBinding: accountProfiles.resolve('work', 'claude-sonnet-4-6'),
    });
    let release!: () => void,
      entered = false;
    if (phase === 'resume-validation')
      metadata.isGitDirectory.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            entered = true;
            release = () => resolve(true);
          }),
      );
    else
      metadata.readWorkspaceBranch.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            entered = true;
            release = () => resolve('main');
          }),
      );
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    let actual: string | undefined;
    vi.mocked(query).mockImplementation((args) => {
      actual = args.options?.permissionMode;
      throw Error('Offline provider boundary');
    });
    const startup = chat.startChat(
      { send: () => {}, isOpen: () => true },
      'metadata-resume',
      'Continue',
      {
        resume: sessionId,
        cwd: root,
        isolation: false,
        accountId: 'work',
        model: 'claude-sonnet-4-6',
        accountProfiles,
      },
    );
    await vi.waitFor(() => expect(entered).toBe(true));
    const { handleSetModeV2 } = await import('../ws-handler-v2.js');
    const changed = await handleSetModeV2(
      'operator',
      { type: 'set_mode', sessionId, mode: 'ask' },
      {
        eventStore: chat.eventStore,
        sessionRegistry: chat.registry,
        connRegistry: { broadcast: vi.fn(), get: () => undefined },
      } as never,
    );
    expect(changed).toMatchObject({ ok: true, applied: true, persisted: true });
    release();
    await startup;
    expect(actual).toBe('plan');
    expect(chat.eventStore.getSession(sessionId)?.mode).toBe('ask');
  },
);

it.each([false, true])(
  'does not retire a replacement driver when pending metadata finishes (native admission=%s)',
  async (native) => {
    let release!: () => void,
      entered = false;
    metadata.readWorkspaceBranch.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          entered = true;
          release = () => resolve('main');
        }),
    );
    const changes = vi.fn();
    chat.setSessionChangeCallback(changes);
    const transport = { send: vi.fn(), isOpen: () => true };
    const startup = chat.startChat(transport, 'metadata-replaced', 'Review', {
      clientMsgId: 'replacement-command',
      initialSessionId: sessionId,
      cwd: root,
      isolation: false,
      ...(native
        ? {
            accountId: 'google',
            model: 'gemini-2.5-pro',
            accountProfiles: new AccountProfiles([
              {
                id: 'google',
                label: 'Offline Google',
                provider: 'google-vertex',
                projectId: 'fixture-project',
                region: 'global',
                credentialRef: '/fixture/google-adc.json',
                models: [{ id: 'gemini-2.5-pro', label: 'Fixture' }],
              },
            ]),
          }
        : {}),
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    if (native)
      expect(chat.eventStore.getExecutionAdmission(sessionId, 'replacement-command')).toBeDefined();
    const original = chat.registry.get('metadata-replaced')!;
    const closed = vi.spyOn(original.inputQueue!, 'close');
    const replacementAbort = new AbortController();
    chat.registry.register('metadata-replaced', {
      transport,
      abortController: replacementAbort,
      mode: 'ask',
      sessionAllowList: new Set(),
      sessionId,
    });
    const replacement = chat.registry.get('metadata-replaced');
    release();
    await startup;
    expect(chat.registry.get('metadata-replaced')).toBe(replacement);
    expect(replacementAbort.signal.aborted).toBe(false);
    expect(chat.eventStore.getSession(sessionId)?.state).toBe('CREATED');
    expect(changes).not.toHaveBeenCalledWith('metadata-replaced', 'end', sessionId);
    expect(closed).toHaveBeenCalledOnce();
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    expect(query).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'keeps a non-isolated startup immediately routable while its socket read waits (selected account=%s)',
  async (selected) => {
    let release!: () => void;
    const held = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    metadata.readSshAuthSock.mockReturnValue(held);
    const running = chat
      .startChat({ send: () => {}, isOpen: () => true }, 'immediate-driver', 'First prompt', {
        initialSessionId: sessionId,
        clientMsgId: 'first-prompt',
        cwd: root,
        isolation: false,
        ...(selected
          ? { accountId: 'work', model: 'claude-sonnet-4-6', accountProfiles: profiles() }
          : {}),
      })
      .catch((error) => error);
    try {
      expect.soft(chat.registry.findBySessionId(sessionId)?.clientId).toBe('immediate-driver');
      expect
        .soft(
          await chat.sendToChat(
            'immediate-driver',
            'Follow-up',
            undefined,
            undefined,
            'next-prompt',
          ),
        )
        .toBe(true);
    } finally {
      release();
      await running;
    }
  },
);
