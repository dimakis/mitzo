import { afterEach, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDevelopment } from '../prepare-development.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-development-')));
  roots.push(cwd);
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ engines: { node: '>=24', npm: '>=11.18.0' } }),
  );
  await writeFile(join(cwd, 'package-lock.json'), '{}');
  const run = vi.fn(
    async (command: string, args: readonly string[], options: { env: Record<string, string> }) => {
      expect(command).toBeTruthy();
      expect(Array.isArray(args)).toBe(true);
      expect(options.env).toBeDefined();
      return {
        stdout: args[0] === '--version' ? (command.endsWith('npm') ? '11.18.0' : 'v24.22.0') : '',
        stderr: '',
      };
    },
  );
  return { cwd, run, freeBytes: async () => 8 * 1024 ** 3 };
}
it('checks sandbox space before running any package or build command', async () => {
  const f = await fixture();
  await expect(
    prepareDevelopment({ ...f, install: true, freeBytes: async () => 1024 }),
  ).rejects.toThrow('2 GiB');
  expect(f.run).not.toHaveBeenCalled();
});
it('installs the lockfile with dev dependencies and verifies native modules without inherited secrets', async () => {
  const f = await fixture();
  vi.stubEnv('OPENAI_API_KEY', 'must-not-reach-install');
  try {
    await expect(prepareDevelopment({ ...f, install: true })).resolves.toMatchObject({
      ready: true,
    });
    const call = f.run.mock.calls.find(([, args]) => args[0] === 'ci');
    expect(call).toBeDefined();
    expect(call![1]).toContain('--include=dev');
    expect(call![2].env.OPENAI_API_KEY).toBeUndefined();
    expect(call![2].env.GIT_CONFIG_VALUE_0).toBe('ssh://git@github.com/');
    expect(
      f.run.mock.calls.some(([, args]) => args.some((arg) => arg.includes('better-sqlite3'))),
    ).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});
it('prepares a workspace-local Node 24 and npm 11.18 toolchain before installing the project', async () => {
  const f = await fixture();
  await prepareDevelopment({ ...f, install: true });
  const bootstrap = f.run.mock.calls.find(([, args]) => args[0] === 'install');
  expect(bootstrap?.[1]).toEqual(expect.arrayContaining(['node@24', 'npm@11.18.0']));
  const install = f.run.mock.calls.find(([, args]) => args[0] === 'ci');
  expect(install?.[0]).toContain('.mitzo-devtools');
  expect(install?.[2].env.PATH).toContain('.mitzo-devtools');
});
it('reports dependency installation failure without exposing npm stderr or credentials', async () => {
  const f = await fixture();
  f.run.mockImplementation(async (_command, args) => {
    if (args[0] === 'ci') throw Error('token=secret');
    return { stdout: _command.endsWith('npm') ? '11.18.0' : 'v24.22.0', stderr: '' };
  });
  await expect(prepareDevelopment({ ...f, install: true })).rejects.toThrow(
    'Dependency installation failed',
  );
  await expect(prepareDevelopment({ ...f, install: true })).rejects.not.toThrow('secret');
});
it('checks existing dependencies without installing unless explicitly requested', async () => {
  const f = await fixture();
  await prepareDevelopment(f);
  expect(f.run.mock.calls.some(([, args]) => args[0] === 'ci')).toBe(false);
  expect(f.run.mock.calls.some(([, args]) => args[0] === 'ls')).toBe(true);
});

it.each([
  [false, 'node', 'v22.20.0'],
  [false, 'npm', '11.17.9'],
  [true, 'node', 'v23.10.0'],
  [true, 'npm', '10.9.0'],
  [true, 'npm', 'unrecognized'],
] as const)(
  'refuses incompatible %s-local %s %s before declaring readiness',
  async (local, tool, version) => {
    const f = await fixture();
    if (local) {
      const bin = join(f.cwd, '.mitzo-devtools', 'node_modules', '.bin');
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, 'node'), 'fixture');
    }
    f.run.mockImplementation(async (command, args) => ({
      stdout:
        args[0] === '--version'
          ? command.endsWith(tool)
            ? version
            : command.endsWith('npm')
              ? '11.18.0'
              : 'v24.22.0'
          : '',
      stderr: '',
    }));
    await expect(prepareDevelopment(f)).rejects.toThrow(/Node.js.*>=24.*npm.*>=11.18.0/);
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'ls')).toBe(false);
  },
);

