import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { materializeQualifiedLocalRepositoryTask } from '../qualified-local-repository-actor.js';
import { verifyLocalRepositoryPreparationObjectData } from '../local-repository-preparation-object-data.js';
import { executePrivateRepositoryStagingCheckout } from '../sandboxed-command.js';

vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  open: vi.fn(),
}));
vi.mock('../local-repository-preparation-object-data.js', () => ({
  verifyLocalRepositoryPreparationObjectData: vi.fn(),
}));
vi.mock('../sandboxed-command.js', () => ({
  executePrivateRepositoryStagingCheckout: vi.fn(),
  executePrivateNativeFileHelper: vi.fn(),
}));
vi.mock('../native-host-tool-context.js', () => ({
  captureNativeHostReadOwner: (context: { signal: AbortSignal }) => ({
    scope: { deniedRoots: [] },
    assertCurrentSync: () => context.signal.throwIfAborted(),
    assertCurrent: async () => context.signal.throwIfAborted(),
  }),
}));
afterEach(() => vi.resetAllMocks());

// Synthetic owners and private filesystem only. Stop at the first metadata
// write: this tests bounded observations and failure joining, not publication
// authority. The full native journeys separately qualify actual OS fences.
function fixture(count = 1025) {
  const controller = new AbortController();
  const deadline = Date.now() + 120000;
  const stop = Error('metadata boundary');
  const dispose = vi.fn(async () => {});
  const current = vi.fn(() => controller.signal.throwIfAborted());
  const entries = Array.from({ length: count }, (_, i) => ({
    path: `file-${i}`,
    mode: '100644',
    size: 0,
    sha256: '0'.repeat(64),
  }));
  const info = { dev: 1n, ino: 2n };
  vi.mocked(fs.lstat).mockResolvedValue(info as never);
  vi.mocked(fs.mkdir).mockResolvedValue(undefined);
  vi.mocked(fs.open).mockResolvedValue({
    stat: async () => ({ isFile: () => true, nlink: 1, size: 0, mtimeMs: 1, ctimeMs: 1 }),
    readFile: async () => Buffer.alloc(0),
    close: async () => {},
  } as never);
  let stagingChecks = 0;
  vi.mocked(fs.writeFile).mockImplementation(async () => {
    stagingChecks = current.mock.calls.length;
    throw stop;
  });
  vi.mocked(executePrivateRepositoryStagingCheckout).mockImplementation(async () => {
    current.mockClear();
    return {} as never;
  });
  vi.mocked(verifyLocalRepositoryPreparationObjectData).mockResolvedValue({
    scratch: '/private/staging-fixture',
    gitDirectory: '/private/staging-fixture/git',
    scratchIdentity: { dev: '1', ino: '2' },
    privateAuthority: [],
    entries,
  } as never);
  const operation = {
    context: { signal: controller.signal },
    facts: {
      existingDirectories: [],
      taskRoot: { rootPath: '/private/task-root' },
      source: { commonDirectory: '/private/source/.git' },
      workspaceId: 'fixture',
      baseOid: '1'.repeat(40),
      featureBranch: 'fixture',
    },
    expiresAt: deadline,
    objects: Object.freeze({ deadline, dispose }),
    publicationPackedRefs: Object.freeze({ kind: 'absent' }),
    assertCurrentSync: current,
    assertCurrent: async () => controller.signal.throwIfAborted(),
  } as unknown as Parameters<typeof materializeQualifiedLocalRepositoryTask>[0];
  return {
    controller,
    info,
    stop,
    dispose,
    current,
    operation,
    stagingChecks: () => stagingChecks,
  };
}

it('checks every private entry with bounded owner-fence overhead for a large checkout', async () => {
  const f = fixture();
  await expect(materializeQualifiedLocalRepositoryTask(f.operation)).rejects.toBe(f.stop);
  const reads = vi.mocked(fs.lstat).mock.calls.filter(([path]) => String(path).includes('/file-'));
  expect(new Set(reads.map(([path]) => path)).size).toBe(1025);
  expect(reads).toHaveLength(1025);
  expect(f.stagingChecks()).toBeLessThan(24);
  expect(f.dispose).toHaveBeenCalledOnce();
});

it.each(['revoked', 'missing'] as const)(
  'joins pending private reads before rejecting %s observations',
  async (failure) => {
    const f = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pendingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      pendingStarted = resolve;
    });
    const refused = Error(failure);
    vi.mocked(fs.lstat).mockImplementation(async (path) => {
      if (String(path).endsWith('/file-0')) {
        pendingStarted();
        await held;
      }
      if (failure === 'missing' && String(path).endsWith('/file-1')) throw refused;
      return f.info as never;
    });
    let settled = false;
    const run = materializeQualifiedLocalRepositoryTask(f.operation).catch((error) => {
      settled = true;
      return error;
    });
    await started;
    if (failure === 'revoked') f.controller.abort(refused);
    // Let a fail-fast join settle while file-0 remains held. The actual
    // allSettled boundary must keep both cleanup and metadata writes waiting.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(f.dispose).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
    release();
    expect(await run).toBe(refused);
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(
      vi.mocked(fs.lstat).mock.calls.filter(([path]) => String(path).includes('/file-')).length,
    ).toBeLessThanOrEqual(256);
  },
);
