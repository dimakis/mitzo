import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../account-profiles.js';
const repositories = vi.hoisted(() => ({ claim: vi.fn(), getForConversation: vi.fn() }));
vi.mock('../repository-workspace-runtime.js', () => ({
  getRepositoryWorkspaces: () => repositories,
  repositoryWorkspacesEnabled: () => true,
  readRepositoryWorkspaceForConversation: (id: string) => repositories.getForConversation(id),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn(),
}));
vi.mock('../session-index.js', async (original) => ({
  ...(await original<object>()),
  registerSession: vi.fn(),
}));
vi.mock('../prompt-compare.js', () => ({
  capturePromptComparison: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: vi.fn(() => ({})) }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('starts a native repository chat with its claimed cwd and exact repository context', async () => {
  vi.resetModules();
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repository-chat-wiring-')));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ boot: {} }))),
  );
  const profiles = new AccountProfiles(
    [
      {
        id: 'fixture',
        label: 'Fixture',
        provider: 'openai-codex',
        credentialRef: '/fixture/codex',
        email: 'fixture@example.invalid',
        planType: 'pro',
        models: [{ id: 'offline-model', label: 'Offline fixture' }],
      },
    ],
    { codexEnabled: true },
  );
  const account = await import('../codex-account.js');
  vi.spyOn(account, 'verifyCodexAccount').mockResolvedValue(
    profiles.resolve('fixture', 'offline-model') as never,
  );
  const { CodexAppServerClient } = await import('../codex-app-server-client.js');
  vi.spyOn(CodexAppServerClient, 'launch').mockReturnValue({
    initialize: async () => {},
    close: vi.fn(),
  } as never);
  const codex = await import('../codex-chat-session.js');
  const open = vi
    .spyOn(codex, 'openCodexChat')
    .mockRejectedValue(new Error('offline fixture stops before provider dispatch'));
  repositories.claim.mockResolvedValue({
    id: 'repository',
    repository: 'example/repo',
    baseBranch: 'main',
    baseOid: 'a'.repeat(40),
    featureBranch: 'mitzo/task',
    directory: root,
    seed: '/private/prepared/mgmt',
  });
  const chat = await import('../chat.js');
  try {
    await chat.startChat(
      { send: vi.fn(), isOpen: () => true },
      'repository-fixture',
      'change the code',
      {
        accountId: 'fixture',
        model: 'offline-model',
        accountProfiles: profiles,
        initialSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-121212121212',
        repositoryWorkspaceId: 'repository',
      },
    );
    expect(repositories.claim).toHaveBeenCalledWith(
      'repository',
      expect.objectContaining({ accountId: 'fixture' }),
      'aaaaaaaa-bbbb-4ccc-8ddd-121212121212',
      expect.any(String),
      false,
    );
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ cwd: root }),
        prompt: expect.stringContaining('example/repo'),
        repositoryWorkspace: expect.objectContaining({ id: 'repository' }),
      }),
    );
    expect(chat.eventStore.getSession('aaaaaaaa-bbbb-4ccc-8ddd-121212121212')?.cwd).toBe(root);
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});
