import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import type { SandboxWorkerPayload } from '../sandboxed-command-worker.js';
import { credentialSdkBoundary } from '../credential-sdk-boundary.js';
const mocked = vi.hoisted(() => ({ spawn: vi.fn(), dependencies: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  spawn: mocked.spawn,
}));
vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: { checkDependencies: mocked.dependencies },
}));
beforeEach(() => {
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
  expect(payload.env).not.toHaveProperty('AUTH_SECRET');
  expect(payload.env).not.toHaveProperty('AUTH_PASSPHRASE');
  expect(payload.env).not.toHaveProperty('MITZO_INTERNAL_TOKEN');
  expect(payload.command).toBe("'/usr/bin/printf' 'a'\\''b' '$(cat /private/controller.json)'");
  expect(payload.config.filesystem.allowRead).toEqual([]);
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
