import { resetOfflineUserEnvironment } from './fixtures/offline-user-home.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialSdkBoundary, runtimeFilesystemSdkBoundary } from '../credential-sdk-boundary.js';
import { isPrivateCodexPath } from '../codex-private-path.js';
import type { SandboxWorkerPayload } from '../sandboxed-command-worker.js';

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  spawn: mocked.spawn,
}));
vi.mock('@anthropic-ai/sandbox-runtime', () => ({
  SandboxManager: { checkDependencies: () => ({ errors: [], warnings: [] }) },
}));
vi.mock('../credential-connections-runtime.js', () => ({
  getCredentialConnectionsRuntime: () => undefined,
}));

let root: string;
beforeEach(() => {
  resetOfflineUserEnvironment();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'telos-provider-isolation-')));
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_ENABLED', '0');
  vi.stubEnv('MITZO_KEYCHAIN_CONNECTIONS_DIR', join(root, 'absent-keychain'));
  vi.stubEnv('MITZO_SECRET_RELAY_ENABLED', '0');
  vi.stubEnv('MITZO_WORKSPACE_RUNTIME_CONFIG', undefined);
  vi.stubEnv('PATH', '/usr/bin:/bin:/opt/homebrew/bin');
  vi.stubEnv('TELOS_DB_PATH', '');
  vi.stubEnv('MITZO_TELOS_DATA_DIR', join(root, 'telos'));
  mocked.spawn.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function launch(boundary = credentialSdkBoundary('darwin')) {
  expect(boundary).toBeDefined();
  expect(boundary!.credentialIsolation).toBe(false);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  mocked.spawn.mockReturnValue(child);
  boundary!.spawnClaudeCodeProcess({
    command: process.execPath,
    args: ['-e', 'throw Error("must never execute")'],
    cwd: root,
    env: { MITZO_TELOS_IMPORT_TOKEN: 'controller-only-import-credential' },
    signal: new AbortController().signal,
  });
  const argv = mocked.spawn.mock.calls.at(-1)![1] as string[];
  const payload = JSON.parse(readFileSync(argv.at(-1)!, 'utf8')) as SandboxWorkerPayload;
  child.emit('close', 0, null);
  return payload;
}

it('protects Telos for Claude without Keychain or workspace enrollment and strips import authority', () => {
  const payload = launch();
  const path = join(root, 'telos');
  expect(payload.env).not.toHaveProperty('MITZO_TELOS_IMPORT_TOKEN');
  expect(payload.config.filesystem.denyRead).toContain(path);
  expect(payload.config.filesystem.denyWrite).toContain(path);
  expect(payload.config.filesystem.denyWrite).not.toContain(root);
});

it.each(['provider', 'controller'] as const)(
  'refuses an unqualified %s platform without an unfenced child',
  (kind) => {
    const boundary =
      kind === 'provider' ? credentialSdkBoundary('linux') : runtimeFilesystemSdkBoundary('linux');
    expect(boundary).toBeDefined();
    expect(boundary!.credentialIsolation).toBe(false);
    expect(() =>
      boundary!.spawnClaudeCodeProcess({
        command: process.execPath,
        args: [],
        env: {},
        signal: new AbortController().signal,
      }),
    ).toThrow(/requires macOS/);
    expect(mocked.spawn).not.toHaveBeenCalled();
  },
);

it('protects controller environment files and retained copies without Keychain isolation', () => {
  const controller = join(root, 'controller');
  mkdirSync(controller);
  vi.spyOn(process, 'cwd').mockReturnValue(controller);
  const payload = launch();
  expect(payload.config.filesystem.denyRead).toEqual(
    expect.arrayContaining([
      join(controller, '.env'),
      join(controller, '.env.before-runtime-*'),
      join(controller, '.env.runtime-*'),
    ]),
  );
  expect(payload.config.filesystem.denyWrite).toEqual(
    expect.arrayContaining([
      join(controller, '.env'),
      join(controller, '.env.before-runtime-*'),
      join(controller, '.env.runtime-*'),
    ]),
  );
});

it('shares Codex selections with Claude and retains both configuration paths across removal', () => {
  const first = join(root, 'telos');
  expect(isPrivateCodexPath(join(first, 'telos.db'))).toBe(true);
  const second = join(root, 'second');
  vi.stubEnv('TELOS_DB_PATH', join(second, 'custom.db'));
  const payload = launch();
  expect(payload.config.filesystem.denyRead).toEqual(expect.arrayContaining([first, second]));
  vi.stubEnv('TELOS_DB_PATH', '');
  vi.stubEnv('MITZO_TELOS_DATA_DIR', '');
  const retained = launch();
  expect(retained.config.filesystem.denyRead).toEqual(expect.arrayContaining([first, second]));
  expect(isPrivateCodexPath(join(second, 'custom.db-wal'))).toBe(true);
});

it('reconciles a retained Claude factory at launch and fences storage selector aliases', () => {
  const first = join(root, 'telos');
  const boundary = credentialSdkBoundary('darwin');
  const physical = join(root, 'physical');
  const alias = join(root, 'storage-link');
  mkdirSync(physical);
  symlinkSync(physical, alias);
  vi.stubEnv('MITZO_TELOS_DATA_DIR', alias);
  const payload = launch(boundary);
  expect(payload.config.filesystem.denyRead).toEqual(expect.arrayContaining([first, physical]));
  expect(payload.config.filesystem.denyWrite.some((path) => path.includes('storage-lin[k]'))).toBe(
    true,
  );
  expect(payload.config.filesystem.denyWrite).not.toContain(root);
  expect(isPrivateCodexPath(join(alias, 'telos.db'))).toBe(true);
});
