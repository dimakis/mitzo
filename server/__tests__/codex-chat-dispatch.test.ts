import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AccountProfiles } from '../account-profiles.js';
import { openCodexChat } from '../codex-chat-session.js';
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
vi.mock('../codex-chat-session.js', () => ({
  openCodexChat: vi.fn(),
  getCodexRuntime: () => undefined,
}));
vi.mock('../codex-app-server-client.js', () => ({
  CodexAppServerClient: {
    launch: () => ({
      initialize: async () => {},
      request: async () => ({
        account: { type: 'chatgpt', email: 'test@example.com', planType: 'test' },
      }),
      close: () => {},
    }),
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
    });
    expect(openCodexChat).toHaveBeenCalledOnce();
    expect(persisted).toEqual(profiles.resolve('personal', 'luna'));
    expect(opened?.systemPrompt).toContain('boot evidence');
    expect(opened?.prompt).toContain('attached context');
    expect(query).not.toHaveBeenCalled();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(chat.eventStore.getSession(id)?.state).toBe('ENDED');
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});
