import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FrozenHostCodexExecutable } from '../frozen-host-codex-executable.js';
const processes = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', () => processes);
import { CodexAppServerClient, SUPPORTED_CODEX_CLI_VERSION } from '../codex-app-server-client.js';

let root: string;
const closes: (() => void)[] = [];
const children: ReturnType<typeof child>[] = [];
const binding = {
  accountId: 'work-api',
  accountLabel: 'Work OpenAI',
  provider: 'openai',
  model: 'fixture-model',
  profileRevision: 'existing-credential-revision',
};
const lifecycle = () => ({ onNotification: vi.fn(), onRequest: vi.fn(), onClose: vi.fn() });
function child() {
  const sent: { method?: string; params?: Record<string, unknown>; id?: number }[] = [];
  const p = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  let account: unknown = { type: 'apiKey' };
  let rejectLogin = false;
  p.stdin.on('data', (bytes) => {
    const request = JSON.parse(bytes.toString());
    sent.push(request);
    if (request.id === undefined) return;
    queueMicrotask(() =>
      p.stdout.write(
        JSON.stringify({
          id: request.id,
          ...(rejectLogin && request.method === 'account/login/start'
            ? { error: { code: -32000, message: 'credential SYNTHETIC_SELECTED_KEY rejected' } }
            : {
                result:
                  request.method === 'account/read'
                    ? { account, requiresOpenaiAuth: true }
                    : request.method === 'account/login/start'
                      ? { type: 'apiKey' }
                      : {},
              }),
        }) + '\n',
      ),
    );
  });
  return {
    p,
    sent,
    setAccount(value: unknown) {
      account = value;
    },
    failLogin() {
      rejectLogin = true;
    },
  };
}
function options(name = 'work') {
  const privateHome = join(root, name);
  mkdirSync(privateHome, { mode: 0o700 });
  const source = join(root, `codex-${name}`);
  writeFileSync(source, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]), { mode: 0o755 });
  return {
    privateHome,
    executable: FrozenHostCodexExecutable.capture(source, privateHome),
    binding: { ...binding },
    signal: new AbortController().signal,
    lifecycle: lifecycle(),
    resolveKey: vi.fn().mockResolvedValue('SYNTHETIC_SELECTED_KEY'),
    assertCurrent: vi.fn().mockResolvedValue(undefined),
    base: {
      PATH: '/fixture/bin',
      HOME: '/fixture/home',
      OPENAI_API_KEY: 'AMBIENT_WRONG_KEY',
      CODEX_API_KEY: 'AMBIENT_CODEX_KEY',
      CODEX_HOME: '/shared/login',
      RANDOM_SECRET: 'private',
    },
  };
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-api-launch-')));
  processes.spawn.mockReset();
  processes.spawnSync.mockReset();
  children.length = 0;
  processes.spawnSync.mockReturnValue({
    status: 0,
    stdout: `codex-cli ${SUPPORTED_CODEX_CLI_VERSION}`,
  });
  processes.spawn.mockImplementation(() => {
    const c = child();
    children.push(c);
    return c.p;
  });
});
afterEach(() => {
  closes.splice(0).forEach((close) => close());
  rmSync(root, { recursive: true, force: true });
});

it('authenticates the existing API account over private RPC without secrets in argv or process environment', async () => {
  const o = options();
  const result = await CodexAppServerClient.launchIsolatedApi(o);
  closes.push(() => result.client.close());
  expect(result.binding).toEqual(binding);
  const [command, argv, spec] = processes.spawn.mock.calls[0];
  expect(command).toBe(o.executable.path);
  expect(argv).toContain('forced_login_method="api"');
  expect(argv).toContain('cli_auth_credentials_store="file"');
  expect(argv).toContain('features.shell_tool=false');
  expect(spec.env).toEqual({
    PATH: '/fixture/bin',
    HOME: '/fixture/home',
    CODEX_HOME: o.privateHome,
  });
  expect(JSON.stringify([argv, spec])).not.toContain('KEY');
  expect(children[0].sent.map((r) => r.method)).toEqual([
    'initialize',
    'initialized',
    'account/login/start',
    'account/read',
  ]);
  expect(children[0].sent[2].params).toEqual({ type: 'apiKey', apiKey: 'SYNTHETIC_SELECTED_KEY' });
  expect(o.resolveKey).toHaveBeenCalledExactlyOnceWith(binding, o.signal);
  await expect(result.client.request('account/login/start', { type: 'chatgpt' })).rejects.toThrow(
    'not supported',
  );
  expect(children[0].sent).toHaveLength(4);
});

it.each(['openai-codex', 'google-vertex', 'unavailable'])(
  'rejects %s billing before credentials or process effects',
  async (provider) => {
    const o = options();
    o.binding.provider = provider;
    await expect(CodexAppServerClient.launchIsolatedApi(o)).rejects.toThrow(
      'API Codex authentication unavailable',
    );
    expect(o.resolveKey).not.toHaveBeenCalled();
    expect(processes.spawn).not.toHaveBeenCalled();
  },
);

