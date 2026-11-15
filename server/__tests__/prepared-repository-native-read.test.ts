import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';
import {
  withPreparedRepositoryBarrierReadScope,
  type PreparedRepositoryBarrierReadScope,
} from '../prepared-repository-barrier-read.js';
import {
  capturePreparedRepositoryReader,
  preparedRepositoryValidationReadMs,
} from '../local-repository-native-read.js';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import * as sandboxedCommand from '../sandboxed-command.js';
import { codexToolFailureResult } from '../codex-tool-failure.js';

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

// Synthetic elapsed time over the real reader/scope composition. These checks
// never request a physical helper; actual SRT/physical availability is separate.
it
  .runIf(process.platform === 'darwin')
  .each(['complete', 'deadline', 'earlier', 'cancel', 'revoke'] as const)(
  'retains the prepared read validation window and live-owner refusal (%s)',
  async (change) => {
    const f = await fixture();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const execute = vi
      .spyOn(sandboxedCommand, 'executeSandboxedCommand')
      .mockRejectedValue(Error('Physical helper must not execute'));
    await withPreparedRepositoryBarrierReadScope(f.policy, 'completed', f.owners, async (scope) => {
      const window = change === 'earlier' ? 12000 : preparedRepositoryValidationReadMs;
      const deadline = now + window;
      const reader = await capturePreparedRepositoryReader(scope, { deadline });
      try {
        now += change === 'deadline' ? 60000 : change === 'earlier' ? 12000 : 45000;
        if (change === 'cancel') f.abort();
        if (change === 'revoke') f.revoke();
        const access = new LocalRepositoryReadAccess(reader);
        if (change === 'complete') {
          await reader.assertReadable(f.source);
          await access.verify(); // Actual final full-owner/current fence, cached-only.
        } else {
          await expect(reader.assertReadable(f.source)).rejects.toThrow();
          await expect(access.verify()).rejects.toThrow();
        }
        expect(reader.deadline).toBe(deadline);
      } finally {
        await reader.dispose();
      }
    });
    expect(execute).not.toHaveBeenCalled();
  },
);

// Exercise the real reader's setup/transport gates with a synthetic worker
// result. Existing signed native journeys qualify SRT; this control isolates
// asynchronous physical-owner revocation without starting another process.
it.runIf(process.platform === 'darwin').each(['current', 'before', 'after'] as const)(
  'defers the full private-scratch proof to physical I/O and refuses async revocation (%s)',
  async (change) => {
    const f = await fixture();
    let physicalLive = true;
    const full = vi.spyOn(f.owners, 'revalidate').mockImplementation(async () => {
      if (!physicalLive) throw Error('Original physical owner changed');
    });
    let delivered = false;
    const execute = vi
      .spyOn(sandboxedCommand, 'executeSandboxedCommand')
      .mockImplementation(async (request) => {
        await request.beforeSpawnAsync?.();
        request.beforeSpawn?.();
        delivered = true;
        if (change === 'after') physicalLive = false;
        const content = JSON.stringify({ rootPath: f.source, identity: { dev: '1', ino: '2' } });
        const stdout = `{"content": ${JSON.stringify(content)}, "is_error": false}\n`;
        return { content: stdout, stdout, isError: false };
      });
    await withPreparedRepositoryBarrierReadScope(f.policy, 'completed', f.owners, async (scope) => {
      const reader = await capturePreparedRepositoryReader(scope, { deadline: Date.now() + 30000 });
      try {
        expect(full).not.toHaveBeenCalled(); // Only owned scratch has been created.
        if (change === 'before') physicalLive = false;
        const capture = reader.captureReadAnchor!(f.source);
        if (change === 'current') {
          await expect(capture).resolves.toMatchObject({ rootPath: f.source });
          expect(full).toHaveBeenCalledTimes(2); // Fresh pre-I/O and post-result proofs.
        } else await expect(capture).rejects.toThrow();
        expect(delivered).toBe(change !== 'before');
        expect(execute).toHaveBeenCalledOnce();
      } finally {
        await reader.dispose();
      }
    });
  },
);

