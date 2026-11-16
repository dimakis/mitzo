import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { SandboxWorkerPayload } from '../sandboxed-command-worker.js';
import { HOST_GITHUB_TOKEN_TRANSFER } from '../host-github-credential.js';
import { canonical } from '../sandbox-authority.js';
import { claudeLoginSdkBoundary, credentialSdkBoundary } from '../credential-sdk-boundary.js';
const mocked = vi.hoisted(() => ({ spawn: vi.fn(), dependencies: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  spawn: mocked.spawn,
}));
vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: { checkDependencies: mocked.dependencies },
}));
beforeEach(() => {
  resetOfflineUserEnvironment();
  vi.stubEnv('PATH', '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin');
  mocked.spawn.mockReset();
  mocked.dependencies.mockReturnValue({ errors: [], warnings: [] });
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '1');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function child() {
  return Object.assign(new EventEmitter(), {
    pid: 99999,
    exitCode: null as number | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}
it('limits ordinary SDK writes to its launch workspace, selected account and private scratch', () => {
  const handle = child();
  mocked.spawn.mockReturnValue(handle);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  const boundary = credentialSdkBoundary('darwin')!;
  boundary.spawnClaudeCodeProcess({
    command: '/usr/bin/true',
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  const payload = JSON.parse(
    readFileSync(mocked.spawn.mock.calls[0][1].at(-1), 'utf8'),
  ) as SandboxWorkerPayload;
  expect(payload.config.filesystem.allowWrite).not.toContain('/');
  expect(payload.config.filesystem.allowWrite).toContain(payload.cwd);
  expect(payload.env?.TMPDIR).toBeDefined();
  expect(payload.config.filesystem.allowWrite).toContain(payload.env?.TMPDIR);
  expect(payload.config.filesystem.allowWrite).toContain(canonical(join(homedir(), '.claude')));
  handle.emit('close', 0, null);
});
it('captures the complete actual SDK read projection only after its owned launch, including private patterns', () => {
  const handle = child();
  mocked.spawn.mockReturnValue(handle);
  const boundary = credentialSdkBoundary('darwin')!;
  expect(() => boundary.captureRepositoryReadProjection()).toThrow();
  boundary.spawnClaudeCodeProcess({
    command: '/usr/bin/true',
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  const payload = JSON.parse(
    readFileSync(mocked.spawn.mock.calls[0][1].at(-1), 'utf8'),
  ) as SandboxWorkerPayload;
  const projection = boundary.captureRepositoryReadProjection();
  expect(projection.readableRoots).toEqual(['/']);
  expect([...projection.deniedRoots, ...projection.deniedReadPatterns].sort()).toEqual(
    [...payload.config.filesystem.denyRead].sort(),
  );
  expect(projection.deniedReadPatterns).toEqual(
    expect.arrayContaining([
      expect.stringContaining('.env.before-runtime-*'),
      expect.stringContaining('.env.runtime-*'),
    ]),
  );
  projection.assertCurrentSync();
  expect(() => (projection.deniedRoots as string[]).splice(0)).toThrow();
  handle.emit('close', 0, null);
});
it('admits only the native login terminal while keeping callback and loopback policy unchanged', () => {
  vi.spyOn(process, 'kill').mockReturnValue(true);
  for (const login of [false, true]) {
    const handle = child();
    mocked.spawn.mockReturnValue(handle);
    const boundary = login ? claudeLoginSdkBoundary('darwin')! : credentialSdkBoundary('darwin')!;
    boundary.spawnClaudeCodeProcess({
      command: '/usr/bin/true',
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const payload = JSON.parse(
      readFileSync(mocked.spawn.mock.calls.at(-1)![1].at(-1), 'utf8'),
    ) as SandboxWorkerPayload;
    expect(payload.config.network.allowLocalBinding).toBe(false);
    expect(payload.config.allowPty).toBe(login);
    expect(payload.config.network.allowAllUnixSockets).toBe(false);
    expect(payload.config.filesystem.denyRead).toEqual(
      expect.arrayContaining(boundary.deniedRoots),
    );
    expect(payload.config.filesystem.denyWrite).toEqual(
      expect.arrayContaining(boundary.deniedRoots),
    );
    expect(payload.config.network.allowedDomains).not.toContain('*');
    handle.emit('close', 0, null);
  }
});
it('keeps injected SDK environment out of trusted bootstrap, quotes argv and freezes private roots', () => {
  const handle = child();
  mocked.spawn.mockReturnValue(handle);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const boundary = credentialSdkBoundary('darwin')!;
  expect(() => boundary.deniedRoots.splice(0)).toThrow();
  const result = boundary.spawnClaudeCodeProcess({
    command: '/usr/bin/printf',
    args: ["a'b", '$(cat /private/controller.json)'],
    env: { NODE_PATH: '/untrusted', DYLD_INSERT_LIBRARIES: '/untrusted' },
    signal: new AbortController().signal,
  });
  const [command, args, options] = mocked.spawn.mock.calls[0];
  expect(command).toBe(process.execPath);
  expect(options.env).not.toHaveProperty('NODE_PATH');
  expect(options.env).not.toHaveProperty('DYLD_INSERT_LIBRARIES');
  expect(options.detached).toBe(true);
  expect(options.env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  expect(options.env.TSX_DISABLE_CACHE).toBe('1');
  expect(readFileSync(options.env.TSX_TSCONFIG_PATH, 'utf8')).toBe('{}');
  const policy = args.at(-1) as string;
  const payload = JSON.parse(readFileSync(policy, 'utf8')) as SandboxWorkerPayload;
  expect(payload.env).toMatchObject({ NODE_PATH: '/untrusted' });
  expect(payload.config.network.allowedDomains).toContain('platform.claude.com');
  expect(payload.config.network.allowedDomains).not.toContain('*.claude.com');
  expect(payload.env).not.toHaveProperty('AUTH_SECRET');
  expect(payload.env).not.toHaveProperty('AUTH_PASSPHRASE');
  expect(payload.env).not.toHaveProperty('MITZO_INTERNAL_TOKEN');
  expect(payload.command).toBe("'/usr/bin/printf' 'a'\\''b' '$(cat /private/controller.json)'");
  expect(payload.config.filesystem.allowRead).toEqual([payload.env!.GIT_TEMPLATE_DIR]);
  expect(payload.config.filesystem.denyRead).toEqual(expect.arrayContaining(boundary.deniedRoots));
  expect(payload.config.filesystem.denyWrite).toEqual(expect.arrayContaining(boundary.deniedRoots));
  expect(payload.config.filesystem.denyWrite.some((path) => path.endsWith('/node_modules'))).toBe(
    true,
  );
  expect(result.stdin).toBe(handle.stdin);
  expect(result.stdout).toBe(handle.stdout);
  handle.emit('exit', 0, null);
  expect(kill).toHaveBeenCalledWith(-99999, 'SIGKILL');
  handle.emit('close', 0, null);
  expect(existsSync(policy)).toBe(false);
});
it('allows the selected Messages endpoint inside the existing SDK sandbox', () => {
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://ambient.example');
  const handle = child();
  mocked.spawn.mockReturnValue(handle);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    const boundary = credentialSdkBoundary('darwin', [], 'https://selected.example/anthropic')!;
    boundary.spawnClaudeCodeProcess({
      command: '/usr/bin/true',
      args: [],
      env: { ANTHROPIC_BASE_URL: 'https://selected.example/anthropic' },
      signal: new AbortController().signal,
    });
    const payload = JSON.parse(
      readFileSync(mocked.spawn.mock.calls[0][1].at(-1), 'utf8'),
    ) as SandboxWorkerPayload;
    expect(payload.config.network.allowedDomains).toContain('selected.example');
    expect(payload.config.network.allowedDomains).not.toContain('ambient.example');
    expect(() => credentialSdkBoundary('darwin', [], 'https://127.0.0.1')).toThrow();
  } finally {
    handle.emit('close', 0, null);
  }
});
it('fails closed before provider spawn when OS sandbox dependencies are incomplete', () => {
  mocked.dependencies.mockReturnValue({ errors: [], warnings: ['seccomp missing'] });
  expect(() =>
    credentialSdkBoundary('darwin')!.spawnClaudeCodeProcess({
      command: 'node',
      args: [],
      env: {},
      signal: new AbortController().signal,
    }),
  ).toThrow(/complete OS sandbox dependencies/);
  expect(mocked.spawn).not.toHaveBeenCalled();
});
it('cancels the complete SDK process group instead of only the wrapper', () => {
  const handle = child();
  mocked.spawn.mockReturnValue(handle);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const controller = new AbortController();
  const processHandle = credentialSdkBoundary('darwin')!.spawnClaudeCodeProcess({
    command: 'node',
    args: [],
    env: {},
    signal: controller.signal,
  });
  controller.abort();
  expect(kill).toHaveBeenCalledWith(-99999, 'SIGKILL');
  expect(processHandle.killed).toBe(true);
  handle.emit('close', 0, null);
});

it('fails closed on unsupported platforms before exposing any SDK process', () => {
  expect(() =>
    credentialSdkBoundary('linux')!.spawnClaudeCodeProcess({
      command: 'node',
      args: [],
      env: {},
      signal: new AbortController().signal,
    }),
  ).toThrow(/requires macOS/);
  expect(mocked.spawn).not.toHaveBeenCalled();
});

it('permits selected ADC reads while OS policy denies authority writes in arbitrary descendants', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-selected-adc-')));
  const adc = join(directory, 'adc.json');
  writeFileSync(adc, '{"type":"authorized_user"}', { mode: 0o600 });
  const handle = child();
  mocked.spawn.mockReturnValue(handle);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    const boundary = credentialSdkBoundary('darwin', [directory])!;
    boundary.spawnClaudeCodeProcess({
      command: '/usr/bin/true',
      args: [],
      env: { GOOGLE_APPLICATION_CREDENTIALS: adc },
      signal: new AbortController().signal,
    });
    const payload = JSON.parse(
      readFileSync(mocked.spawn.mock.calls[0][1].at(-1), 'utf8'),
    ) as SandboxWorkerPayload;
    expect(payload.config.filesystem.denyWrite).toContain(directory);
    expect(payload.config.filesystem.denyRead).not.toContain(directory);
    expect(payload.config.filesystem.denyRead).not.toContain(adc);
    expect(payload.env?.GOOGLE_APPLICATION_CREDENTIALS).toBe(adc);
    expect(payload.authority).toBeDefined();
  } finally {
    handle.emit('close', 0, null);
    rmSync(directory, { recursive: true, force: true });
  }
});

const hostGithub = () => ({ token: 'gho_syntheticHostLogin', gh: '/opt/homebrew/bin/gh' });
function launch(
  boundary: NonNullable<ReturnType<typeof credentialSdkBoundary>>,
  env: NodeJS.ProcessEnv = {},
) {
  const handle = child();
  mocked.spawn.mockReturnValue(handle);
  boundary.spawnClaudeCodeProcess({
    command: '/usr/bin/true',
    args: [],
    env,
    signal: new AbortController().signal,
  });
  const [, args, options] = mocked.spawn.mock.calls.at(-1)!;
  const policy = readFileSync(args.at(-1), 'utf8');
  handle.emit('close', 0, null);
  return { payload: JSON.parse(policy) as SandboxWorkerPayload, policy, bootstrap: options.env };
}
it('injects the opted-in host GitHub login only through the protected launch transfer', () => {
  vi.spyOn(process, 'kill').mockReturnValue(true);
  const resolver = vi.fn(hostGithub);
  const boundary = credentialSdkBoundary('darwin', [], undefined, undefined, resolver)!;
  const { payload, policy, bootstrap } = launch(boundary, {
    GH_TOKEN: 'controller-publisher-token',
    GITHUB_TOKEN: 'controller-publisher-token',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'false',
  });
  // The secret is never written to the on-disk launch policy; the controller
  // publisher token is still stripped and never substituted.
  expect(policy).not.toContain('gho_syntheticHostLogin');
  expect(policy).not.toContain('controller-publisher-token');
  expect(payload.env).not.toHaveProperty('GH_TOKEN');
  expect(payload.env).not.toHaveProperty('GITHUB_TOKEN');
  expect(payload.hostGithubToken).toBe(true);
  expect(bootstrap[HOST_GITHUB_TOKEN_TRANSFER]).toBe('gho_syntheticHostLogin');
  expect(Object.values(bootstrap)).not.toContain('controller-publisher-token');
  expect(payload.env).toMatchObject({
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '5',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_2: '!/opt/homebrew/bin/gh auth git-credential',
    GIT_CONFIG_KEY_3: 'commit.gpgsign',
    GIT_CONFIG_VALUE_3: 'false',
    GIT_CONFIG_KEY_4: 'tag.gpgsign',
    GIT_CONFIG_VALUE_4: 'false',
  });
  expect(payload.config.network.allowMachLookup).toEqual(['com.apple.trustd.agent']);
  expect(payload.config.network.allowedDomains).toContain('*.githubusercontent.com');
  expect(payload.config.network.allowedDomains.some((domain) => /blob|azure/i.test(domain))).toBe(
    false,
  );
  expect(payload.config.network.allowAllUnixSockets).toBe(false);
  expect(payload.config.enableWeakerNetworkIsolation).toBe(false);
  expect(payload.config.filesystem.denyRead).toContain(
    canonical(join(homedir(), 'Library', 'Keychains')),
  );
  expect(payload.config.filesystem.denyRead).toContain(canonical(join(homedir(), '.mitzo')));
  // Resolved for each launch; authority is never cached across spawns.
  launch(boundary);
  expect(resolver).toHaveBeenCalledTimes(2);
});
it('adds no host GitHub access without opt-in, without a resolved login or for native login', () => {
  vi.spyOn(process, 'kill').mockReturnValue(true);
  for (const boundary of [
    credentialSdkBoundary('darwin')!,
    credentialSdkBoundary('darwin', [], undefined, undefined, () => undefined)!,
    claudeLoginSdkBoundary('darwin')!,
  ]) {
    const { payload, policy, bootstrap } = launch(boundary, {
      GH_TOKEN: 'controller-publisher-token',
    });
    expect(policy).not.toContain('controller-publisher-token');
    expect(payload.hostGithubToken).toBeUndefined();
    expect(bootstrap).not.toHaveProperty(HOST_GITHUB_TOKEN_TRANSFER);
    for (const name of [
      'GH_TOKEN',
      'GH_PROMPT_DISABLED',
      'GIT_TERMINAL_PROMPT',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
    ])
      expect(payload.env).not.toHaveProperty(name);
    expect(payload.config.network.allowMachLookup).toBeUndefined();
    expect(payload.config.network.allowedDomains).not.toContain('*.githubusercontent.com');
  }
});
