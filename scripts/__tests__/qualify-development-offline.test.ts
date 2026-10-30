import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { qualifyDevelopmentOffline } from '../qualify-development-offline.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'mitzo-native-qualification-'));
  roots.push(cwd);
  const toolchainPath = join(cwd, 'tools', 'node_modules', '.bin');
  const nodeGyp = join(cwd, 'headers');
  const tmp = join(cwd, 'tmp');
  for (const directory of [
    toolchainPath,
    tmp,
    join(nodeGyp, '24.22.2', 'include', 'node'),
    join(toolchainPath, '..', 'npm', 'node_modules', 'node-gyp', 'bin'),
  ])
    await mkdir(directory, { recursive: true });
  await writeFile(join(nodeGyp, '24.22.2', 'include', 'node', 'node.h'), 'offline fixture');
  await writeFile(
    join(toolchainPath, '..', 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
    'offline fixture',
  );
  const prepare = vi.fn(
    async ({
      run,
      install,
    }: {
      run: (
        command: string,
        args: string[],
        options: { env: Record<string, string> },
      ) => Promise<unknown>;
      install: boolean;
    }) => {
      await run('npm', ['ls'], {
        env: { HOME: cwd, PYTHONPYCACHEPREFIX: join(cwd, 'retired-setup-scratch') },
      });
      return {
        ready: true,
        platform: 'fixture',
        arch: 'fixture',
        node: 'v24.22.2',
        npm: '11.18.0',
        abi: '137',
        toolchainPath,
        environment: { tmp, nodeGyp },
        installationIdentity: 'same',
        reused: install,
      };
    },
  );
  const execute = vi.fn(
    async (
      _command: string,
      args: string[],
      _options: { cwd: string; env: Record<string, string> },
    ) => {
      expect(_options.env).toBeDefined();
      return { stdout: args[0] === '-e' ? '137\n' : '', stderr: '' };
    },
  );
  return { cwd, prepare, execute, tmp };
}

it('withholds qualification success when its temporary cleanup fails', async () => {
  const f = await fixture();
  await expect(
    qualifyDevelopmentOffline({
      ...f,
      cleanup: async () => {
        throw Object.assign(Error('private cleanup detail'), { code: 'EACCES' });
      },
    }),
  ).rejects.toMatchObject({ phase: 'cleanup', reason: 'filesystem_denied' });
});

it('retains the primary native failure and safe cleanup failure without raw compiler output', async () => {
  const f = await fixture();
  f.execute.mockImplementation(async (_command, args) => {
    if (args.includes('rebuild')) throw Error('private compiler diagnostic');
    return { stdout: '', stderr: '' };
  });
  await expect(
    qualifyDevelopmentOffline({
      ...f,
      cleanup: async () => {
        throw Object.assign(Error('private cleanup detail'), { code: 'EACCES' });
      },
    }),
  ).rejects.toMatchObject({ phase: 'compile', cleanupReason: 'filesystem_denied' });
});

it('compiles with its own live Python scratch and returns only after cleanup', async () => {
  const f = await fixture();
  const result = await qualifyDevelopmentOffline(f);
  expect(result).toMatchObject({ ready: true, nativeCompilation: true, setupInstallCalls: 0 });
  const compile = f.execute.mock.calls.find(([, args]) => args.includes('rebuild'))!;
  const options = compile[2] as { cwd: string; env: Record<string, string> };
  expect(options.env.PYTHONPYCACHEPREFIX).toBe(join(options.cwd, 'python-cache'));
  await expect(access(options.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
});