it.runIf(process.platform === 'darwin').each([
  ['capture', 'refusal'],
  ['verify', 'refusal'],
  ['capture', 'json'],
  ['verify', 'json'],
  ['capture', 'transport'],
  ['verify', 'transport'],
  ['capture', 'oversize'],
  ['verify', 'oversize'],
  ['capture', 'revoke'],
  ['capture', 'cancel'],
] as const)(
  'keeps exact object-store %s/%s failure through real reader and live physical fences',
  async (operation, outcome) => {
    const f = await fixture();
    const execute = vi
      .spyOn(sandboxedCommand, 'executeSandboxedCommand')
      .mockImplementation(async (request) => {
        await request.beforeSpawnAsync?.();
        request.beforeSpawn?.();
        const input = JSON.parse(request.requestJson!);
        const phase = input.operation === 'CapturePreparationObjectStore' ? 'capture' : 'verify';
        expect(input.operation).toBe(
          phase === 'capture' ? 'CapturePreparationObjectStore' : 'VerifyPreparationObjectStore',
        );
        expect(request.maxOutputBytes).toBe(phase === 'capture' ? 4 * 1024 * 1024 : 32768);
        expect(request.writableRoots).toEqual([request.cwd]);
        expect(request.deniedRoots).toEqual(expect.arrayContaining(f.policy.deniedRoots));
        expect(request.privateOutput).toBe('separate');
        expect(request.timeoutMs).toBeLessThanOrEqual(30000);
        let stdout = JSON.stringify(
          phase === 'capture' ? { files: [], digest: 'a'.repeat(64) } : { verified: true },
        );
        if (phase === operation) {
          if (outcome === 'refusal') stdout = '{"error":"unavailable","check":"inventory"}';
          if (outcome === 'json') stdout = 'PRIVATE_SENTINEL stdout parserexcerpt';
          if (outcome === 'oversize') stdout = ' '.repeat(request.maxOutputBytes! + 1);
          if (outcome === 'transport')
            throw Object.assign(Error('PRIVATE_SENTINEL stderr credential'), { code: 'ETIMEDOUT' });
          if (outcome === 'revoke') f.revoke();
          if (outcome === 'cancel') f.abort();
        }
        return { content: stdout, stdout, stderr: 'PRIVATE_SENTINEL stderr', isError: false };
      });
    await withPreparedRepositoryBarrierReadScope(f.policy, 'completed', f.owners, async (scope) => {
      const reader = await capturePreparedRepositoryReader(scope, { deadline: Date.now() + 30000 });
      let error: unknown;
      try {
        const captured = await reader.capturePreparationObjectStore!(
          { rootPath: f.source, identity: { dev: '1', ino: '2' } },
          'sha1',
        );
        if (operation === 'verify') await reader.verifyPreparationObjectStore!(captured);
      } catch (caught) {
        error = caught;
      } finally {
        await reader.dispose();
      }
      expect(error).toBeDefined();
      const value = JSON.parse(
        codexToolFailureResult(error, false, undefined, 'repository_preparation').content,
      );
      expect(value.diagnostic.effectStatus).toBe('unknown');
      expect(value.retry).toBe('after_reconciliation');
      if (outcome === 'refusal')
        expect(value.diagnostic.check).toBe(`object_store_${operation}_inventory`);
      if (outcome === 'json') expect(value.diagnostic.check).toBe(`object_store_${operation}_json`);
      if (outcome === 'oversize' || outcome === 'transport')
        expect(value.diagnostic.check).toBe(`object_store_${operation}_transport`);
      if (outcome === 'cancel') expect(value.error).toBe('cancelled');
      expect(JSON.stringify(value)).not.toMatch(/PRIVATE_SENTINEL|parserexcerpt|credential/);
      await expect(
        reader.capturePreparationObjectStore!(
          { rootPath: f.source, identity: { dev: '1', ino: '2' } },
          'sha1',
        ),
      ).rejects.toThrow();
      expect(execute).toHaveBeenCalledTimes(operation === 'capture' ? 1 : 2);
      expect(await readFile(join(f.source, 'witness.txt'), 'utf8')).toBe('ORIGINAL SOURCE BYTES');
    });
  },
);

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
        expect(revalidate).not.toHaveBeenCalled(); // Independently owned private scratch only.
        await reader.assertReadable(f.source);
        await reader.assertReadable(join(f.source, 'witness.txt'));
        expect(revalidate).not.toHaveBeenCalled();
        await new LocalRepositoryReadAccess(reader).verify();
        expect(revalidate).toHaveBeenCalledTimes(1); // Fresh cached-only outward fence.
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
        expect(revalidate).toHaveBeenCalledTimes(2 * execute.mock.calls.length);
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
