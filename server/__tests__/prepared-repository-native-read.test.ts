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
  const abort = new AbortController();
  const owners = {
    signal: abort.signal,
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
    abort: () => abort.abort(),
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

it
  .runIf(process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1')
  .each(['none', 'revoke', 'cancel'] as const)(
  'verifies original directories through the actual factory batch with all-or-nothing publication (owner=%s)',
  async (change) => {
    const f = await fixture(),
      actual = sandboxedCommand.executeSandboxedCommand;
    const batches: Parameters<typeof actual>[0][] = [];
    vi.spyOn(sandboxedCommand, 'executeSandboxedCommand').mockImplementation(async (request) => {
      const result = await actual(request);
      if (request.command.includes('"operation":"ListDirectoryBatch"')) {
        batches.push(request);
        if (change === 'revoke') f.revoke();
        if (change === 'cancel') f.abort();
      }
      return result;
    });
    await withPreparedRepositoryBarrierReadScope(f.policy, 'completed', f.owners, async (scope) => {
      const reader = await capturePreparedRepositoryReader(scope, { deadline: Date.now() + 30000 });
      try {
        expect(typeof reader.executeDirectoryVerification).toBe('function');
        const access = new LocalRepositoryReadAccess(reader);
        await access.pinRoot(f.root);
        await access.list(f.root);
        await access.list(f.source);
        if (change === 'none') await access.verify();
        else await expect(access.verify()).rejects.toThrow();
        expect(batches).toHaveLength(1);
        expect(batches[0].writableRoots).toEqual([batches[0].cwd]);
        expect(batches[0].deniedRoots).toEqual(expect.arrayContaining([...scope.deniedRoots]));
      } finally {
        await reader.dispose();
      }
    });
    expect(await readFile(join(f.source, 'witness.txt'), 'utf8')).toBe('ORIGINAL SOURCE BYTES');
  },
  40000,
);

it.runIf(process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1')(
  'joins a pending batch and removes scratch for both concurrent disposal callers',
  async () => {
    const f = await fixture(),
      actual = sandboxedCommand.executeSandboxedCommand;
    let started!: () => void, resume!: () => void;
    const startedBatch = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let batchScratch = '';
    vi.spyOn(sandboxedCommand, 'executeSandboxedCommand').mockImplementation(async (request) => {
      if (request.command.includes('"operation":"ListDirectoryBatch"')) {
        batchScratch = request.cwd;
        started();
        await gate;
      }
      return actual(request);
    });
    await withPreparedRepositoryBarrierReadScope(f.policy, 'completed', f.owners, async (scope) => {
      const reader = await capturePreparedRepositoryReader(scope, { deadline: Date.now() + 30000 });
      const access = new LocalRepositoryReadAccess(reader);
      await access.pinRoot(f.source);
      await access.list(f.source);
      const checking = access.verify();
      const rejected = expect(checking).rejects.toThrow();
      await startedBatch;
      const first = reader.dispose(),
        second = reader.dispose();
      expect(first).toBe(second);
      resume();
      await second;
      await expect(readFile(join(batchScratch, 'nonexistent'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(realpath(batchScratch)).rejects.toMatchObject({ code: 'ENOENT' });
      await Promise.all([first, rejected]);
    });
  },
  40000,
);

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

it.runIf(process.platform === 'darwin')(
  'refuses a genuine original barrier owner revoked during additional final ceiling validation',
  async () => {
    const f = await fixture(),
      execute = vi.spyOn(sandboxedCommand, 'executeSandboxedCommand');
    await withPreparedRepositoryBarrierReadScope(f.policy, 'completed', f.owners, async (scope) => {
      const reader = await capturePreparedRepositoryReader(scope, { deadline: Date.now() + 30000 });
      try {
        expect(Object.getOwnPropertyDescriptor(reader, 'assertCurrentSync')).toMatchObject({
          value: expect.any(Function),
          enumerable: false,
          writable: false,
          configurable: false,
        });
        expect(Object.isFrozen(reader.assertCurrentSync)).toBe(true);
        const access = new LocalRepositoryReadAccess(reader, {
          async assertReadable() {},
          async revalidate() {
            await Promise.resolve();
            f.revoke();
          },
        });
        await expect(access.verify()).rejects.toThrow();
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await reader.dispose();
      }
    });
  },
);

it.runIf(process.platform === 'darwin')(
  'checks logical targets against the live scope without repeating physical-owner waits',
  async () => {
    const f = await fixture(),
      revalidate = vi.spyOn(f.owners, 'revalidate'),
      execute = vi.spyOn(sandboxedCommand, 'executeSandboxedCommand');
    await withPreparedRepositoryBarrierReadScope(f.policy, 'completed', f.owners, async (scope) => {
      const reader = await capturePreparedRepositoryReader(scope, { deadline: Date.now() + 30000 });
      try {
        expect(revalidate).toHaveBeenCalledTimes(1); // Scratch creation qualifies the owner.
        await reader.assertReadable(f.source);
        await reader.assertReadable(join(f.source, 'witness.txt'));
        expect(revalidate).toHaveBeenCalledTimes(1);
        await new LocalRepositoryReadAccess(reader).verify();
        expect(revalidate).toHaveBeenCalledTimes(2); // Cached-only outward fence too.
        f.revoke();
        await expect(reader.assertReadable(f.source)).rejects.toThrow();
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await reader.dispose();
      }
    });
  },
);

it.runIf(process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1')(
  'reads through the actual fresh barrier and same existing SRT helper with no source write root',
  async () => {
    const f = await fixture(),
      execute = vi.spyOn(sandboxedCommand, 'executeSandboxedCommand'),
      revalidate = vi.spyOn(f.owners, 'revalidate');
    await withPreparedRepositoryBarrierReadScope(f.policy, 'completed', f.owners, async (scope) => {
      const reader = await capturePreparedRepositoryReader(scope, { deadline: Date.now() + 30000 });
      try {
        const access = new LocalRepositoryReadAccess(reader);
        await access.pinRoot(f.source);
        expect((await access.read(join(f.source, 'witness.txt'), 4096)).toString()).toBe(
          'ORIGINAL SOURCE BYTES',
        );
        expect(execute.mock.calls.length).toBeGreaterThan(0);
        // Every actual helper still revalidates before spawn and after result.
        expect(revalidate).toHaveBeenCalledTimes(1 + 2 * execute.mock.calls.length);
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
