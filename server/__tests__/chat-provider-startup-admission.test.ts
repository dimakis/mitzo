import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../account-profiles.js';

const native = vi.hoisted(() => ({
  prompts: [] as string[],
  construct: vi.fn(),
  connect: vi.fn(async () => ({
    definitions: [],
    close: async () => {},
    displayName: (name: string) => name,
  })),
  googleToken: vi.fn(async () => 'private-google-token'),
}));

vi.mock('../native-responses-runner.js', () => ({
  NativeResponsesRunner: class {
    constructor(options: Record<string, unknown>) {
      native.construct(options);
    }

    async *run(prompt: string) {
      native.prompts.push(prompt);
      yield { type: 'result', session_id: 'native-test' };
    }

    interrupt() {}
    async waitUntilIdle() {}
  },
}));
vi.mock('../codex-mcp-tools.js', () => ({ connectCodexMcpTools: native.connect }));
vi.mock('../credentials.js', async (original) => ({
  ...(await original<object>()),
  credentials: { resolve: vi.fn(async () => 'private-test-key') },
}));
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getAccessToken = native.googleToken;
  },
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('../prompt-compare.js', () => ({
  capturePromptComparison: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../session-index.js', async (original) => ({
  ...(await original<object>()),
  registerSession: vi.fn(),
}));

function profiles() {
  return new AccountProfiles([
    {
      id: 'work-api',
      label: 'Work API',
      provider: 'openai',
      credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
      models: [{ id: 'gpt-test', label: 'GPT Test', reasoningEfforts: ['high'] }],
    },
  ]);
}

function stubBootContext() {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ boot: { tokens: 1, fullMarkdown: 'boot evidence' } })),
      ),
  );
}

