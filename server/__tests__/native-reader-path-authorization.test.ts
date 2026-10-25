import { afterEach, expect, it, vi, type Mock } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexNativeExecutionPolicy } from '../codex-native-execution-policy.js';
import { withPreparedRepositoryBarrierReadScope } from '../prepared-repository-barrier-read.js';
import {
  capturePreparedRepositoryReader,
  captureNativeReaderPathAuthorization,
} from '../local-repository-native-read.js';
import {
  LocalRepositoryReadAccess,
  type LocalRepositoryReadAuthority,
  type LocalRepositoryReadCeiling,
} from '../local-repository-read-access.js';
import { FrozenHostCodexExecutable } from '../frozen-host-codex-executable.js';
import * as sandbox from '../sandboxed-command.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
async function withReader(
  action: (f: {
    reader: LocalRepositoryReadAuthority & { dispose(): Promise<void> };
    root: string;
    source: string;
    current: Mock<() => void>;
    revoke(): void;
  }) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-reader-authorization-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'),
    source = join(root, 'codex'),
    workspace = join(root, 'workspace');
  await mkdir(home, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(source, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]), { mode: 0o755 });
  const executable = FrozenHostCodexExecutable.capture(source, home);
  let live = true;
  const current = vi.fn(() => {
    if (!live) throw Error('Original physical owner revoked');
    executable.assertCurrent();
  });
  const policy = codexNativeExecutionPolicy({
    bindingRevision: 'fixture',
    mode: 'agent',
    cwd: workspace,
    readableRoots: ['/'],
    writableRoots: [workspace],
    deniedRoots: [join(root, 'denied')],
    writeProtectedRoots: [],
  });
  const execute = vi
    .spyOn(sandbox, 'executeSandboxedCommand')
    .mockRejectedValue(Error('No helpers in this test'));
  await withPreparedRepositoryBarrierReadScope(
    policy,
    'fixture',
    {
      signal: new AbortController().signal,
      selectedPolicy: () => policy,
      assertCurrentSync: current,
      revalidate: async () => {},
    },
    async (scope) => {
      const reader = await capturePreparedRepositoryReader(scope, { deadline: Date.now() + 15000 });
      try {
        await action({
          reader,
          root,
          source,
          current,
          revoke: () => {
            live = false;
          },
        });
      } finally {
        await reader.dispose();
      }
    },
  );
  expect(execute).not.toHaveBeenCalled();
}
const ceiling = (): LocalRepositoryReadCeiling => ({
  assertReadable: async () => {},
  revalidate: async () => {},
});

it.runIf(process.platform === 'darwin')(
  'uses two fresh owner proofs for the exact real reader while retaining both ceiling callbacks',
  async () => {
    await withReader(async (f) => {
      const limit = ceiling();
      const read = vi.spyOn(limit, 'assertReadable');
      const proof = captureNativeReaderPathAuthorization(f.reader);
      expect(proof).toBeDefined();
      expect(Object.isFrozen(proof)).toBe(true);
      expect(proof?.reader).toBe(f.reader);
      const access = new LocalRepositoryReadAccess(f.reader, limit);
      f.current.mockClear();
      await access.assertPath(f.root);
      expect(read).toHaveBeenCalledTimes(2);
      expect(f.current).toHaveBeenCalledTimes(2);
      await access.assertPath(f.root);
      expect(read).toHaveBeenCalledTimes(4);
      expect(f.current).toHaveBeenCalledTimes(4);
    });
  },
);

it.runIf(process.platform === 'darwin')(
  'keeps reentrant ceiling checks independent and refuses subsequent revocation',
  async () => {
    await withReader(async (f) => {
      let entered = false;
      const limit = ceiling();
      limit.assertReadable = async () => {
        if (!entered) {
          entered = true;
          await access.assertPath(f.root);
          f.revoke();
        }
      };
      const access = new LocalRepositoryReadAccess(f.reader, limit);
      await expect(access.assertPath(f.root)).rejects.toMatchObject({ kind: 'access' });
    });
  },
);

