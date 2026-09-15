import { expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  close: vi.fn(),
  send: vi.fn(),
  mcpClose: vi.fn(),
  connect: vi.fn(),
  permissionHandler: vi.fn(),
  store: vi.fn(),
  privateDirectory: '/tmp',
  conversationOptions: undefined as Record<string, unknown> | undefined,
}));
vi.mock('../codex-conversation-store.js', () => ({
  CodexConversationStore: class {
    constructor() {
      mocks.store();
    }
    recoverAtStartup() {}
  },
}));
vi.mock('../codex-conversation.js', () => ({
  CodexConversation: class {
    constructor(options: { onClosed: () => void }) {
      mocks.conversationOptions = options;
      mocks.close.mockImplementation(options.onClosed);
    }
    initialize = mocks.initialize;
    getThreadId = vi.fn(() => 'thread');
    close = mocks.close;
    send = mocks.send;
  },
}));
vi.mock('../codex-mcp-tools.js', () => ({ connectCodexMcpTools: mocks.connect }));
vi.mock('../codex-private-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../codex-private-path.js')>()),
  codexPrivateDirectory: () => mocks.privateDirectory,
}));
vi.mock('@mitzo/harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mitzo/harness')>()),
  buildPermissionHandler: () => mocks.permissionHandler,
}));
import {
  openCodexChat,
  publicCodexRuntimeError,
  selectedOpenShellAccountRoute,
  waitForCodexRuntime,
  waitForCodexRuntimeBySessionId,
} from '../codex-chat-session.js';
import { OpenShellRuntimeManager } from '../openshell-runtime.js';
import * as lifecycleController from '../openshell-lifecycle-controller.js';

it('forwards only recognized sanitized Codex diagnostics', () => {
  expect(
    publicCodexRuntimeError(
      new Error(
        'OpenShell denied the provider request because its credential-bearing body could not be inspected.',
      ),
    ),
  ).toBe(
    'OpenShell denied the provider request because its credential-bearing body could not be inspected.',
  );
  expect(publicCodexRuntimeError(new Error('Bearer sk-secret at https://private.example'))).toBe(
    'Codex turn failed. Inspect queued work before retrying.',
  );
});
function options(abortController: AbortController) {
  return {
    session: { cwd: '/tmp', abortController },
    mcpServers: {},
    profile: { planType: 'api', credentialRef: '/test/login' },
  } as Parameters<typeof openCodexChat>[0];
}
it('routes the selected model when provisioning an OpenShell subscription', () => {
  expect(
    selectedOpenShellAccountRoute({
      binding: {
        accountId: 'personal',
        accountLabel: 'Personal ChatGPT',
        provider: 'openai-codex',
        model: 'bound-model',
        profileRevision: 'revision',
      },
      model: 'selected-model',
      profile: {
        accountId: 'personal',
        accountLabel: 'Personal ChatGPT',
        credentialRef: '/test/login',
        email: 'test@example.invalid',
        planType: 'pro',
        sandboxProvider: 'personal-chatgpt',
        sandboxProviderType: 'openai-codex-oauth',
        sandboxProviderId: 'provider-id',
        sandboxGrantId: 'grant-id',
        model: 'bound-model',
      },
    }),
  ).toMatchObject({ kind: 'chatgpt-subscription', model: 'selected-model' });
});
it('does not open MCP processes if private storage is unavailable', async () => {
  mocks.store.mockImplementationOnce(() => {
    throw new Error('storage unavailable');
  });
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  await expect(openCodexChat(options(new AbortController()))).rejects.toThrow(
    'storage unavailable',
  );
  expect(mocks.connect).not.toHaveBeenCalled();
});
it('closes an initialization aborted before the first turn starts', async () => {
  const abort = new AbortController();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  mocks.initialize.mockImplementationOnce(async () => {
    abort.abort();
  });
  await expect(openCodexChat(options(abort))).rejects.toThrow();
  expect(mocks.close).toHaveBeenCalled();
  expect(mocks.mcpClose).toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});

it('waits for cold-reconnect runtime registration', async () => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  let release!: () => void;
  mocks.initialize.mockImplementationOnce(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  const abort = new AbortController();
  const opts = options(abort);
  const opening = openCodexChat(opts);
  const waiting = waitForCodexRuntime(opts.session, 1000);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  release();
  await opening;
  expect(await waiting).toBeDefined();
  abort.abort();
});

