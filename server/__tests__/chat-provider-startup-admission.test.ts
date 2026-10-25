import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../account-profiles.js';

const native = vi.hoisted(() => ({
  prompts: [] as unknown[],
  construct: vi.fn(),
  prepare: vi.fn(),
  connect: vi.fn(async () => ({
    definitions: [],
    close: async () => {},
    displayName: (name: string) => name,
  })),
  googleToken: vi.fn(async () => 'private-google-token'),
  credentialResolve: vi.fn(async () => 'private-test-key'),
}));

vi.mock('../native-responses-runner.js', () => ({
  NativeResponsesRunner: class {
    constructor(options: Record<string, unknown>) {
      native.construct(options);
    }

    async *run(prompt: unknown) {
      native.prompts.push(prompt);
      yield { type: 'result', session_id: 'native-test' };
    }

    prepare(...args: unknown[]) {
      native.prepare(...args);
    }
    isRunning() {
      return false;
    }
    abandon() {}
    interrupt() {}
    async waitUntilIdle() {}
  },
}));
vi.mock('../codex-mcp-tools.js', () => ({ connectCodexMcpTools: native.connect }));
vi.mock('../credentials.js', async (original) => ({
  ...(await original<object>()),
  credentials: { resolve: native.credentialResolve },
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

function apiProfiles(enrolled = false) {
  return new AccountProfiles(
    [
      {
        id: 'work-api',
        label: 'Work API',
        provider: 'openai',
        credentialRef: { provider: 'keychain', service: 'mitzo', account: 'work' },
        models: [{ id: 'gemini-2.5-pro', label: 'GPT Test', reasoningEfforts: ['high'] }],
      },
    ],
    enrolled ? { enrolledOpenAIAccountIds: new Set(['work-api']) } : {},
  );
}

function profiles() {
  return new AccountProfiles([
    {
      id: 'work-api',
      label: 'Deferred Gemini',
      provider: 'google-vertex',
      projectId: 'fixture-project',
      region: 'global',
      credentialRef: '/fixture/google-adc.json',
      models: [{ id: 'gemini-2.5-pro', label: 'Gemini fixture', reasoningEfforts: ['high'] }],
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

async function legacyApiStartup() {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-legacy-startup-read-'));
  await writeFile(join(root, '.mitzo.json'), '{}');
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  stubBootContext();
  const { ConnectionsService } = await import('../connections-service.js');
  const service = new ConnectionsService({ list: () => [] } as never, {} as never);
  const ready = vi.fn(async (_id: string, _signal: AbortSignal) => {});
  const runtime = await import('../connections-runtime.js');
  runtime.setConnectionsRuntime({ service, assertOpenAIKeyReady: ready } as never);
  const chat = await import('../chat.js');
  const clientId = 'legacy-startup-read';
  const sent = vi.fn();
  const admission = vi.fn();
  const start = () =>
    chat.startChat({ send: sent, isOpen: () => true }, clientId, 'Read safely', {
      cwd: root,
      isolation: false,
      accountId: 'work-api',
      model: 'gemini-2.5-pro',
      accountProfiles: apiProfiles(),
      clientMsgId: 'legacy-read-command',
      onStartupAdmission: admission,
      onQueryEvent: () => chat.stopChat(clientId),
    });
  return {
    service,
    ready,
    sent,
    admission,
    start,
    async close() {
      chat.stopChat(clientId);
      runtime.setConnectionsRuntime(null);
      chat.registry.dispose();
      chat.eventStore.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('rejects retired API startup beside an active allocation without reading keys or disturbing credential rotation', async () => {
  const f = await legacyApiStartup();
  const entered = deferred(),
    finish = deferred();
  const allocation = f.service.withAccountRuntimes('sandbox', async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  const read = vi.spyOn(f.service, 'withCredentialRead');
  const mutate = vi.fn(async () => {});
  const rotation = f.service.withCredentialMutation(mutate);
  try {
    await expect(f.start()).rejects.toThrow(/Responses execution is retired/);
    expect(read).not.toHaveBeenCalled();
    expect(f.ready).not.toHaveBeenCalled();
    expect(native.credentialResolve).not.toHaveBeenCalled();
    expect(native.construct).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
    await allocation;
    await rotation;
    await f.close();
  }
  expect(mutate).toHaveBeenCalledOnce();
});

it.each(['queued', 'readiness', 'lookup'] as const)(
  'rejects retired API startup before entering a credential %s callback, with no late dispatch',
  async (phase) => {
    const f = await legacyApiStartup();
    const entered = deferred(),
      finish = deferred();
    const holder =
      phase === 'queued'
        ? f.service.withCredentialMutation(async () => {
            entered.resolve();
            await finish.promise;
          })
        : Promise.resolve();
    if (phase === 'queued') await entered.promise;
    const read = vi.spyOn(f.service, 'withCredentialRead');
    try {
      await expect(f.start()).rejects.toThrow(/Responses execution is retired/);
      expect(read).not.toHaveBeenCalled();
      expect(f.ready).not.toHaveBeenCalled();
      expect(native.credentialResolve).not.toHaveBeenCalled();
      expect(native.construct).not.toHaveBeenCalled();
      expect(native.prompts).toEqual([]);
    } finally {
      finish.resolve();
      await holder;
      await f.close();
    }
    expect(native.prompts).toEqual([]);
  },
);

afterEach(() => {
  native.prompts.length = 0;
  native.construct.mockReset();
  native.prepare.mockReset();
  native.connect.mockClear();
  native.googleToken.mockClear();
  native.credentialResolve.mockReset().mockResolvedValue('private-test-key');
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('refuses runtime-bound legacy startup and preflight before provider or transcript effects', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-bound-legacy-startup-'));
  await writeFile(join(root, '.mitzo.json'), '{}');
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  stubBootContext();
  const chat = await import('../chat.js');
  const accountProfiles = profiles();
  const accountBinding = accountProfiles.resolve('work-api', 'gemini-2.5-pro');
  const sessionId = 'bound-runtime';
  chat.eventStore.createSessionWithRuntimeBinding(
    { sessionId, cwd: root, repositoryWorkspaceId: 'reserved-workspace', accountBinding },
    {
      version: 2,
      account: {
        accountId: accountBinding.accountId,
        provider: accountBinding.provider,
        profileRevision: accountBinding.profileRevision,
      },
      harness: { implementation: 'gemini' },
      execution: {
        location: 'local',
        targetId: 'fixture-local',
        targetRevision: 'fixture-v1',
      },
    },
  );
  try {
    expect(() =>
      chat.preflightStartupProviderCommand(chat.eventStore, {
        sessionId,
        clientMsgId: 'cold-command',
        prompt: 'hello',
        cwd: root,
      }),
    ).toThrow(/guarded admission/i);
    const onStartupAdmission = vi.fn();
    await expect(
      chat.startChat({ send: vi.fn(), isOpen: () => true }, 'bound-client', 'hello', {
        resume: sessionId,
        cwd: root,
        accountProfiles,
        clientMsgId: 'cold-command',
        onStartupAdmission,
      }),
    ).rejects.toThrow(/guarded admission/i);
    expect(onStartupAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Runtime-bound commands require guarded admission',
      }),
    );
    expect(native.construct).not.toHaveBeenCalled();
    expect(native.connect).not.toHaveBeenCalled();
    expect(native.credentialResolve).not.toHaveBeenCalled();
    expect(chat.eventStore.hasUserMessage(sessionId, 'cold-command')).toBe(false);
    expect(chat.registry.get('bound-client')).toBeUndefined();
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['command', 'reattach-command', 'repository'] as const)(
  'refuses a runtime binding under the effective %s-derived initial identity before startup effects',
  async (source) => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'mitzo-derived-bound-startup-'));
    await writeFile(join(root, '.mitzo.json'), '{}');
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
    stubBootContext();
    const chat = await import('../chat.js');
    const accountProfiles = profiles();
    const accountBinding = accountProfiles.resolve('work-api', 'gemini-2.5-pro');
    const clientMsgId = 'bound-derived-command';
    const workspaceId = 'reserved-derived-workspace';
    const sessionId = chat.nativeStartupSessionId(
      source === 'repository' ? `repository:${workspaceId}` : clientMsgId,
    );
    chat.eventStore.createSessionWithRuntimeBinding(
      { sessionId, cwd: root, repositoryWorkspaceId: workspaceId, accountBinding },
      {
        version: 2,
        account: {
          accountId: accountBinding.accountId,
          provider: accountBinding.provider,
          profileRevision: accountBinding.profileRevision,
        },
        harness: { implementation: 'gemini' },
        execution: { location: 'local', targetId: 'fixture-local', targetRevision: 'fixture-v1' },
      },
    );
    const onStartupAdmission = vi.fn();
    const transport = { send: vi.fn(), isOpen: () => true };
    const reserveStartup = vi.spyOn(chat.eventStore, 'reserveOrdinaryStartup');
    try {
      // The old bypass enters the fake native queue indefinitely. Interrupt its
      // viewer loop after the fake provider's first event so the Red run terminates.
      const running = chat.startChat(transport, 'derived-bound-client', 'hello', {
        cwd: root,
        isolation: false,
        accountId: 'work-api',
        model: 'gemini-2.5-pro',
        accountProfiles,
        clientMsgId,
        onStartupAdmission,
        ...(source === 'repository' ? { repositoryWorkspaceId: workspaceId } : {}),
        ...(source === 'reattach-command' ? { reattachOnly: true } : {}),
        onQueryEvent: () => chat.stopChat('derived-bound-client'),
      });
      await expect(running).rejects.toThrow(/guarded admission/i);
      expect(onStartupAdmission).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Runtime-bound commands require guarded admission' }),
      );
      expect(reserveStartup).not.toHaveBeenCalled();
      expect(native.construct).not.toHaveBeenCalled();
      expect(native.connect).not.toHaveBeenCalled();
      expect(native.credentialResolve).not.toHaveBeenCalled();
      expect(chat.registry.get('derived-bound-client')).toBeUndefined();
      expect(chat.eventStore.hasUserMessage(sessionId, clientMsgId)).toBe(false);
      expect(transport.send).not.toHaveBeenCalled();
    } finally {
      chat.stopChat('derived-bound-client');
      chat.registry.dispose();
      chat.eventStore.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(['enrolled', 'managed', 'failed-marker', 'missing-controller'] as const)(
  'rejects retired API startup before %s key custody or any generic fallback',
  async (custody) => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'mitzo-retired-key-custody-'));
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
    stubBootContext();
    const resolveKey = vi.fn(async () => {
      throw Error('private custody diagnostic');
    });
    const withCredentialMutation = vi.fn();
    const runtime = await import('../connections-runtime.js');
    const controller = { manages: () => true, resolveKey };
    runtime.setConnectionsRuntime(
      custody === 'missing-controller'
        ? null
        : ({
            service: { withCredentialMutation },
            assertOpenAIKeyReady: vi.fn(),
            ...(custody === 'managed'
              ? { openAIKeys: controller }
              : { openAIEnrollmentAuthority: controller }),
          } as never),
    );
    const chat = await import('../chat.js');
    try {
      await expect(
        chat.startChat({ send: vi.fn(), isOpen: () => true }, 'retired-custody', 'never dispatch', {
          cwd: root,
          isolation: false,
          accountId: 'work-api',
          model: 'gemini-2.5-pro',
          accountProfiles: apiProfiles(custody !== 'managed'),
          clientMsgId: 'retired-key-command',
        }),
      ).rejects.toThrow(/Responses execution is retired/);
      for (const effect of [
        resolveKey,
        withCredentialMutation,
        native.credentialResolve,
        native.construct,
        native.connect,
      ])
        expect(effect).not.toHaveBeenCalled();
      expect(native.prompts).toEqual([]);
      expect(chat.registry.get('retired-custody')).toBeUndefined();
    } finally {
      runtime.setConnectionsRuntime(null);
      chat.registry.dispose();
      chat.eventStore.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
        model: 'gemini-2.5-pro',
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
        model: 'gemini-2.5-pro',
        reasoningEffort: 'high',
      }),
    ).toBe(true);
    expect(() =>
      chat.preflightStartupProviderCommand(chat.eventStore, {
        sessionId,
        clientMsgId: 'initial-command',
        prompt: 'changed turn',
        cwd: root,
        model: 'gemini-2.5-pro',
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
        model: 'gemini-2.5-pro',
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
        model: 'gemini-2.5-pro',
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
      model: 'gemini-2.5-pro',
      accountProfiles,
      initialSessionId: sessionId,
      clientMsgId: 'initial-command',
    });
    await vi.waitFor(() => expect(native.prompts).toEqual(['first turn']));
    chat.stopChat('first-client');
    await initial;

    expect(
      chat.preflightStartupProviderCommand(chat.eventStore, {
        sessionId,
        clientMsgId: 'initial-command',
        prompt: 'first turn',
        cwd: root,
        model: 'gemini-2.5-pro',
      }),
    ).toBe(true);
    vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
    expect(
      chat.preflightStartupProviderCommand(chat.eventStore, {
        sessionId,
        clientMsgId: 'initial-command',
        prompt: 'first turn',
        cwd: root,
        model: 'gemini-2.5-pro',
      }),
    ).toBe(true);
    vi.stubEnv('MITZO_OPENSHELL_ENABLED', '');

    native.googleToken.mockClear();
    native.googleToken.mockRejectedValueOnce(new Error('Selected Google credential unavailable'));
    await chat.startChat(transport, 'initial-retry', 'first turn', {
      cwd: root,
      isolation: false,
      accountId: 'work-api',
      model: 'gemini-2.5-pro',
      accountProfiles,
      initialSessionId: sessionId,
      clientMsgId: 'initial-command',
    });
    expect(chat.registry.get('initial-retry')).toBeUndefined();
    expect(native.prompts).toEqual(['first turn']);
    expect(native.googleToken).not.toHaveBeenCalled();
    native.googleToken.mockReset().mockResolvedValue('private-google-token');

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

it('fails closed for a historical OpenShell command after routing changes to native', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-openshell-route-change-'));
  await writeFile(join(root, '.mitzo.json'), '{}');
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '');
  stubBootContext();
  const chat = await import('../chat.js');
  const sessionId = '99999999-9999-4999-8999-999999999999';
  const accountBinding = apiProfiles().resolve('work-api', 'gemini-2.5-pro');

  try {
    chat.eventStore.upsertSession({
      sessionId,
      cwd: root,
      accountBinding,
      selectedModel: 'gemini-2.5-pro',
    });
    chat.eventStore.append(sessionId, 'user_message', {
      v: 2,
      type: 'user_message',
      ts: Date.now(),
      messageId: 'openshell-command',
      text: 'already dispatched',
    });

    expect(chat.eventStore.getExecutionAdmission(sessionId, 'openshell-command')).toBeUndefined();
    expect(() =>
      chat.preflightStartupProviderCommand(chat.eventStore, {
        sessionId,
        clientMsgId: 'openshell-command',
        prompt: 'already dispatched',
        cwd: root,
        model: 'gemini-2.5-pro',
      }),
    ).toThrow('ambiguous legacy OpenShell dispatch state; retry with a new command ID');
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('derives one stable native session identity for repeated WebSocket initial frames', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-native-ws-initial-admission-'));
  await writeFile(join(root, '.mitzo.json'), '{}');
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  stubBootContext();
  const chat = await import('../chat.js');
  const transport = { send: vi.fn(), isOpen: () => true };
  const options = {
    cwd: root,
    isolation: false,
    accountId: 'work-api',
    model: 'gemini-2.5-pro',
    accountProfiles: profiles(),
    clientMsgId: 'ws-initial-command',
  } as const;

  try {
    const first = chat.startChat(transport, 'ws-initial-first', 'one frame', options);
    await vi.waitFor(() => expect(native.prompts).toEqual(['one frame']));
    chat.stopChat('ws-initial-first');
    await first;

    native.googleToken.mockClear();
    await chat.startChat(transport, 'ws-initial-retry', 'one frame', options);

    const sessionId = chat.nativeStartupSessionId('ws-initial-command');
    expect(chat.eventStore.getExecutionAdmission(sessionId, 'ws-initial-command')).toBeDefined();
    expect(native.prompts).toEqual(['one frame']);
    expect(native.googleToken).not.toHaveBeenCalled();
    expect(chat.registry.get('ws-initial-retry')).toBeUndefined();
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
      accountBinding: accountProfiles.resolve('work-api', 'gemini-2.5-pro'),
      selectedModel: 'gemini-2.5-pro',
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

it('terminalizes deferred Gemini preparation failures before provider execution', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-native-startup-failure-'));
  await writeFile(join(root, '.mitzo.json'), '{}');
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  stubBootContext();
  native.connect.mockRejectedValueOnce(new Error('Gemini preparation failed'));
  const chat = await import('../chat.js');
  const sessionId = '44444444-4444-4444-8444-444444444444';

  try {
    const send = vi.fn();
    await chat.startChat({ send, isOpen: () => true }, 'failed-startup', 'queued', {
      cwd: root,
      isolation: false,
      accountId: 'work-api',
      model: 'gemini-2.5-pro',
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
    const errors = send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === 'error');
    expect(errors).toEqual([
      expect.objectContaining({
        error: 'Gemini preparation failed',
      }),
    ]);
  } finally {
    chat.registry.dispose();
    chat.eventStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('terminalizes and removes staged runtime state when setup fails after admission', async () => {
  vi.resetModules();
  const root = await mkdtemp(join(tmpdir(), 'mitzo-native-post-admission-failure-'));
  await writeFile(join(root, '.mitzo.json'), '{}');
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('WORKTREE_ENABLED', 'false');
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
  stubBootContext();
  const chat = await import('../chat.js');
  const sessionId = '88888888-8888-4888-8888-888888888888';
  const setSessionState = chat.eventStore.setSessionState.bind(chat.eventStore);
  vi.spyOn(chat.eventStore, 'setSessionState').mockImplementation((id, state, detail) => {
    if (state === 'CREATED') throw new Error('session state storage failed');
    return setSessionState(id, state, detail);
  });

  try {
    await expect(
      chat.startChat({ send: vi.fn(), isOpen: () => true }, 'post-admission-failure', 'queued', {
        cwd: root,
        isolation: false,
        accountId: 'work-api',
        model: 'gemini-2.5-pro',
        accountProfiles: profiles(),
        initialSessionId: sessionId,
        clientMsgId: 'post-admission-failure',
      }),
    ).rejects.toThrow('session state storage failed');

    const admission = chat.eventStore.getExecutionAdmission(sessionId, 'post-admission-failure');
    expect(admission).toBeDefined();
    expect(chat.eventStore.getProviderAttempts(admission!.token)).toEqual([]);
    expect(chat.eventStore.getSession(sessionId)).toMatchObject({
      executionPhase: 'TERMINAL',
      executionTerminalReason: 'startup_failed',
      state: 'ENDED',
    });
    expect(chat.registry.get('post-admission-failure')).toBeUndefined();
    expect(native.construct).not.toHaveBeenCalled();
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
      model: 'gemini-2.5-pro',
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
        model: 'gemini-2.5-pro',
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

it.each([false, true])(
  'rejects retired API image startup before staging, credentials or provider effects (malformed=%s)',
  async (malformed) => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), 'mitzo-retired-image-startup-'));
    vi.stubEnv('REPO_PATH', root);
    vi.stubEnv('WORKTREE_ENABLED', 'false');
    vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', join(root, 'private'));
    stubBootContext();
    const chat = await import('../chat.js');
    try {
      await expect(
        chat.startChat({ send: vi.fn(), isOpen: () => true }, 'image-startup', 'Inspect', {
          cwd: root,
          isolation: false,
          accountId: 'work-api',
          model: 'gemini-2.5-pro',
          accountProfiles: apiProfiles(),
          clientMsgId: 'image-initial',
          images: [{ data: malformed ? 'not base64' : 'cG5n', mediaType: 'image/png' }],
        }),
      ).rejects.toThrow(/Responses execution is retired/);
      expect(native.prepare).not.toHaveBeenCalled();
      expect(native.construct).not.toHaveBeenCalled();
      expect(native.credentialResolve).not.toHaveBeenCalled();
      expect(native.prompts).toEqual([]);
      expect(await readdir(root)).not.toContain('.mitzo-images');
    } finally {
      chat.registry.dispose();
      chat.eventStore.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
