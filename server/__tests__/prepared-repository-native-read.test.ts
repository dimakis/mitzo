import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';
import {
  withPreparedRepositoryBarrierReadScope,
  type PreparedRepositoryBarrierReadScope,
} from '../prepared-repository-barrier-read.js';
import { capturePreparedRepositoryReader } from '../local-repository-native-read.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import * as sandboxedCommand from '../sandboxed-command.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function fixture(hostWide = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-barrier-reader-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const oldTask = join(root, 'old-task'),
    source = join(root, 'selected-repository');
  await mkdir(oldTask);
  await mkdir(source);
  await writeFile(join(source, 'witness.txt'), 'ORIGINAL SOURCE BYTES');
  const policy = codexNativeExecutionPolicy({
    bindingRevision: 'fixture-binding',
    mode: 'agent',
    cwd: oldTask,
    readableRoots: hostWide ? ['/'] : [source],
    writableRoots: [oldTask],
    deniedRoots: [join(root, 'fixture-private')],
    writeProtectedRoots: [],
  });
  let current = true;
  const owners = {
    signal: new AbortController().signal,
    selectedPolicy: () => policy,
    assertCurrentSync() {
      if (!current) throw Error('Original barrier owner changed');
    },
    async revalidate() {
      owners.assertCurrentSync();
    },
    assertNativeExecutionCurrent() {
      owners.assertCurrentSync();
    },
  };
  return {
    root,
    source,
    policy,
    owners,
    revoke: () => {
      current = false;
    },
  };
}

// The real scope producer and actual SRT/helper are composed here with explicit
// fixture-only current callbacks. Signed completed-turn wiring is a separate
// integration qualification; no NativeHostToolContext or old tool closure exists.
it('refuses a narrow fresh barrier scope before invoking any native helper', async () => {
  const f = await fixture(false),
    execute = vi.spyOn(sandboxedCommand, 'executeSandboxedCommand');
  await withPreparedRepositoryBarrierReadScope(f.policy, 'completed', f.owners, async (scope) => {
    await expect(
      capturePreparedRepositoryReader(scope, { deadline: Date.now() + 30000 }),
    ).rejects.toThrow('Local repository native reads unavailable');
  });
  expect(execute).not.toHaveBeenCalled();
});

it('cannot use a retained scope after its actual barrier lifetime has ended', async () => {
  const f = await fixture(),
    execute = vi.spyOn(sandboxedCommand, 'executeSandboxedCommand');
  let ended!: PreparedRepositoryBarrierReadScope;
  await withPreparedRepositoryBarrierReadScope(f.policy, 'completed', f.owners, async (scope) => {
    ended = scope;
  });
  await expect(
    capturePreparedRepositoryReader(ended, { deadline: Date.now() + 30000 }),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1')(
  'reads through the actual fresh barrier and same existing SRT helper with no source write root',
  async () => {
    const f = await fixture(),
      execute = vi.spyOn(sandboxedCommand, 'executeSandboxedCommand');
    await withPreparedRepositoryBarrierReadScope(f.policy, 'completed', f.owners, async (scope) => {
      const reader = await capturePreparedRepositoryReader(scope, { deadline: Date.now() + 30000 });
      try {
        const access = new LocalRepositoryReadAccess(reader);
        await access.pinRoot(f.source);
        expect((await access.read(join(f.source, 'witness.txt'), 4096)).toString()).toBe(
          'ORIGINAL SOURCE BYTES',
        );
        expect(execute.mock.calls.length).toBeGreaterThan(0);
        for (const [call] of execute.mock.calls) {
          expect(call.writableRoots).toEqual([call.cwd]);
          expect(call.cwd).not.toBe(f.source);
          expect(call.privateOutput).toBe('separate');
          expect(call.deniedRoots).toEqual(expect.arrayContaining([...scope.deniedRoots]));
          expect(call.readableRoots).toBeUndefined(); // Actual admitted '/' scope only.
        }
      } finally {
        await reader.dispose();
      }
    });
    expect(await readFile(join(f.source, 'witness.txt'), 'utf8')).toBe('ORIGINAL SOURCE BYTES');
  },
  40000,
);

it.runIf(process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1')(
  'rechecks the same fresh owner after a helper wait and joins disposal',
  async () => {
    const f = await fixture(),
      actual = sandboxedCommand.executeSandboxedCommand;
    vi.spyOn(sandboxedCommand, 'executeSandboxedCommand').mockImplementation(async (request) => {
      const result = await actual(request);
      f.revoke();
      return result;
    });
    await withPreparedRepositoryBarrierReadScope(f.policy, 'completed', f.owners, async (scope) => {
      const reader = await capturePreparedRepositoryReader(scope, { deadline: Date.now() + 30000 });
      try {
        await expect(reader.captureReadAnchor(f.source)).rejects.toThrow();
      } finally {
        await Promise.all([reader.dispose(), reader.dispose()]);
      }
    });
    expect(await readFile(join(f.source, 'witness.txt'), 'utf8')).toBe('ORIGINAL SOURCE BYTES');
  },
  40000,
);