it('validates installed tools and reads minimum versions from the project engines', async () => {
  const f = await fixture();
  await writeFile(
    join(f.cwd, 'package.json'),
    JSON.stringify({ engines: { node: '>=25', npm: '>=12.0.0' } }),
  );
  await expect(prepareDevelopment({ ...f, install: true })).rejects.toThrow(/>=25.*>=12.0.0/);
  expect(f.run.mock.calls.some(([, args]) => args[0] === 'ci')).toBe(false);
});

it('owns all lifecycle write paths inside the selected task and retains its download cache', async () => {
  const f = await fixture();
  for (const key of ['HOME', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'npm_config_cache'])
    vi.stubEnv(key, '/unwritable-host-fixture');
  for (const key of ['SSH_AUTH_SOCK', 'NPM_TOKEN', 'AWS_ACCESS_KEY_ID', 'VERCEL_TOKEN'])
    vi.stubEnv(key, 'credential-sentinel');
  try {
    const result = await prepareDevelopment({ ...f, install: true });
    const call = f.run.mock.calls.find(([, args]) => args[0] === 'ci')!;
    for (const key of [
      'HOME',
      'TMPDIR',
      'TMP',
      'TEMP',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'npm_config_cache',
      'npm_config_devdir',
      'npm_package_config_node_gyp_devdir',
      'npm_config_prefix',
    ]) {
      expect(call[2].env[key], key).toMatch(new RegExp(`^${f.cwd}/\\.mitzo-devtools/`));
      await expect(access(call[2].env[key])).resolves.toBeUndefined();
    }
    for (const key of ['SSH_AUTH_SOCK', 'NPM_TOKEN', 'AWS_ACCESS_KEY_ID', 'VERCEL_TOKEN'])
      expect(call[2].env[key]).toBeUndefined();
    expect(result.environment.tmp).toBe(call[2].env.TMPDIR);
    await expect(access(call[2].env.npm_config_cache)).resolves.toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('refuses a setup directory redirected outside the task', async () => {
  const f = await fixture();
  const outside = await fixture();
  await symlink(outside.cwd, join(f.cwd, '.mitzo-devtools'));
  await expect(prepareDevelopment({ ...f, install: true })).rejects.toMatchObject({
    phase: 'environment',
    reason: 'workspace_escape',
    effectStatus: 'not_started',
  });
  expect(f.run).not.toHaveBeenCalled();
});

it.each([
  ['EPERM: mkdir /host/cache token=secret', 'filesystem_denied'],
  ['npm error code EACCES', 'filesystem_denied'],
  ['npm error code ENOSPC', 'insufficient_space'],
  ['npm error code EAI_AGAIN token=secret', 'network_unavailable'],
  ['gyp ERR! find Python token=secret', 'native_toolchain'],
  [
    'npm ci can only install when package.json and package-lock.json are in sync',
    'lockfile_mismatch',
  ],
  ['unknown token=secret', 'command_failed'],
])('retains safe dependency failure classification for %s', async (stderr, reason) => {
  const f = await fixture();
  f.run.mockImplementation(async (command, args) => {
    if (args[0] === 'ci') throw Object.assign(Error('command failed: token=secret'), { stderr });
    return { stdout: command.endsWith('npm') ? '11.18.0' : 'v24.22.0', stderr: '' };
  });
  const error = await prepareDevelopment({ ...f, install: true }).catch((error) => error);
  expect(error).toMatchObject({ phase: 'dependencies', reason, effectStatus: 'may_have_changed' });
  expect(JSON.stringify(error)).not.toContain('secret');
  expect(error.message).not.toContain('secret');
});
