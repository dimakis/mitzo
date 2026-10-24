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
vi.mock('../prompt-compare.js', () => ({ capturePromptComparison: vi.fn(async () => {}) }));
vi.mock('../mcp-config.js', () => ({
  loadMcpServers: () => ({ inherited: { command: 'must-not-connect' } }),
}));
vi.mock('../hook-bridge.js', async (original) => ({
  ...(await original<object>()),
  loadProjectHooks: vi.fn(),
}));
vi.mock('../auto-rename.js', async (original) => ({
  ...(await original<object>()),
  shouldAutoRename: vi.fn(() => {
    throw Error('No extra model calls');
  }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('uses the production shared SDK query with exact feature instructions and enforced scope, preserving read-only history', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'adviser-sdk-startup-'));
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  const fetcher = vi.fn(() => {
    throw Error('No network allowed');
  });
  vi.stubGlobal('fetch', fetcher);
  const profiles = new AccountProfiles([
    {
      id: 'work',
      label: 'Selected Vertex',
      provider: 'anthropic-vertex',
      projectId: 'selected-project',
      region: 'us-east5',
      credentialRef: '/synthetic/selected.json',
      models: [{ id: 'claude-sonnet-4-6', label: 'Fixture' }],
    },
  ]);
  const { AdviserTaskScope } = await import('../adviser-task-scope.js');
  const scope = new AdviserTaskScope(
    {
      authSessionId: 'operator',
      feature: { kind: 'agent-library' },
      accountId: 'work',
      model: 'claude-sonnet-4-6',
      instructions: 'Only reviewed profile draft.',
      messages: [{ role: 'user', content: 'Reviewed draft' }],
    },
    () => {},
    new AbortController().signal,
  );
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-343434343434';
  scope.bindCommand(sessionId, 'command');
  const chat = await import('../chat.js');
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const { loadProjectHooks } = await import('../hook-bridge.js');
  vi.mocked(query).mockClear();
  let permission: Promise<unknown> | undefined;
  vi.mocked(query).mockImplementation((args) => {
    expect(args.options).toMatchObject({
      systemPrompt: 'Only reviewed profile draft.',
      tools: [],
      allowedTools: [],
      settingSources: [],
      mcpServers: {},
      hooks: {},
      strictMcpConfig: true,
      env: {
        ANTHROPIC_VERTEX_PROJECT_ID: 'selected-project',
        GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/selected.json',
      },
    });
    permission = Promise.resolve(
      args.options!.canUseTool!(
        'Read',
        { file_path: '/private' },
        { signal: new AbortController().signal, toolUseID: 'attempt' },
      ),
    );
    throw Error('Controlled SDK boundary; no process or model');
  });
  try {
    await chat.startChat({ send: () => {}, isOpen: () => true }, 'adviser-sdk', scope.prompt(), {
      initialSessionId: sessionId,
      clientMsgId: 'command',
      cwd: root,
      accountId: 'work',
      model: 'claude-sonnet-4-6',
      accountProfiles: profiles,
      mode: 'ask',
      adviserScope: scope,
    });
    expect(query).toHaveBeenCalledOnce();
    expect(loadProjectHooks).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(permission).resolves.toMatchObject({ behavior: 'deny' });
    expect(chat.eventStore.getLatestEvent(sessionId, 'adviser_task_scope')?.payload).toMatchObject({
      contextSha256: scope.contextSha256,
      feature: { kind: 'agent-library' },
      policy: 'reviewed-context-only',
    });
    vi.mocked(query).mockClear();
    const restored = vi.fn();
    await chat.startChat({ send: restored, isOpen: () => true }, 'generic-resume', 'Continue', {
      resume: sessionId,
      cwd: root,
      accountProfiles: profiles,
    });
    expect(restored).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        error: expect.stringMatching(/read-only|reviewed snapshot/),
      }),
    );
    expect(chat.registry.get('generic-resume')).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});