it.runIf(process.platform === 'darwin')(
  'never retains a physical authorization result between path checks',
  async () => {
    await withReader(async (f) => {
      const access = new LocalRepositoryReadAccess(f.reader, ceiling());
      await access.assertPath(f.root);
      await writeFile(f.source, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 3, 2, 1]));
      await expect(access.assertPath(f.root)).rejects.toMatchObject({ kind: 'access' });
    });
  },
);

it
  .runIf(process.platform === 'darwin')
  .each(['first', 'entry-microtask', 'last', 'first-physical', 'last-physical'] as const)(
  'refuses owner or physical mutation at the %s boundary',
  async (phase) => {
    await withReader(async (f) => {
      let calls = 0;
      const limit = ceiling();
      limit.assertReadable = async () => {
        calls++;
        if (phase === 'entry-microtask' && calls === 1) {
          await Promise.resolve();
          queueMicrotask(() => queueMicrotask(f.revoke));
        }
        if ((phase === 'first' && calls === 1) || (phase === 'last' && calls === 2)) {
          await Promise.resolve();
          f.revoke();
        }
        if (
          (phase === 'first-physical' && calls === 1) ||
          (phase === 'last-physical' && calls === 2)
        )
          await writeFile(f.source, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 3, 2, 1]));
      };
      const access = new LocalRepositoryReadAccess(f.reader, limit);
      await expect(access.assertPath(f.root)).rejects.toMatchObject({ kind: 'access' });
    });
  },
);

it.runIf(process.platform === 'darwin').each(['copy', 'proxy'] as const)(
  'keeps all three proofs for a %s instead of inferring native provenance from callbacks',
  async (kind) => {
    await withReader(async (f) => {
      const other =
        kind === 'proxy'
          ? new Proxy(f.reader, {})
          : Object.freeze(Object.defineProperties({}, Object.getOwnPropertyDescriptors(f.reader)));
      expect(
        captureNativeReaderPathAuthorization(other as LocalRepositoryReadAuthority),
      ).toBeUndefined();
      const access = new LocalRepositoryReadAccess(
        other as LocalRepositoryReadAuthority,
        ceiling(),
      );
      f.current.mockClear();
      await access.assertPath(f.root);
      expect(f.current).toHaveBeenCalledTimes(3);
    });
  },
);

it.runIf(process.platform === 'darwin')(
  'refuses denied paths and disposed readers without source helpers',
  async () => {
    await withReader(async (f) => {
      const access = new LocalRepositoryReadAccess(f.reader, ceiling());
      await expect(access.assertPath(join(f.root, 'denied', 'secret'))).rejects.toMatchObject({
        kind: 'access',
      });
      await f.reader.dispose();
      await expect(access.assertPath(f.root)).rejects.toThrow();
    });
  },
);

it('checks registry identity before reading counterfeit or proxy descriptors', () => {
  const getter = vi.fn(() => {
    throw Error('Getter must not run');
  });
  const forged = Object.freeze(
    Object.defineProperties(
      {},
      {
        assertReadable: { get: getter },
        assertCurrentSync: { get: getter },
      },
    ),
  );
  expect(
    captureNativeReaderPathAuthorization(forged as LocalRepositoryReadAuthority),
  ).toBeUndefined();
  const proxy = new Proxy({}, { getOwnPropertyDescriptor: getter });
  expect(
    captureNativeReaderPathAuthorization(proxy as LocalRepositoryReadAuthority),
  ).toBeUndefined();
  expect(getter).not.toHaveBeenCalled();
});

it('retains three generic proofs and the original callback receivers', async () => {
  const receivers: unknown[] = [];
  const current = vi.fn(function (this: unknown) {
    receivers.push(this);
  });
  const generic: LocalRepositoryReadAuthority = {
    deniedRoots: [],
    deadline: Date.now() + 15000,
    assertCurrentSync: current,
    assertReadable: async function () {
      expect(this).toBe(generic);
      current.call(this);
    },
    captureReadAnchor: async () => {
      throw Error('No source effects');
    },
  };
  const access = new LocalRepositoryReadAccess(generic, ceiling());
  await access.assertPath('/fixture/root');
  expect(current).toHaveBeenCalledTimes(3);
  expect(receivers).toEqual([generic, generic, generic]);
});
