import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
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
it('persists binding and boot context under the requested SDK UUID before query starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-account-start-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ boot: { tokens: 1, fullMarkdown: 'boot evidence' } })),
      ),
  );
  const chat = await import('../chat.js');
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
    sdkId = args.options?.sessionId;
    if (!sdkId) throw new Error('missing preallocated ID');
    const meta = chat.eventStore.getSession(sdkId);
    expect(meta?.accountBinding).toEqual(profiles.resolve('work', 'claude-sonnet-4-6'));
    expect(meta?.bootContext).toBeTruthy();
    persistedBeforeQuery = true;
    throw new Error('simulated process failure before first SDK event');
  });
  try {
    await chat.startChat({ send: () => {}, isOpen: () => true }, 'binding-test', 'hello', {
      cwd: root,
      isolation: false,
      accountId: 'work',
      model: 'claude-sonnet-4-6',
      accountProfiles: profiles,
    });
    expect(persistedBeforeQuery).toBe(true);
    expect(sdkId).toMatch(/^[0-9a-f-]{36}$/);
    expect(chat.eventStore.getSession(sdkId!)?.accountBinding?.accountId).toBe('work');
  } finally {
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});
