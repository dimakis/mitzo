import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDevelopment } from '../prepare-development.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'mitzo-development-'));
  roots.push(cwd);
  await writeFile(join(cwd, 'package.json'), '{}');
  await writeFile(join(cwd, 'package-lock.json'), '{}');
  const run = vi.fn(
    async (command: string, args: readonly string[], options: { env: Record<string, string> }) => {
      expect(command).toBeTruthy();
      expect(Array.isArray(args)).toBe(true);
      expect(options.env).toBeDefined();
      return { stdout: '', stderr: '' };
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
    return { stdout: '', stderr: '' };
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