afterEach(() => {
  native.prompts.length = 0;
  native.construct.mockReset();
  native.connect.mockClear();
  native.googleToken.mockClear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('uses the same admitted startup lifecycle for Google Vertex and preflights retries before auth', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-vertex-initial-admission-'));
  await writeFile(join(root, '.mitzo.json'), '{}');
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  stubBootContext();
  const chat = await import('../chat.js');
  const sessionId = '55555555-5555-4555-8555-555555555555';
  const accountProfiles = new AccountProfiles([
    {
      id: 'vertex-work',
      label: 'Vertex Work',
      provider: 'google-vertex',
      credentialRef: '/private/google.json',
      projectId: 'test-project',
      region: 'us-east5',
      models: [{ id: 'gemini-test', label: 'Gemini Test' }],
    },
  ]);
  const options = {
    cwd: root,
    isolation: false,
    accountId: 'vertex-work',
    model: 'gemini-test',
    accountProfiles,
    initialSessionId: sessionId,
    clientMsgId: 'vertex-initial',
  } as const;

  try {
    const running = chat.startChat(
      { send: () => {}, isOpen: () => true },
      'vertex-first',
      'vertex turn',
      options,
    );
    await vi.waitFor(() => expect(native.prompts).toEqual(['vertex turn']));
    chat.stopChat('vertex-first');
    await running;

    await chat.startChat(
      { send: () => {}, isOpen: () => true },
      'vertex-retry',
      'vertex turn',
      options,
    );

    const admission = chat.eventStore.getExecutionAdmission(sessionId, 'vertex-initial');
    expect(admission).toBeDefined();
    expect(chat.eventStore.getProviderAttempts(admission!.token)).toHaveLength(1);
    expect(native.prompts).toEqual(['vertex turn']);
    expect(native.googleToken).toHaveBeenCalledOnce();
    expect(chat.registry.get('vertex-retry')).toBeUndefined();
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('admits a native initial command before queue visibility and dispatches one provider attempt', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-native-initial-admission-'));
  const contextPath = join(root, 'changed-context.md');
  await writeFile(contextPath, 'changed context');
  await writeFile(
    join(root, '.mitzo.json'),
    JSON.stringify({ contextBlocks: { reference: contextPath } }),
  );
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  stubBootContext();
  const chat = await import('../chat.js');
  const sessionId = '11111111-1111-4111-8111-111111111111';

  try {
    const running = chat.startChat(
      { send: () => {}, isOpen: () => true },
      'initial-client',
      'first turn',
      {
        cwd: root,
        isolation: false,
        accountId: 'work-api',
        model: 'gpt-test',
        reasoningEffort: 'high',
        accountProfiles: profiles(),
        initialSessionId: sessionId,
        clientMsgId: 'initial-command',
      },
    );
    await vi.waitFor(() => expect(native.prompts).toEqual(['first turn']));
    chat.stopChat('initial-client');
    await running;

    const admission = chat.eventStore.getExecutionAdmission(sessionId, 'initial-command');
    expect(admission).toBeDefined();
    expect(native.prompts).toEqual(['first turn']);
    expect(chat.eventStore.getProviderAttempts(admission!.token)).toMatchObject([
      { phase: 'TERMINAL', terminalReason: 'completed' },
    ]);
    expect(chat.eventStore.getSession(sessionId)).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'completed',
    });
    expect(
      chat.preflightStartupProviderCommand(chat.eventStore, {
        sessionId,
        clientMsgId: 'initial-command',
        prompt: 'first turn',
        cwd: root,
        model: 'gpt-test',
        reasoningEffort: 'high',
      }),
    ).toBe(true);
    expect(() =>
      chat.preflightStartupProviderCommand(chat.eventStore, {
        sessionId,
        clientMsgId: 'initial-command',
        prompt: 'changed turn',
        cwd: root,
        model: 'gpt-test',
        reasoningEffort: 'high',
      }),
    ).toThrow(/fingerprint/i);
    expect(() =>
      chat.preflightStartupProviderCommand(chat.eventStore, {
        sessionId,
        clientMsgId: 'initial-command',
        prompt: 'first turn',
        cwd: root,
        contextBlocks: ['reference'],
        model: 'gpt-test',
        reasoningEffort: 'high',
      }),
    ).toThrow(/fingerprint/i);
    expect(() =>
      chat.preflightStartupProviderCommand(chat.eventStore, {
        sessionId,
        clientMsgId: 'initial-command',
        prompt: 'first turn',
        cwd: root,
        model: 'changed-model',
        reasoningEffort: 'high',
      }),
    ).toThrow(/fingerprint/i);
    expect(() =>
      chat.preflightStartupProviderCommand(chat.eventStore, {
        sessionId,
        clientMsgId: 'initial-command',
        prompt: 'first turn',
        cwd: root,
        model: 'gpt-test',
        reasoningEffort: null,
      }),
    ).toThrow(/fingerprint/i);
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('reuses initial and registry-missing resume admissions without redispatch', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-native-resume-admission-'));
  await writeFile(join(root, '.mitzo.json'), '{}');
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  stubBootContext();
  const chat = await import('../chat.js');
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const accountProfiles = profiles();
  const transport = { send: vi.fn(), isOpen: () => true };

  try {
    const initial = chat.startChat(transport, 'first-client', 'first turn', {
      cwd: root,
      isolation: false,
      accountId: 'work-api',
      model: 'gpt-test',
      accountProfiles,
      initialSessionId: sessionId,
      clientMsgId: 'initial-command',
    });
    await vi.waitFor(() => expect(native.prompts).toEqual(['first turn']));
    chat.stopChat('first-client');
    await initial;

    await chat.startChat(transport, 'initial-retry', 'first turn', {
      cwd: root,
      isolation: false,
      accountId: 'work-api',
      model: 'gpt-test',
      accountProfiles,
      initialSessionId: sessionId,
      clientMsgId: 'initial-command',
    });
    expect(chat.registry.get('initial-retry')).toBeUndefined();
    expect(native.prompts).toEqual(['first turn']);

    const resumed = chat.startChat(transport, 'resume-client', 'continue', {
      resume: sessionId,
      cwd: root,
      isolation: false,
      accountProfiles,
      clientMsgId: 'resume-command',
    });
    await vi.waitFor(() => expect(native.prompts).toEqual(['first turn', 'continue']));
    chat.stopChat('resume-client');
    await resumed;
    await chat.startChat(transport, 'resume-retry', 'continue', {
      resume: sessionId,
      cwd: root,
      isolation: false,
      accountProfiles,
      clientMsgId: 'resume-command',
    });

    expect(chat.registry.get('resume-retry')).toBeUndefined();
    expect(native.prompts).toEqual(['first turn', 'continue']);
    expect(chat.eventStore.getExecutionAdmission(sessionId, 'resume-command')).toBeDefined();
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects a changed cold-resume command before registry or transcript mutation', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-native-resume-conflict-'));
  await writeFile(join(root, '.mitzo.json'), '{}');
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  stubBootContext();
  const chat = await import('../chat.js');
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const accountProfiles = profiles();
  const firstTransport = { send: vi.fn(), isOpen: () => true };

  try {
    chat.eventStore.upsertSession({
      sessionId,
      cwd: root,
      accountBinding: accountProfiles.resolve('work-api', 'gpt-test'),
      selectedModel: 'gpt-test',
    });
    const original = chat.startChat(firstTransport, 'resume-first', 'original', {
      resume: sessionId,
      cwd: root,
      isolation: false,
      accountProfiles,
      clientMsgId: 'resume-conflict',
    });
    await vi.waitFor(() => expect(native.prompts).toEqual(['original']));
    chat.stopChat('resume-first');
    await original;
    const before = chat.eventStore.getSessionEvents(sessionId).length;
    const conflictTransport = { send: vi.fn(), isOpen: () => true };

    await chat.startChat(conflictTransport, 'resume-conflict-client', 'changed', {
      resume: sessionId,
      cwd: root,
      isolation: false,
      accountProfiles,
      clientMsgId: 'resume-conflict',
    });

    expect(conflictTransport.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', error: expect.stringMatching(/fingerprint/i) }),
    );
    expect(chat.registry.get('resume-conflict-client')).toBeUndefined();
    expect(chat.eventStore.hasUserMessage(sessionId, 'resume-conflict')).toBe(true);
    expect(chat.eventStore.getSessionEvents(sessionId)).toHaveLength(before);
    expect(native.prompts).toEqual(['original']);
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('terminalizes an admitted startup when native runtime initialization fails', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-native-startup-failure-'));
  await writeFile(join(root, '.mitzo.json'), '{}');
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  stubBootContext();
  native.connect.mockRejectedValueOnce(new Error('MCP startup failed'));
  const chat = await import('../chat.js');
  const sessionId = '44444444-4444-4444-8444-444444444444';

  try {
    await chat.startChat({ send: vi.fn(), isOpen: () => true }, 'failed-startup', 'queued', {
      cwd: root,
      isolation: false,
      accountId: 'work-api',
      model: 'gpt-test',
      accountProfiles: profiles(),
      initialSessionId: sessionId,
      clientMsgId: 'startup-failure',
    });

    const admission = chat.eventStore.getExecutionAdmission(sessionId, 'startup-failure');
    expect(admission).toBeDefined();
    expect(chat.eventStore.getProviderAttempts(admission!.token)).toEqual([]);
    expect(chat.eventStore.getSession(sessionId)).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'startup_failed',
    });
    expect(native.prompts).toEqual([]);
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not create runtime or transcript side effects when admission storage fails', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-native-admission-storage-failure-'));
  await writeFile(join(root, '.mitzo.json'), '{}');
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  stubBootContext();
  const chat = await import('../chat.js');
  const sessionId = '66666666-6666-4666-8666-666666666666';
  const transport = { send: vi.fn(), isOpen: () => true };
  vi.spyOn(chat.eventStore, 'beginExecution').mockImplementationOnce(() => {
    throw new Error('admission storage failed');
  });

  try {
    await chat.startChat(transport, 'admission-storage-failure', 'never queued', {
      cwd: root,
      isolation: false,
      accountId: 'work-api',
      model: 'gpt-test',
      accountProfiles: profiles(),
      initialSessionId: sessionId,
      clientMsgId: 'admission-storage-failure',
    });

    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', error: 'admission storage failed' }),
    );
    expect(chat.registry.get('admission-storage-failure')).toBeUndefined();
    expect(chat.eventStore.hasUserMessage(sessionId, 'admission-storage-failure')).toBe(false);
    expect(native.construct).not.toHaveBeenCalled();
    expect(native.prompts).toEqual([]);
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('terminalizes admission when transcript acknowledgement fails before queue publication', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-native-transcript-storage-failure-'));
  await writeFile(join(root, '.mitzo.json'), '{}');
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  stubBootContext();
  const chat = await import('../chat.js');
  const sessionId = '77777777-7777-4777-8777-777777777777';
  const append = chat.eventStore.append.bind(chat.eventStore);
  vi.spyOn(chat.eventStore, 'append').mockImplementation((storedSessionId, type, payload) => {
    if (type === 'user_message') throw new Error('transcript storage failed');
    return append(storedSessionId, type, payload);
  });

  try {
    await chat.startChat(
      { send: vi.fn(), isOpen: () => true },
      'transcript-failure',
      'not visible',
      {
        cwd: root,
        isolation: false,
        accountId: 'work-api',
        model: 'gpt-test',
        accountProfiles: profiles(),
        initialSessionId: sessionId,
        clientMsgId: 'transcript-storage-failure',
      },
    );

    const admission = chat.eventStore.getExecutionAdmission(
      sessionId,
      'transcript-storage-failure',
    );
    expect(admission).toBeDefined();
    expect(chat.eventStore.getProviderAttempts(admission!.token)).toEqual([]);
    expect(chat.eventStore.getSession(sessionId)).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'startup_failed',
    });
    expect(native.prompts).toEqual([]);
    expect(chat.registry.get('transcript-failure')).toBeUndefined();
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});
