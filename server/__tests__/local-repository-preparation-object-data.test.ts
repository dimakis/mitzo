import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AuthoritySnapshot } from '../sandbox-authority.js';
import type { NativeHostToolContext } from '../native-host-tool-context.js';
import { captureNativeLocalRepositoryReader } from '../local-repository-native-read.js';
import { captureLocalRepositoryPreparationObjects } from '../local-repository-preparation-objects.js';
import {
  captureLocalRepositoryPreparationObjectData,
  verifyLocalRepositoryPreparationObjectData,
} from '../local-repository-preparation-object-data.js';
import type { LocalRepositoryAllocationFacts } from '../local-repository-allocation-facts.js';
import { pendingHostTaskDecisionHash, type PendingHostTaskRequest } from '../pending-host-task.js';
import * as fs from 'node:fs/promises';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

vi.mock('../local-repository-native-read.js', () => ({
  captureNativeLocalRepositoryReader: vi.fn(),
}));
vi.mock('../local-repository-preparation-objects.js', () => ({
  captureLocalRepositoryPreparationObjects: vi.fn(),
}));
vi.mock('../native-host-tool-context.js', () => ({
  captureNativeHostReadOwner: (context: NativeHostToolContext) => ({
    context,
    signal: context.signal,
    assertCurrent: context.assertCurrent.bind(context),
    assertCurrentSync: context.assertCurrentSync.bind(context),
  }),
}));
vi.mock('../local-repository-read-access.js', () => ({
  LocalRepositoryReadAccess: class {
    async pinRoot(path: string) {
      return { rootPath: path, identity: { dev: '1', ino: path.endsWith('/source') ? '2' : '3' } };
    }
    async verify() {}
  },
}));
let scratch: string;
const id = async (path: string) => {
  const v = await lstat(path, { bigint: true });
  return { dev: String(v.dev), ino: String(v.ino) };
};
beforeEach(async () => {
  vi.mocked(fs.lstat).mockImplementation(
    (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).lstat,
  );
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-pre-copy-data-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await rm(scratch, { recursive: true, force: true });
  await rm(scratch + '-retained', { recursive: true, force: true });
});
async function fixture() {
  const controller = new AbortController();
  const context = Object.freeze({
    signal: controller.signal,
    assertCurrentSync() {
      controller.signal.throwIfAborted();
    },
    async assertCurrent() {
      controller.signal.throwIfAborted();
    },
  }) as NativeHostToolContext;
  const facts = {
    source: {
      path: '/fixture/source',
      gitDirectory: '/fixture/source/.git',
      commonDirectory: '/fixture/source/.git',
      objectFormat: 'sha1',
      sourceAnchor: { rootPath: '/fixture/source', identity: { dev: '1', ino: '2' } },
      commonAnchor: { rootPath: '/fixture/source/.git', identity: { dev: '1', ino: '3' } },
    },
    baseOid: '1'.repeat(40),
  } as LocalRepositoryAllocationFacts;
  const request = Object.freeze({ id: 'fixture-request' }) as PendingHostTaskRequest;
  const reader = {
    signal: controller.signal,
    deadline: Date.now() + 30000,
    dispose: vi.fn(async () => {}),
  };
  vi.mocked(captureNativeLocalRepositoryReader).mockResolvedValue(reader as never);
  const gitDirectory = join(scratch, 'git-admin');
  await mkdir(gitDirectory);
  await writeFile(join(gitDirectory, 'config'), 'FIXED PRIVATE CONFIG');
  await writeFile(join(gitDirectory, 'object'), 'VERIFIED PRIVATE BYTES');
  const authority = new AuthoritySnapshot();
  authority.capture(join(gitDirectory, 'config'), true);
  authority.capture(join(gitDirectory, 'object'), true);
  const view = Object.freeze({
    coverage: 'preparation-required-objects-v1' as const,
    scratch,
    scratchIdentity: Object.freeze(await id(scratch)),
    scratchParentIdentity: Object.freeze(await id(dirname(scratch))),
    gitDirectory,
    baseOid: facts.baseOid,
    treeOid: '2'.repeat(40),
    privateAuthority: authority
      .serialize()
      .filter((entry) => entry.path === scratch || entry.path.startsWith(scratch + '/')),
    entries: Object.freeze([]),
  });
  const artifact = Object.freeze({ view, dispose: vi.fn(async () => {}) });
  vi.mocked(captureLocalRepositoryPreparationObjects).mockResolvedValue(artifact);
  return {
    controller,
    context,
    facts,
    request,
    reader,
    artifact,
    deadline: Date.now() + 300000,
    hash: pendingHostTaskDecisionHash(facts),
    witness: Object.freeze({ kind: 'absent' as const }),
  };
}
it('closes the original read owner before exposing only bound object data and scratch custody', async () => {
  const f = await fixture();
  const result = await captureLocalRepositoryPreparationObjectData(
    f.context,
    f.request,
    f.facts,
    f.hash,
    f.deadline,
    f.witness,
  );
  expect(f.reader.dispose).toHaveBeenCalledOnce();
  expect(Object.keys(result)).toEqual([]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Reflect.ownKeys(result)).not.toContain('reader');
  expect(
    await verifyLocalRepositoryPreparationObjectData(
      result,
      f.context,
      pendingHostTaskDecisionHash(f.request),
      f.facts,
      f.hash,
      f.witness,
    ),
  ).toEqual(f.artifact.view);
  await result.dispose();
  expect(f.artifact.dispose).toHaveBeenCalledOnce();
});
it('joins capture after cancellation even before the disposer assignment can complete', async () => {
  const f = await fixture();
  let release!: (value: typeof f.artifact) => void;
  const creation = new Promise<typeof f.artifact>((resolve) => {
    release = resolve;
  });
  vi.mocked(captureLocalRepositoryPreparationObjects).mockReturnValue(creation);
  let done = false;
  const pending = captureLocalRepositoryPreparationObjectData(
    f.context,
    f.request,
    f.facts,
    f.hash,
    f.deadline,
    f.witness,
  ).finally(() => {
    done = true;
  });
  const outcome = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(captureLocalRepositoryPreparationObjects).toHaveBeenCalledOnce());
  f.controller.abort(Error('synthetic Stop'));
  await Promise.resolve();
  expect(done).toBe(false);
  expect(f.reader.dispose).not.toHaveBeenCalled();
  release(f.artifact);
  await outcome;
  expect(f.reader.dispose).toHaveBeenCalledOnce();
  expect(f.artifact.dispose).toHaveBeenCalledOnce();
});
it('disposes assigned scratch when read-owner cleanup refuses outward delivery', async () => {
  const f = await fixture();
  f.reader.dispose.mockRejectedValue(Error('synthetic reader cleanup failure'));
  await expect(
    captureLocalRepositoryPreparationObjectData(
      f.context,
      f.request,
      f.facts,
      f.hash,
      f.deadline,
      f.witness,
    ),
  ).rejects.toThrow();
  expect(f.artifact.dispose).toHaveBeenCalledOnce();
});
it('joins both private root and parent observations before refusing use', async () => {
  const f = await fixture();
  const data = await captureLocalRepositoryPreparationObjectData(
    f.context,
    f.request,
    f.facts,
    f.hash,
    f.deadline,
    f.witness,
  );
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let parentStarted = false,
    done = false;
  vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === scratch) throw Error('synthetic root refusal');
    if (args[0] === dirname(scratch)) {
      parentStarted = true;
      await held;
    }
    return Reflect.apply(actual.lstat, actual, args);
  }) as typeof fs.lstat);
  const pending = verifyLocalRepositoryPreparationObjectData(
    data,
    f.context,
    pendingHostTaskDecisionHash(f.request),
    f.facts,
    f.hash,
    f.witness,
  ).finally(() => {
    done = true;
  });
  const outcome = expect(pending).rejects.toThrow();
  try {
    await vi.waitFor(() => expect(parentStarted).toBe(true));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
  } finally {
    release();
    await outcome;
  }
});
it.each(['config', 'object'])(
  'rejects changed copied %s bytes at use without extending any authority',
  async (name) => {
    const f = await fixture();
    const data = await captureLocalRepositoryPreparationObjectData(
      f.context,
      f.request,
      f.facts,
      f.hash,
      f.deadline,
      f.witness,
    );
    await writeFile(join(f.artifact.view.gitDirectory, name), 'CHANGED');
    await expect(
      verifyLocalRepositoryPreparationObjectData(
        data,
        f.context,
        pendingHostTaskDecisionHash(f.request),
        f.facts,
        f.hash,
        f.witness,
      ),
    ).rejects.toThrow();
  },
);
it('rejects foreign scratch replacement and preserves its canary', async () => {
  const f = await fixture();
  const data = await captureLocalRepositoryPreparationObjectData(
    f.context,
    f.request,
    f.facts,
    f.hash,
    f.deadline,
    f.witness,
  );
  await rename(scratch, scratch + '-retained');
  await mkdir(scratch);
  await writeFile(join(scratch, 'FOREIGN'), 'KEEP');
  await expect(
    verifyLocalRepositoryPreparationObjectData(
      data,
      f.context,
      pendingHostTaskDecisionHash(f.request),
      f.facts,
      f.hash,
      f.witness,
    ),
  ).rejects.toThrow();
  expect(await readFile(join(scratch, 'FOREIGN'), 'utf8')).toBe('KEEP');
});
it.each(['context', 'request', 'facts', 'base'])(
  'refuses changed %s correlation before using retained data',
  async (kind) => {
    const f = await fixture();
    const data = await captureLocalRepositoryPreparationObjectData(
      f.context,
      f.request,
      f.facts,
      f.hash,
      f.deadline,
      f.witness,
    );
    await expect(
      verifyLocalRepositoryPreparationObjectData(
        data,
        kind === 'context' ? (Object.freeze({ ...f.context }) as NativeHostToolContext) : f.context,
        kind === 'request' ? '0'.repeat(64) : pendingHostTaskDecisionHash(f.request),
        kind === 'base' ? { ...f.facts, baseOid: '3'.repeat(40) } : f.facts,
        kind === 'facts' ? '0'.repeat(64) : f.hash,
        f.witness,
      ),
    ).rejects.toThrow();
  },
);