it('does not launch when the selected credential is missing or the owning authority is revoked', async () => {
  const o = options();
  o.resolveKey.mockRejectedValue(new Error('secret store contains SYNTHETIC_SELECTED_KEY'));
  await expect(CodexAppServerClient.launchIsolatedApi(o)).rejects.toThrow(
    'API Codex authentication unavailable',
  );
  expect(processes.spawn).not.toHaveBeenCalled();
  o.resolveKey.mockResolvedValue('');
  await expect(CodexAppServerClient.launchIsolatedApi(o)).rejects.toThrow(
    'API Codex authentication unavailable',
  );
  expect(processes.spawn).not.toHaveBeenCalled();
  o.resolveKey.mockResolvedValue('SYNTHETIC_SELECTED_KEY');
  o.assertCurrent.mockRejectedValue(new Error('revoked'));
  await expect(CodexAppServerClient.launchIsolatedApi(o)).rejects.toThrow(
    'API Codex authentication unavailable',
  );
  expect(processes.spawn).not.toHaveBeenCalled();
});

it('rechecks cancellation after credential resolution before launching', async () => {
  const o = options(),
    controller = new AbortController();
  o.signal = controller.signal;
  o.resolveKey.mockImplementation(async () => {
    controller.abort();
    return 'SYNTHETIC_SELECTED_KEY';
  });
  await expect(CodexAppServerClient.launchIsolatedApi(o)).rejects.toThrow(
    'API Codex authentication unavailable',
  );
  expect(processes.spawn).not.toHaveBeenCalled();
});

it('closes the process when cancellation arrives during authentication', async () => {
  const o = options(),
    controller = new AbortController();
  o.signal = controller.signal;
  processes.spawn.mockImplementation(() => {
    const c = child();
    children.push(c);
    c.p.stdin.on('data', (bytes) => {
      if (JSON.parse(bytes.toString()).method === 'account/login/start') controller.abort();
    });
    return c.p;
  });
  await expect(CodexAppServerClient.launchIsolatedApi(o)).rejects.toThrow(
    'API Codex authentication unavailable',
  );
  expect(children[0].p.kill).toHaveBeenCalledOnce();
  expect(children[0].sent.some((r) => r.method === 'account/read')).toBe(false);
});

it.each([
  null,
  { type: 'chatgpt', email: 'other@example.test', planType: 'pro' },
  { type: 'amazonBedrock' },
])('refuses a successful login whose observed account is %j', async (account) => {
  const o = options();
  processes.spawn.mockImplementation(() => {
    const c = child();
    c.setAccount(account);
    children.push(c);
    return c.p;
  });
  await expect(CodexAppServerClient.launchIsolatedApi(o)).rejects.toThrow(
    'API Codex authentication unavailable',
  );
  expect(children[0].p.kill).toHaveBeenCalledOnce();
});

it('redacts failed login diagnostics and closes without attempting a model turn', async () => {
  const o = options();
  processes.spawn.mockImplementation(() => {
    const c = child();
    c.failLogin();
    children.push(c);
    return c.p;
  });
  await expect(CodexAppServerClient.launchIsolatedApi(o)).rejects.toThrow(
    'API Codex authentication unavailable',
  );
  expect(children[0].p.kill).toHaveBeenCalledOnce();
  expect(children[0].sent.some((r) => r.method === 'turn/start')).toBe(false);
});

it('keeps two API accounts in separate processes and private homes without modifying their source bindings', async () => {
  const a = options('a'),
    b = options('b');
  b.binding.accountId = 'other-api';
  b.resolveKey.mockResolvedValue('SYNTHETIC_OTHER_KEY');
  const results = await Promise.all([
    CodexAppServerClient.launchIsolatedApi(a),
    CodexAppServerClient.launchIsolatedApi(b),
  ]);
  results.forEach((r) => closes.push(() => r.client.close()));
  expect(results.map((r) => r.binding.accountId)).toEqual(['work-api', 'other-api']);
  expect(processes.spawn.mock.calls.map((call) => call[2].env.CODEX_HOME)).toEqual([
    a.privateHome,
    b.privateHome,
  ]);
  expect(
    children.map((c) => c.sent.find((r) => r.method === 'account/login/start')!.params!.apiKey),
  ).toEqual(['SYNTHETIC_SELECTED_KEY', 'SYNTHETIC_OTHER_KEY']);
  expect(a.binding).toEqual(binding);
});

it('requires the captured executable belonging to the selected private home', async () => {
  const a = options('a'),
    b = options('b');
  a.executable = b.executable;
  await expect(CodexAppServerClient.launchIsolatedApi(a)).rejects.toThrow(
    'API Codex authentication unavailable',
  );
  expect(processes.spawn).not.toHaveBeenCalled();
});

