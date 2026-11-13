import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FrozenHostCodexExecutable } from '../frozen-host-codex-executable.js';
const processCalls = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', () => processCalls);
import { CodexAppServerClient, SUPPORTED_CODEX_CLI_VERSION } from '../codex-app-server-client.js';
let fixtureRoot: string;
let privateHome: string;
let executable: FrozenHostCodexExecutable;

beforeEach(() => {
  fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'isolated-codex-launch-')));
  privateHome = join(fixtureRoot, 'home');
  mkdirSync(privateHome, { mode: 0o700 });
  const source = join(fixtureRoot, 'codex');
  writeFileSync(source, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]), { mode: 0o755 });
  executable = FrozenHostCodexExecutable.capture(source, privateHome);
  processCalls.spawn.mockReset();
  processCalls.spawnSync.mockReset();
  processCalls.spawnSync.mockReturnValue({
    status: 0,
    stdout: `codex-cli ${SUPPORTED_CODEX_CLI_VERSION}`,
  });
  processCalls.spawn.mockImplementation(() =>
    Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    }),
  );
});
afterEach(() => rmSync(fixtureRoot, { recursive: true, force: true }));
it('launches an isolated file-backed ChatGPT connection without inherited API credentials or keychain', () => {
  const client = CodexAppServerClient.launchIsolated(
    privateHome,
    {
      PATH: '/fixture/bin',
      HOME: '/fixture/home',
      OPENAI_API_KEY: 'secret',
      CODEX_HOME: '/source/login',
    },
    undefined,
    executable,
  );
  expect(processCalls.spawnSync).toHaveBeenCalledWith(
    executable.path,
    ['--version'],
    expect.any(Object),
  );
  const [command, argv, options] = processCalls.spawn.mock.calls[0];
  expect(command).toBe(executable.path);
  expect(argv).toContain('cli_auth_credentials_store="file"');
  expect(argv).toContain('forced_login_method="chatgpt"');
  expect(argv).toContain('model_provider="openai"');
  expect(client.modelProvider).toBe('openai');
  expect(options.env).toEqual({
    PATH: '/fixture/bin',
    HOME: '/fixture/home',
    CODEX_HOME: privateHome,
  });
  client.close();
});
it('rejects unsupported executable versions before launching the private connection', () => {
  processCalls.spawnSync.mockReturnValue({ status: 0, stdout: 'codex-cli 0.0.0' });
  expect(() => CodexAppServerClient.launchIsolated(privateHome, {}, undefined, executable)).toThrow(
    'Unsupported Codex CLI version',
  );
  expect(processCalls.spawn).not.toHaveBeenCalled();
});
it.each([
  ['official API', undefined, 'openai'],
  [
    'custom Responses API',
    {
      endpoint: 'https://gateway.example/v1',
      protocol: 'responses' as const,
      qualification: {
        source: 'operator' as const,
        streaming: true,
        toolCalls: true,
        continuation: true,
        cancellation: true,
      },
    },
    'mitzo_api',
  ],
] as const)(
  'retains the selected %s provider on a cold API launch',
  (_label, connection, provider) => {
    const client = CodexAppServerClient.launchIsolatedApiResume(
      privateHome,
      { PATH: '/fixture/bin', OPENAI_API_KEY: 'ambient-key' },
      undefined,
      executable,
      connection,
    );
    const [, argv, options] = processCalls.spawn.mock.calls[0];
    expect(argv).toContain(`model_provider="${provider}"`);
    expect(argv).toContain('forced_login_method="api"');
    expect(argv).toContain('cli_auth_credentials_store="file"');
    expect(client.modelProvider).toBe(provider);
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    if (connection) {
      expect(() => client.validateConfiguration({})).toThrow(
        'Custom Codex provider configuration does not match the selected API connection',
      );
      expect(argv).toContain('model_providers.mitzo_api.supports_websockets=false');
      expect(argv).toContain('model_providers.mitzo_api.requires_openai_auth=true');
      expect(argv).toContain(`model_providers.mitzo_api.base_url="${connection.endpoint}"`);
      expect(argv.some((arg: string) => arg.startsWith('openai_base_url='))).toBe(false);
    } else {
      expect(() => client.validateConfiguration({})).not.toThrow();
      expect(argv).toContain('openai_base_url="https://api.openai.com/v1"');
      expect(argv.some((arg: string) => arg.includes('supports_websockets'))).toBe(false);
    }
    client.close();
  },
);
it('requires a captured native executable and never falls back to PATH', () => {
  expect(() => CodexAppServerClient.launchIsolated(privateHome, {})).toThrow(
    'Host Codex runtime unavailable',
  );
  expect(processCalls.spawnSync).not.toHaveBeenCalled();
  expect(processCalls.spawn).not.toHaveBeenCalled();
});
it('keeps existing host launch opt-in behavior independent from the isolated route', () => {
  const client = CodexAppServerClient.launch('/source/login', {});
  expect(processCalls.spawn.mock.calls[0][1]).not.toContain('cli_auth_credentials_store="file"');
  client.close();
});
