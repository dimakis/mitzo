import type { NativeHostToolContext } from '../native-host-tool-context.js';
import { afterEach, expect, it, vi } from 'vitest';
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
    assertCurrent: vi.fn(async () => {}),
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
  expect(f.reader.dispose).toHaveBeenCalledOnce();
});
it('retains the genuine consumed full callback at the former object-reader boundary', async () => {
  const f = fixture();
  vi.mocked(verifyLocalRepositoryPreparationObjectData).mockResolvedValue({
    scratch: '/not-used',
    privateAuthority: [],
  } as never);
  f.operation.assertCurrent.mockImplementation(async () => {
    if (f.operation.assertCurrent.mock.calls.length === 3)
      throw Error('original async source owner revoked');
  });
  await expect(materializeQualifiedLocalRepositoryTask(f.operation as never)).rejects.toThrow(
    'original async source owner revoked',
  );
  expect(f.operation.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(executePrivateRepositoryStagingCheckout).not.toHaveBeenCalled();
  expect(captureLocalRepositoryPreparationObjects).not.toHaveBeenCalled();
  expect(f.objects.dispose).toHaveBeenCalledOnce();
});