it('waits for the reconnect session and runtime to both register', async () => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  const registry = {
    findBySessionId: vi.fn(() => undefined),
  } as unknown as import('@mitzo/harness').SessionRegistry;
  const abort = new AbortController();
  const opts = options(abort);
  const waiting = waitForCodexRuntimeBySessionId(registry, 'session', 1000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  registry.findBySessionId = vi.fn(() => ({ session: opts.session, clientId: 'client' }));
  await openCodexChat(opts);
  expect(await waiting).toBeDefined();
  abort.abort();
});

it('cancels reconnect polling when the request is aborted', async () => {
  const registry = {
    findBySessionId: vi.fn(() => undefined),
  } as unknown as import('@mitzo/harness').SessionRegistry;
  const abort = new AbortController();
  const waiting = waitForCodexRuntimeBySessionId(registry, 'session', 5000, abort.signal);
  abort.abort();
  await expect(waiting).resolves.toBeUndefined();
  expect(registry.findBySessionId).toHaveBeenCalledTimes(1);
});

it('cleans each resource once across explicit close, runtime close and abort', async () => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  const abort = new AbortController();
  const chat = await openCodexChat(options(abort));
  chat.close();
  chat.close();
  abort.abort();
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.mcpClose).toHaveBeenCalledTimes(1);
});

it('does not advertise unavailable host tools to an OpenShell runtime', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'sandbox');
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  const chat = await openCodexChat({
    ...options(new AbortController()),
    systemPrompt: 'base prompt',
  });
  expect(mocks.conversationOptions?.systemPrompt).toContain(
    'In Agent or Auto mode, a user request to edit that workspace is the required approval',
  );
  expect(mocks.conversationOptions?.systemPrompt).not.toContain('Mitzo supplies host tools');
  expect(mocks.conversationOptions?.runtimeConfig).toEqual({ web_search: 'disabled' });
  expect(mocks.connect).not.toHaveBeenCalled();
  await expect(chat.setPermissionMode?.('agent')).resolves.toBeUndefined();
  await expect(chat.setPermissionMode?.('ask')).rejects.toThrow('Ask mode');
  vi.unstubAllEnvs();
});

