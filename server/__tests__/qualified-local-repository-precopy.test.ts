import type { NativeHostToolContext } from '../native-host-tool-context.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeQualifiedLocalRepositoryTask } from '../qualified-local-repository-actor.js';
import { captureLocalRepositoryPreparationObjects } from '../local-repository-preparation-objects.js';
import { captureLocalRepositoryAllocationFacts } from '../local-repository-allocation-facts.js';
import { verifyLocalRepositoryPreparationObjectData } from '../local-repository-preparation-object-data.js';
import { executePrivateRepositoryStagingCheckout } from '../sandboxed-command.js';
import { captureNativeLocalRepositoryReader } from '../local-repository-native-read.js';

vi.mock('../native-host-tool-context.js', () => ({
  captureNativeHostReadOwner: (context: NativeHostToolContext) => ({
    scope: { deniedRoots: [] },
    assertCurrentSync: context.assertCurrentSync,
    assertCurrent: context.assertCurrent,
  }),
}));
vi.mock('../local-repository-native-read.js', () => ({
  captureNativeLocalRepositoryReader: vi.fn(),
}));
vi.mock('../local-repository-allocation-facts.js', () => ({
  captureLocalRepositoryAllocationFacts: vi.fn(),
}));
vi.mock('../local-repository-preparation-object-data.js', () => ({
  verifyLocalRepositoryPreparationObjectData: vi.fn(),
}));
vi.mock('../local-repository-preparation-objects.js', () => ({
  captureLocalRepositoryPreparationObjects: vi.fn(),
}));
vi.mock('../local-repository-read-access.js', () => ({
  LocalRepositoryReadAccess: class {
    async pinRoot() {
      return { identity: { dev: '1', ino: '2' } };
    }
  },
}));
vi.mock('../sandboxed-command.js', () => ({
  executePrivateRepositoryStagingCheckout: vi.fn(),
  executePrivateNativeFileHelper: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
});
function fixture() {
  const signal = new AbortController().signal;
  const context = { signal, assertCurrentSync: vi.fn(), assertCurrent: vi.fn(async () => {}) };
  const objects = { deadline: Date.now() + 300000, dispose: vi.fn(async () => {}) };
  const facts = {
    workspaceId: 'fixture',
    source: {
      path: '/fixture/source',
      commonDirectory: '/fixture/source/.git',
      commonAnchor: { identity: { dev: '1', ino: '2' } },
      objectFormat: 'sha1',
    },
    taskRoot: { rootPath: '/fixture/tasks' },
    existingDirectories: [],
    baseOid: '1'.repeat(40),
  };
  const reader = { signal, deadline: Date.now() + 30000, dispose: vi.fn(async () => {}) };
  vi.mocked(captureNativeLocalRepositoryReader).mockResolvedValue(reader as never);
  vi.mocked(captureLocalRepositoryAllocationFacts).mockResolvedValue({
    factsSha256: 'f'.repeat(64),
    publicationPackedRefs: { kind: 'absent' },
  } as never);
  vi.mocked(captureLocalRepositoryPreparationObjects).mockRejectedValue(
    Error('duplicate object reader forbidden'),
  );
  const operation = {
    context,
    facts,
    factsSha256: 'f'.repeat(64),
    requestSha256: 'r'.repeat(64),
    scopeSha256: 's'.repeat(64),
    expiresAt: Date.now() + 120000,
    objects,
    publicationPackedRefs: Object.freeze({ kind: 'absent' as const }),
    assertCurrentSync: vi.fn(),
    assertCurrent: vi.fn(async () => {}),
  };
  return { operation, objects, reader };
}
it('uses the original bound private data verifier without a second source-object capture', async () => {
  const f = fixture();
  vi.mocked(verifyLocalRepositoryPreparationObjectData).mockRejectedValue(
    Error('owned private bytes changed'),
  );
  await expect(materializeQualifiedLocalRepositoryTask(f.operation as never)).rejects.toThrow();
  expect(verifyLocalRepositoryPreparationObjectData).toHaveBeenCalledOnce();
  expect(captureLocalRepositoryPreparationObjects).not.toHaveBeenCalled();
  expect(executePrivateRepositoryStagingCheckout).not.toHaveBeenCalled();
  expect(f.objects.dispose).toHaveBeenCalledOnce();
  expect(captureLocalRepositoryAllocationFacts).not.toHaveBeenCalled();
  expect(captureNativeLocalRepositoryReader).not.toHaveBeenCalled();
  expect(f.operation.assertCurrent).not.toHaveBeenCalled();
  expect(f.operation.context.assertCurrent).toHaveBeenCalledTimes(2);
  expect(f.operation.context.assertCurrent.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(verifyLocalRepositoryPreparationObjectData).mock.invocationCallOrder[0],
  );
  expect(vi.mocked(verifyLocalRepositoryPreparationObjectData).mock.calls[0][5]).toBe(
    f.operation.publicationPackedRefs,
  );
});
it('retains the original native proof at private worker execution after private verification', async () => {
  const f = fixture();
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-precopy-owner-')));
  try {
    const gitDirectory = join(scratch, 'git-admin');
    await mkdir(gitDirectory);
    let live = true,
      workerCalls = 0;
    vi.mocked(verifyLocalRepositoryPreparationObjectData).mockImplementation(async () => {
      live = false; // Private verification may await; the execution gate must refresh authority.
      return { scratch, gitDirectory, privateAuthority: [] } as never;
    });
    f.operation.context.assertCurrent.mockImplementation(async () => {
      if (!live) throw Error('original async source owner revoked');
    });
    vi.mocked(executePrivateRepositoryStagingCheckout).mockImplementation(async (options) => {
      // Controlled execution port only. The separate real helper tests cover
      // its pre-spawn/post-result gates; this proves the actor wires its owner.
      await options.revalidate();
      workerCalls++;
    });
    await expect(materializeQualifiedLocalRepositoryTask(f.operation as never)).rejects.toThrow(
      'original async source owner revoked',
    );
    expect(f.operation.context.assertCurrent).toHaveBeenCalledTimes(3); // artifact use, execution, cleanup
    expect(f.operation.assertCurrent).not.toHaveBeenCalled();
    expect(verifyLocalRepositoryPreparationObjectData).toHaveBeenCalledOnce();
    expect(executePrivateRepositoryStagingCheckout).toHaveBeenCalledOnce();
    expect(workerCalls).toBe(0);
    expect(captureLocalRepositoryPreparationObjects).not.toHaveBeenCalled();
    expect(captureNativeLocalRepositoryReader).not.toHaveBeenCalled();
    expect(f.objects.dispose).toHaveBeenCalledOnce();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

it.each(['dispose', 'owner', 'both'] as const)(
  'retains the original artifact failure when %s finalization also fails',
  async (mode) => {
    const f = fixture();
    const original = Error('private artifact verification failure');
    const disposal = Error('private artifact disposal failure');
    const revoked = Error('private native owner failure');
    vi.mocked(verifyLocalRepositoryPreparationObjectData).mockRejectedValue(original);
    if (mode !== 'owner') f.objects.dispose.mockRejectedValue(disposal);
    if (mode !== 'dispose')
      f.operation.context.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValue(revoked);
    await expect(
      materializeQualifiedLocalRepositoryTask(f.operation as never),
    ).rejects.toMatchObject({
      code: 'operation_finalization_failed',
      cause: original,
      errors: [
        original,
        ...(mode !== 'owner' ? [disposal] : []),
        ...(mode !== 'dispose' ? [revoked] : []),
      ],
    });
    expect(f.objects.dispose).toHaveBeenCalledOnce();
    expect(f.operation.context.assertCurrent).toHaveBeenCalledTimes(2);
    expect(executePrivateRepositoryStagingCheckout).not.toHaveBeenCalled();
  },
);