it('refuses a missing original parser witness before opening a new source reader', async () => {
  const f = await fixture();
  await expect(
    captureLocalRepositoryPreparationObjectData(
      f.context,
      f.request,
      f.facts,
      f.hash,
      f.deadline,
      undefined,
    ),
  ).rejects.toThrow();
  expect(captureNativeLocalRepositoryReader).not.toHaveBeenCalled();
});
it('refuses a substituted immutable witness even when its descriptive bytes are identical', async () => {
  const f = await fixture();
  const data = await captureLocalRepositoryPreparationObjectData(
    f.context,
    f.request,
    f.facts,
    f.hash,
    f.deadline,
    f.witness,
  );
  await expect(
    verifyLocalRepositoryPreparationObjectData(
      data,
      f.context,
      pendingHostTaskDecisionHash(f.request),
      f.facts,
      f.hash,
      Object.freeze({ kind: 'absent' }),
    ),
  ).rejects.toThrow();
});
it.each([
  { kind: 'absent' },
  Object.freeze({ kind: 'absent', unexpected: 'excluded' }),
  Object.freeze({
    kind: 'file',
    identity: Object.freeze({ dev: '1', ino: '2' }),
    size: 16 * 1024 * 1024 + 1,
    sha256: 'a'.repeat(64),
  }),
])('refuses malformed historical witness before any source reader', async (witness) => {
  const f = await fixture();
  await expect(
    captureLocalRepositoryPreparationObjectData(
      f.context,
      f.request,
      f.facts,
      f.hash,
      f.deadline,
      witness,
    ),
  ).rejects.toThrow('Original preparation packed-ref witness unavailable');
  expect(captureNativeLocalRepositoryReader).not.toHaveBeenCalled();
});
it('rejects an accessor witness without invoking its getter', async () => {
  const f = await fixture();
  const getter = vi.fn(() => 'absent');
  const witness = Object.freeze(Object.defineProperty({}, 'kind', { get: getter }));
  await expect(
    captureLocalRepositoryPreparationObjectData(
      f.context,
      f.request,
      f.facts,
      f.hash,
      f.deadline,
      witness,
    ),
  ).rejects.toThrow('Original preparation packed-ref witness unavailable');
  expect(getter).not.toHaveBeenCalled();
  expect(captureNativeLocalRepositoryReader).not.toHaveBeenCalled();
});
it('retains the exact bounded file witness outside the existing facts hash', async () => {
  const f = await fixture();
  const witness = Object.freeze({
    kind: 'file' as const,
    identity: Object.freeze({ dev: '1', ino: '2' }),
    size: 16 * 1024 * 1024,
    sha256: 'a'.repeat(64),
  });
  const data = await captureLocalRepositoryPreparationObjectData(
    f.context,
    f.request,
    f.facts,
    f.hash,
    f.deadline,
    witness,
  );
  expect(data.publicationPackedRefs).toBe(witness);
  expect(pendingHostTaskDecisionHash(f.facts)).toBe(f.hash);
  await expect(
    verifyLocalRepositoryPreparationObjectData(
      data,
      f.context,
      pendingHostTaskDecisionHash(f.request),
      f.facts,
      f.hash,
      witness,
    ),
  ).resolves.toEqual(f.artifact.view);
});