it('advertises reviewed per-chat provider grants to a managed OpenShell runtime', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'mitzo-runtime:1');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', '/config/policy.yaml');
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/seed/mgmt');
  vi.stubEnv('MITZO_OPENSHELL_GRANTABLE_SERVICE_PROVIDERS', 'google-workspace,github');
  const ensure = vi.spyOn(OpenShellRuntimeManager.prototype, 'ensure').mockResolvedValue({
    sandboxName: 'mitzo-runtime',
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server',
    cli: 'openshell',
    gateway: 'openshell',
    workspace: 'default',
    gatewayInsecure: false,
  });
  const compile = vi.spyOn(OpenShellRuntimeManager.prototype, 'compileContext').mockResolvedValue({
    type: 'boot_context',
    scope: 'sandbox',
    sourceCount: 0,
    tokenCount: 0,
    tokenBudget: 12000,
    sources: [],
    included: [],
    trimmed: [],
    fullMarkdown: '',
  });
  const grant = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'grantServiceProvider')
    .mockResolvedValue();
  const hasAccess = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'hasServiceProviderAccess')
    .mockReturnValue(false);
  const abortController = new AbortController();
  const baseOptions = options(abortController);
  const session = baseOptions.session;
  const registry = {
    findBySessionId: vi.fn(() => ({ clientId: 'client', session })),
  } as unknown as import('@mitzo/harness').SessionRegistry;
  try {
    await openCodexChat({
      ...baseOptions,
      conversationId: 'conversation',
      binding: {
        accountId: 'work',
        accountLabel: 'Work',
        provider: 'openai',
        model: 'test-model',
        profileRevision: '1',
      },
      profile: {
        accountId: 'work',
        accountLabel: 'Work',
        email: 'work@example.com',
        planType: 'api',
        model: 'test-model',
        sandboxProvider: 'openai-work',
      },
      session,
      registry,
      prompt: 'Grant Google Workspace access',
      messageId: 'message',
      systemPrompt: 'base prompt',
      env: {},
    });
    expect(mocks.conversationOptions?.tools).toEqual([
      expect.objectContaining({
        name: 'GrantIntegrationAccess',
        input_schema: expect.objectContaining({
          properties: expect.objectContaining({
            provider: expect.objectContaining({ enum: ['google-workspace', 'github'] }),
          }),
        }),
      }),
    ]);
    expect(mocks.conversationOptions?.systemPrompt).toContain('GrantIntegrationAccess');
    expect(mocks.conversationOptions?.systemPrompt).toContain(
      'Mitzo preflights explicit requests for grantable integrations',
    );
    const prepareTurn = mocks.conversationOptions?.prepareTurn as (
      prompt: string,
      signal: AbortSignal,
    ) => Promise<string | void>;
    const executeTool = mocks.conversationOptions?.executeTool as (
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<{ content: string; isError: boolean }>;
    const signal = new AbortController().signal;

    mocks.permissionHandler.mockResolvedValueOnce({
      behavior: 'allow',
      updatedInput: { provider: 'google-workspace' },
    });
    await expect(prepareTurn('look through my emails and Google Docs', signal)).resolves.toBe(
      undefined,
    );
    expect(grant).toHaveBeenCalledWith(
      'conversation',
      expect.objectContaining({ sandboxName: 'mitzo-runtime' }),
      'google-workspace',
      signal,
    );
    expect(mocks.permissionHandler).toHaveBeenCalledWith(
      'GrantIntegrationAccess',
      { provider: 'google-workspace' },
      expect.objectContaining({ forcePrompt: true, approvalScope: 'conversation' }),
    );
    vi.clearAllMocks();

    await expect(prepareTurn('draft an email to Cat', signal)).resolves.toBe(undefined);
    expect(mocks.permissionHandler).not.toHaveBeenCalled();

    hasAccess.mockReturnValueOnce(true);
    await expect(prepareTurn('search Gmail again', signal)).resolves.toBe(undefined);
    expect(mocks.permissionHandler).not.toHaveBeenCalled();

    mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'deny', message: 'Denied' });
    await expect(prepareTurn('find a document in Google Drive', signal)).resolves.toContain(
      'Do not run its CLI or claim a gateway outage',
    );
    expect(grant).not.toHaveBeenCalled();
    vi.clearAllMocks();

    await expect(
      executeTool('GrantIntegrationAccess', { provider: 'unreviewed-provider' }, signal),
    ).resolves.toMatchObject({ isError: true });
    expect(mocks.permissionHandler).not.toHaveBeenCalled();

    mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'deny', message: 'Denied' });
    await expect(
      executeTool('GrantIntegrationAccess', { provider: 'google-workspace' }, signal),
    ).resolves.toMatchObject({ isError: true });
    expect(grant).not.toHaveBeenCalled();

    mocks.permissionHandler.mockResolvedValueOnce({
      behavior: 'allow',
      updatedInput: { provider: 'google-workspace' },
    });
    await expect(
      executeTool('GrantIntegrationAccess', { provider: 'google-workspace' }, signal),
    ).resolves.toMatchObject({ isError: false });
    expect(grant).toHaveBeenCalledOnce();

    mocks.permissionHandler.mockResolvedValueOnce({
      behavior: 'allow',
      updatedInput: { provider: 'github' },
    });
    await expect(
      executeTool('GrantIntegrationAccess', { provider: 'google-workspace' }, signal),
    ).resolves.toMatchObject({ isError: true });
    expect(grant).toHaveBeenCalledOnce();
    expect(mocks.permissionHandler).toHaveBeenCalledWith(
      'GrantIntegrationAccess',
      { provider: 'google-workspace' },
      expect.objectContaining({
        forcePrompt: true,
        approvalScope: 'conversation',
        title: 'Grant Google Workspace to this conversation?',
        description: expect.stringContaining('across reconnects and Mitzo restarts'),
      }),
    );

    mocks.permissionHandler.mockResolvedValueOnce({ behavior: 'deny', message: 'Denied' });
    await executeTool('GrantIntegrationAccess', { provider: 'github' }, signal);
    expect(mocks.permissionHandler).toHaveBeenLastCalledWith(
      'GrantIntegrationAccess',
      { provider: 'github' },
      expect.objectContaining({
        title: 'Grant GitHub to this conversation?',
        description: expect.stringContaining('reviewed GitHub provider'),
      }),
    );
  } finally {
    ensure.mockRestore();
    compile.mockRestore();
    grant.mockRestore();
    hasAccess.mockRestore();
    vi.unstubAllEnvs();
  }
});

