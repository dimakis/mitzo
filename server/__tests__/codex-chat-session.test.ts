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
  store: vi.fn(),
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
    close = mocks.close;
    send = mocks.send;
  },
}));
vi.mock('../codex-mcp-tools.js', () => ({ connectCodexMcpTools: mocks.connect }));
vi.mock('../codex-private-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../codex-private-path.js')>()),
  codexPrivateDirectory: () => '/tmp',
}));
import {
  openCodexChat,
  selectedOpenShellAccountRoute,
  waitForCodexRuntime,
  waitForCodexRuntimeBySessionId,
} from '../codex-chat-session.js';
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