it.each(['auth.json', 'config.toml'])(
  'rejects %s introduced while awaiting the selected credential',
  async (filename) => {
    const o = options();
    o.resolveKey.mockImplementation(async () => {
      writeFileSync(join(o.privateHome, filename), '{}', { mode: 0o600 });
      return 'SYNTHETIC_SELECTED_KEY';
    });
    await expect(CodexAppServerClient.launchIsolatedApi(o)).rejects.toThrow(
      'API Codex authentication unavailable',
    );
    expect(processes.spawn).not.toHaveBeenCalled();
  },
);

it.each(['auth.json', 'config.toml'])(
  'refuses a dangling %s symlink in a new home',
  async (filename) => {
    const o = options();
    symlinkSync(join(root, 'missing-private-file'), join(o.privateHome, filename));
    await expect(CodexAppServerClient.launchIsolatedApi(o)).rejects.toThrow(
      'API Codex authentication unavailable',
    );
    expect(o.resolveKey).not.toHaveBeenCalled();
    expect(processes.spawn).not.toHaveBeenCalled();
  },
);

const gateway = {
  endpoint: 'https://gateway.example.test/v1',
  protocol: 'responses' as const,
  qualification: {
    source: 'operator' as const,
    streaming: true,
    toolCalls: true,
    continuation: true,
    cancellation: true,
  },
};
it('pins a qualified endpoint through bootstrap and cold resume without inheriting another destination', async () => {
  const o = { ...options(), connection: structuredClone(gateway) };
  o.resolveKey.mockImplementation(async () => {
    o.connection.endpoint = 'https://mutated.example.test/v1';
    return 'SYNTHETIC_SELECTED_KEY';
  });
  const launched = await CodexAppServerClient.launchIsolatedApi(o);
  closes.push(() => launched.client.close());
  expect(processes.spawn.mock.calls[0][1]).toContain(
    'openai_base_url="https://gateway.example.test/v1"',
  );
  expect(processes.spawn.mock.calls[0][1]).toContain('model_provider="openai"');
  expect(processes.spawn.mock.calls[0][1]).not.toContain(
    'openai_base_url="https://api.openai.com/v1"',
  );
  const resumed = CodexAppServerClient.launchIsolatedApiResume(
    o.privateHome,
    o.base,
    o.lifecycle,
    o.executable,
    gateway,
  );
  closes.push(() => resumed.close());
  expect(processes.spawn.mock.calls[1][1]).toContain(
    'openai_base_url="https://gateway.example.test/v1"',
  );
  expect(children[1].sent).toEqual([]);
});
it.each([
  { ...gateway, protocol: 'messages' },
  { ...gateway, qualification: undefined },
  { ...gateway, endpoint: 'https://user:secret@gateway.example.test/v1' },
  { ...gateway, qualification: { ...gateway.qualification, continuation: false } },
])(
  'rejects unsupported launch connection before credentials or process effects %j',
  async (connection) => {
    const o = { ...options(), connection };
    await expect(CodexAppServerClient.launchIsolatedApi(o as never)).rejects.toThrow(
      'API Codex authentication unavailable',
    );
    expect(o.resolveKey).not.toHaveBeenCalled();
    expect(processes.spawn).not.toHaveBeenCalled();
    expect(() =>
      CodexAppServerClient.launchIsolatedApiResume(
        o.privateHome,
        o.base,
        o.lifecycle,
        o.executable,
        connection as never,
      ),
    ).toThrow();
    expect(processes.spawn).not.toHaveBeenCalled();
  },
);

it('isolates concurrent API accounts with distinct endpoints and credential references', async () => {
  const a = { ...options('gateway-a'), connection: structuredClone(gateway) };
  const b = {
    ...options('gateway-b'),
    connection: { ...gateway, endpoint: 'https://other.example.test/responses-api' },
  };
  b.binding.accountId = 'other-gateway-account';
  a.resolveKey.mockResolvedValue('SYNTHETIC_ACCOUNT_A_KEY');
  b.resolveKey.mockResolvedValue('SYNTHETIC_ACCOUNT_B_KEY');
  const results = await Promise.all([
    CodexAppServerClient.launchIsolatedApi(a),
    CodexAppServerClient.launchIsolatedApi(b),
  ]);
  results.forEach((result) => closes.push(() => result.client.close()));
  const calls = processes.spawn.mock.calls;
  for (const [index, selected] of [a, b].entries()) {
    expect(calls[index][1]).toContain(
      `openai_base_url=${JSON.stringify(selected.connection.endpoint)}`,
    );
    expect(calls[index][2].env.CODEX_HOME).toBe(selected.privateHome);
    expect(
      children[index].sent.find((request) => request.method === 'account/login/start')?.params
        ?.apiKey,
    ).toBe(index === 0 ? 'SYNTHETIC_ACCOUNT_A_KEY' : 'SYNTHETIC_ACCOUNT_B_KEY');
  }
  expect(a.resolveKey).toHaveBeenCalledWith(a.binding, a.signal);
  expect(b.resolveKey).toHaveBeenCalledWith(b.binding, b.signal);
});