it('registers a newly ensured sandbox before context initialization can fail', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'mitzo-runtime:1');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', '/config/policy.yaml');
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/seed/mgmt');
  const ensure = vi.spyOn(OpenShellRuntimeManager.prototype, 'ensure').mockResolvedValue({
    sandboxName: 'mitzo-runtime',
    sandboxId: 'physical-id',
    created: true,
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server',
    cli: 'openshell',
    gateway: 'openshell',
    workspace: 'default',
    gatewayInsecure: false,
  });
  const provisional = vi.spyOn(lifecycleController, 'registerOpenShellLifecycleProvisional');
  const compile = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'compileContext')
    .mockImplementationOnce(async () => {
      expect(provisional).toHaveBeenCalledWith(
        'conversation',
        expect.objectContaining({ sandboxId: 'physical-id', created: true }),
        expect.objectContaining({ provider: 'openai-work' }),
        'client',
      );
      throw new Error('context initialization failed');
    });
  const abortController = new AbortController();
  const baseOptions = options(abortController);
  const session = baseOptions.session;
  const registry = {
    findBySessionId: vi.fn(() => ({ clientId: 'client', session })),
  } as unknown as import('@mitzo/harness').SessionRegistry;
  try {
    await expect(
      openCodexChat({
        ...baseOptions,
        conversationId: 'conversation',
        binding: {
          accountId: 'work',
          accountLabel: 'Work',
          provider: 'openai',
          model: 'test-model',
          profileRevision: '1',
        },
        profile: {
          accountId: 'work',
          accountLabel: 'Work',
          email: 'work@example.com',
          planType: 'api',
          model: 'test-model',
          sandboxProvider: 'openai-work',
        },
        session,
        registry,
        prompt: 'test',
        messageId: 'message',
        systemPrompt: 'base prompt',
        env: {},
      }),
    ).rejects.toThrow('context initialization failed');
    expect(provisional).toHaveBeenCalledOnce();
    expect(mocks.initialize).not.toHaveBeenCalled();
  } finally {
    ensure.mockRestore();
    provisional.mockRestore();
    compile.mockRestore();
    vi.unstubAllEnvs();
  }
});

