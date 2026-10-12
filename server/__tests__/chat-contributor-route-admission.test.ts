import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AccountProfiles } from '../account-profiles.js';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  query: vi.fn(),
}));
vi.mock('../session-index.js', async (original) => ({
  ...(await original<object>()),
  registerSession: vi.fn(),
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../prompt-compare.js', () => ({
  capturePromptComparison: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../auto-rename.js', async (original) => ({
  ...(await original<object>()),
  shouldAutoRename: () => false,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const unsupported = 'Selected account does not support ordinary contributor turns';
async function setup(provider: 'openai' | 'google-vertex' = 'openai') {
  vi.clearAllMocks();
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-contributor-route-'));
  execFileSync('git', ['init', '-q', root]);
  for (const [key, value] of Object.entries({
    REPO_PATH: root,
    WORKTREE_ENABLED: 'false',
    MITZO_OPENSHELL_ENABLED: '1',
    MITZO_OPENSHELL_SANDBOX_NAME: '',
    MITZO_OPENSHELL_OPENAI_API_ENABLED: '1',
    MITZO_OPENSHELL_IMAGE: 'offline-image',
    MITZO_OPENSHELL_POLICY: '/offline/policy.yaml',
    MITZO_OPENSHELL_SEED: '/offline/seed',
    MITZO_OPENSHELL_STACK_MANIFEST: '',
    MITZO_OPENSHELL_AGENT_CONTEXT_PRESETS: '',
    MITZO_OPENSHELL_PROVIDERS: '',
  }))
    vi.stubEnv(key, value);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify({ boot: { content: '', sources: [], tokens: 0 } })),
    ),
  );
  const accounts = new AccountProfiles([
    provider === 'openai'
      ? {
          id: 'fixture',
          label: 'Offline API',
          provider,
          sandboxProvider: 'offline-api',
          credentialRef: { provider: 'keychain', service: 'offline', account: 'fixture' },
          models: [{ id: 'offline-model', label: 'Offline' }],
        }
      : {
          id: 'fixture',
          label: 'Offline Gemini',
          provider,
          credentialRef: '/offline/adc.json',
          projectId: 'offline-project',
          region: 'europe-west1',
          models: [{ id: 'offline-model', label: 'Offline' }],
        },
  ]);
  const chat = await import('../chat.js');
  const { credentials } = await import('../credentials.js');
  const resolve = vi.spyOn(credentials, 'resolve').mockResolvedValue('offline-key');
  const codex = await import('../codex-chat-session.js');
  const openCodex = vi
    .spyOn(codex, 'openCodexChat')
    .mockRejectedValue(Error('Existing Codex reached'));
  const responses = await import('../responses-chat-session.js');
  const openResponses = vi
    .spyOn(responses, 'openResponsesChat')
    .mockRejectedValue(Error('Existing Responses reached'));
  const { CodexAppServerClient } = await import('../codex-app-server-client.js');
  const launch = vi.spyOn(CodexAppServerClient, 'launch').mockImplementation(() => {
    throw Error('Unexpected host launch');
  });
  const { GoogleAuth } = await import('google-auth-library');
  const googleToken = vi
    .spyOn(GoogleAuth.prototype, 'getAccessToken')
    .mockResolvedValue('offline-token');
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  vi.mocked(query).mockImplementation(() => {
    throw Error('Unexpected SDK dispatch');
  });
  const lifecycle = { beforeDispatch: vi.fn(), accepted: vi.fn(), terminal: vi.fn() };
  const admission = vi.fn();
  const transport = { send: vi.fn(), isOpen: () => true };
  const options = {
    cwd: root,
    isolation: false,
    accountId: 'fixture',
    model: 'offline-model',
    accountProfiles: accounts,
    ordinaryTurnLifecycle: lifecycle,
    onStartupAdmission: admission,
    initialSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-565656565656',
  };
  return {
    root,
    chat,
    accounts,
    resolve,
    openCodex,
    openResponses,
    launch,
    googleToken,
    query,
    lifecycle,
    admission,
    transport,
    options,
    async cleanup() {
      chat.registry.dispose();
      chat.eventStore.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
function expectRejected(f: Awaited<ReturnType<typeof setup>>) {
  expect(f.admission).toHaveBeenCalledWith(expect.objectContaining({ message: unsupported }));
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.openResponses).not.toHaveBeenCalled();
  expect(f.openCodex).not.toHaveBeenCalled();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
  expect(f.googleToken).not.toHaveBeenCalled();
  expect(f.lifecycle.beforeDispatch).not.toHaveBeenCalled();
}
it.each(['disabled', 'unconfigured', 'API disabled', 'named sandbox', 'Gemini', 'unbound SDK'])(
  'rejects contributor %s before provider startup',
  async (route) => {
    const f = await setup(route === 'Gemini' ? 'google-vertex' : 'openai');
    try {
      if (route === 'disabled') vi.stubEnv('MITZO_OPENSHELL_ENABLED', '0');
      if (route === 'unconfigured') vi.stubEnv('MITZO_OPENSHELL_POLICY', '');
      if (route === 'API disabled') vi.stubEnv('MITZO_OPENSHELL_OPENAI_API_ENABLED', '0');
      if (route === 'named sandbox') vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'legacy');
      if (route === 'unbound SDK') vi.stubEnv('MITZO_OPENSHELL_ENABLED', '0');
      await f.chat.startChat(
        f.transport,
        'rejected-contributor',
        'Review',
        route === 'unbound SDK'
          ? { ...f.options, accountId: undefined, accountProfiles: undefined }
          : f.options,
      );
      expectRejected(f);
    } finally {
      await f.cleanup();
    }
  },
);
it.each([true, false])(
  'fences a route changing from enabled=%s during profile lookup',
  async (initiallyEnabled) => {
    const f = await setup();
    try {
      vi.stubEnv('MITZO_OPENSHELL_ENABLED', initiallyEnabled ? '1' : '0');
      const library = await import('../agent-library-transport.js');
      vi.spyOn(library, 'readAgentLibraryProfile').mockImplementation(async () => {
        await Promise.resolve();
        vi.stubEnv('MITZO_OPENSHELL_ENABLED', initiallyEnabled ? '0' : '1');
        const definition = {
          name: 'Reviewer',
          descriptor: 'Offline reviewer',
          role: 'agent',
          instructions: 'Review',
          expectedOutput: 'Review',
          acceptanceCriteria: ['Use evidence'],
          modelPolicyRole: 'agent',
        };
        return {
          profileId: 'reviewer',
          revision: 1,
          definition,
          contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
        };
      });
      await f.chat.startChat(f.transport, 'changed-route', 'Review', {
        ...f.options,
        agentProfile: { profileId: 'reviewer', revision: 1 },
        operatorConnectionId: 'offline-operator',
      });
      expectRejected(f);
    } finally {
      await f.cleanup();
    }
  },
);
it('passes an enabled dedicated API binding and lifecycle unchanged to existing Codex startup', async () => {
  const f = await setup();
  try {
    const binding = f.accounts.resolve('fixture', 'offline-model');
    await f.chat.startChat(f.transport, 'supported-contributor', 'Review', f.options);
    expect(f.openCodex).toHaveBeenCalledOnce();
    expect(f.openCodex.mock.calls[0][0].binding).toEqual(binding);
    expect(f.openCodex.mock.calls[0][0].ordinaryTurnLifecycle).toBe(f.lifecycle);
    expect(f.openResponses).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});
it('preserves ordinary Responses startup without contributor lifecycle', async () => {
  const f = await setup();
  try {
    vi.stubEnv('MITZO_OPENSHELL_ENABLED', '0');
    await f.chat.startChat(f.transport, 'ordinary-responses', 'Review', {
      ...f.options,
      ordinaryTurnLifecycle: undefined,
    });
    expect(f.resolve).toHaveBeenCalledOnce();
    expect(f.openResponses).toHaveBeenCalledOnce();
    expect(f.openCodex).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});