it('rejects the legacy shared-sandbox seam in production', async () => {
  vi.clearAllMocks();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'shared-sandbox');
  try {
    await expect(openCodexChat(options(new AbortController()))).rejects.toThrow(
      'disabled in production',
    );
    expect(mocks.initialize).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('rejects OpenShell Ask mode before enabling provider-native tools', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'sandbox');
  try {
    await expect(
      openCodexChat({
        ...options(new AbortController()),
        session: { ...options(new AbortController()).session, mode: 'ask' },
      }),
    ).rejects.toThrow('Ask mode');
    expect(mocks.initialize).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('never loads trusted project hooks on the host for OpenShell sessions', async () => {
  vi.clearAllMocks();
  const cwd = mkdtempSync(join(tmpdir(), 'mitzo-openshell-hooks-'));
  const marker = join(cwd, 'host-hook-ran');
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(
    join(cwd, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: `touch ${marker}` }] }],
      },
    }),
  );
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'sandbox');
  vi.stubEnv('MITZO_TRUST_PROJECT_HOOKS', '1');
  try {
    await openCodexChat({
      ...options(new AbortController()),
      session: { ...options(new AbortController()).session, cwd },
    });
    expect(existsSync(marker)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it('fails closed instead of substituting API billing for a ChatGPT subscription in OpenShell', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_SANDBOX_NAME', 'sandbox');
  await expect(
    openCodexChat({
      ...options(new AbortController()),
      profile: {
        accountId: 'personal',
        accountLabel: 'Personal ChatGPT',
        credentialRef: '/test/login',
        email: 'test@example.invalid',
        planType: 'pro',
        model: 'test-model',
      },
    }),
  ).rejects.toThrow('brokered Codex OAuth');
  expect(mocks.initialize).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});

it('rejects managed OpenShell subscription profiles before provisioning a sandbox', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'mitzo-runtime:1');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', '/config/policy.yaml');
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/seed/mgmt');
  try {
    await expect(
      openCodexChat({
        ...options(new AbortController()),
        profile: {
          accountId: 'personal',
          accountLabel: 'Personal ChatGPT',
          credentialRef: '/test/login',
          email: 'test@example.invalid',
          planType: 'pro',
          model: 'test-model',
          sandboxProvider: 'personal-chatgpt',
        },
      }),
    ).rejects.toThrow('brokered Codex OAuth');
    expect(mocks.initialize).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('rejects managed OpenShell API profiles without an account provider binding', async () => {
  vi.clearAllMocks();
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'mitzo-runtime:1');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', '/config/policy.yaml');
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/seed/mgmt');
  try {
    await expect(openCodexChat(options(new AbortController()))).rejects.toThrow(
      'sandbox provider binding',
    );
    expect(mocks.initialize).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('preserves first launch and valid restore while failing closed for a replacement with no lifecycle state', async () => {
  vi.clearAllMocks();
  const directory = mkdtempSync(join(tmpdir(), 'mitzo-openshell-chat-resume-'));
  const policy = join(directory, 'policy.yaml');
  writeFileSync(policy, 'reviewed: policy\n');
  mocks.privateDirectory = directory;
  vi.stubEnv('MITZO_OPENSHELL_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_LIFECYCLE_ENABLED', '1');
  vi.stubEnv('MITZO_OPENSHELL_IMAGE', 'mitzo-runtime:1');
  vi.stubEnv('MITZO_OPENSHELL_POLICY', policy);
  vi.stubEnv('MITZO_OPENSHELL_SEED', '/seed/mgmt');
  const lifecycle = lifecycleController.initializeOpenShellLifecycle(
    {
      cli: 'openshell',
      image: 'mitzo-runtime:1',
      policy,
      seed: '/seed/mgmt',
      serviceProviders: [],
      grantableServiceProviders: [],
      workspace: 'default',
      gateway: 'openshell',
      gatewayInsecure: false,
      createDetached: true,
      sandboxIdLength: 13,
      workdir: '/sandbox/workspaces/mgmt',
      webSearch: 'disabled',
    },
    {
      registry: { findBySessionId: () => undefined, entries: function* () {} },
      eventStore: { getSession: () => ({}) },
      taskStore: { getTree: () => [] },
      queue: () => ({ queued: 0, running: 0, recovery: false }),
    },
  )!;
  const replacement = {
    sandboxName: 'mitzo-runtime',
    sandboxId: 'replacement-id',
    created: true,
    workdir: '/sandbox/workspaces/mgmt',
    appServerCommand: '/sandbox/run-mitzo-app-server' as const,
    cli: 'openshell',
    gateway: 'openshell',
    workspace: 'default',
    gatewayInsecure: false,
  };
  const restored = { ...replacement, sandboxId: 'restored-id', created: false };
  const ensure = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'ensure')
    .mockResolvedValueOnce(replacement)
    .mockResolvedValueOnce(replacement)
    .mockResolvedValueOnce(restored);
  const provisional = vi.spyOn(lifecycleController, 'registerOpenShellLifecycleProvisional');
  const compile = vi
    .spyOn(OpenShellRuntimeManager.prototype, 'compileContext')
    .mockRejectedValueOnce(new Error('context initialization failed'))
    .mockResolvedValue({
      type: 'boot_context',
      scope: 'sandbox',
      sourceCount: 0,
      tokenCount: 0,
      tokenBudget: 12000,
      sources: [],
      included: [],
      trimmed: [],
      fullMarkdown: '',
    });
  const baseOptions = options(new AbortController());
  const session = baseOptions.session;
  const registry = {
    findBySessionId: vi.fn(() => ({ clientId: 'client', session })),
  } as unknown as import('@mitzo/harness').SessionRegistry;
  const binding = {
    accountId: 'work',
    accountLabel: 'Work',
    provider: 'openai',
    model: 'test-model',
    profileRevision: '1',
  };
  const profile = {
    accountId: 'work',
    accountLabel: 'Work',
    email: 'work@example.com',
    planType: 'api' as const,
    model: 'test-model',
    sandboxProvider: 'openai-work',
  };
  const chatOptions = (conversationId: string, resume = false) => ({
    ...baseOptions,
    resume,
    conversationId,
    binding,
    profile,
    session,
    registry,
    prompt: 'resume',
    messageId: 'message',
    systemPrompt: 'base prompt',
    env: {},
  });
  try {
    await expect(openCodexChat(chatOptions('first-launch'))).rejects.toThrow(
      'context initialization failed',
    );
    expect(lifecycle.store.get('first-launch')).toMatchObject({
      physicalSandboxId: 'replacement-id',
      identity: null,
    });

    await expect(openCodexChat(chatOptions('missing-lifecycle-state', true))).rejects.toThrow(
      'OpenShell existing conversation has no verified recovery record',
    );
    expect(provisional).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(lifecycle.store.get('missing-lifecycle-state')).toBeNull();

    lifecycleController.registerOpenShellLifecycle(
      'valid-lifecycle-state',
      restored,
      binding,
      { kind: 'api', provider: 'openai-work', model: 'test-model' },
      'thread',
      'client',
    );
    const chat = await openCodexChat(chatOptions('valid-lifecycle-state', true));
    expect(mocks.initialize).toHaveBeenCalled();
    expect(lifecycle.store.get('valid-lifecycle-state')).toMatchObject({
      physicalSandboxId: 'restored-id',
      identity: expect.objectContaining({ threadId: 'thread' }),
    });
    chat.close();
  } finally {
    ensure.mockRestore();
    provisional.mockRestore();
    compile.mockRestore();
    lifecycle.store.close();
    mocks.privateDirectory = '/tmp';
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});
