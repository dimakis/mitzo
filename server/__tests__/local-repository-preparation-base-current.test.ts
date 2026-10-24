import { afterEach, expect, it, vi } from 'vitest';
import type { NativeHostToolContext } from '../native-host-tool-context.js';
import { captureNativeLocalRepositoryPreparationSource } from '../local-repository-preparation-source.js';
import { captureLocalRepositoryAllocationFacts } from '../local-repository-allocation-facts.js';
import { captureNativeLocalRepositoryReader } from '../local-repository-native-read.js';
import { inspectLocalRepositoryGitMetadata } from '../local-repository-git-inspection.js';
import { readLocalRepositoryPreparationBaseReferences } from '../local-repository-git-snapshot.js';

vi.mock('../native-host-tool-context.js', () => ({
  captureNativeHostReadOwner: (context: NativeHostToolContext) => ({
    scope: context.nativeBaseReadScope,
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
vi.mock('../local-repository-git-inspection.js', () => ({
  inspectLocalRepositoryGitMetadata: vi.fn(),
}));
vi.mock('../local-repository-git-snapshot.js', () => ({
  readLocalRepositoryPreparationBaseReferences: vi.fn(),
}));
const anchor = (rootPath: string) => ({
  rootPath,
  identity: { dev: '1', ino: rootPath.endsWith('.git') ? '3' : '2' },
});
vi.mock('../local-repository-read-access.js', () => ({
  LocalRepositoryReadAccess: class {
    static async capturePreparationBase() {
      return {
        async pinRoot(path: string) {
          return anchor(path);
        },
        async verify() {},
        async assertPath() {},
      };
    }
  },
}));
afterEach(() => vi.clearAllMocks());
async function fixture() {
  const context = {
    signal: new AbortController().signal,
    nativeBaseReadScope: { assertCurrentSync() {} },
    assertCurrentSync() {},
    async assertCurrent() {},
  } as unknown as NativeHostToolContext;
  const source = {
    path: '/fixture/source',
    gitDirectory: '/fixture/source/.git',
    commonDirectory: '/fixture/source/.git',
    objectFormat: 'sha1',
    comparisonConfig: { coreFileMode: true, coreAutocrlf: false },
    sourceAnchor: anchor('/fixture/source'),
    commonAnchor: anchor('/fixture/source/.git'),
  };
  const facts = { source, baseBranch: 'base', baseOid: 'a'.repeat(40) };
  const witness = Object.freeze({ kind: 'absent' as const });
  vi.mocked(captureLocalRepositoryAllocationFacts).mockResolvedValue({
    facts,
    factsSha256: 'b'.repeat(64),
    publicationPackedRefs: witness,
  } as never);
  const dispose = vi.fn(async () => {});
  vi.mocked(captureNativeLocalRepositoryReader).mockImplementation(
    async (_context, options) => ({ deadline: options.deadline, dispose }) as never,
  );
  vi.mocked(inspectLocalRepositoryGitMetadata).mockResolvedValue(source as never);
  vi.mocked(readLocalRepositoryPreparationBaseReferences).mockResolvedValue({
    branch: facts.baseBranch,
    head: facts.baseOid,
  } as never);
  const held = await captureNativeLocalRepositoryPreparationSource(context, {
    workspaceId: 'fixture',
    sourcePath: source.path,
    taskRoot: '/fixture/tasks',
  });
  return { held, source, witness, dispose };
}
it.each([
  ['objectFormat', { objectFormat: 'sha256' }],
  ['core.fileMode', { comparisonConfig: { coreFileMode: false, coreAutocrlf: false } }],
  ['core.autocrlf', { comparisonConfig: { coreFileMode: true, coreAutocrlf: 'input' } }],
] as const)(
  'refuses changed supported %s in the SAME original full source assertion',
  async (_name, change) => {
    const f = await fixture();
    vi.mocked(inspectLocalRepositoryGitMetadata).mockResolvedValue({
      ...f.source,
      ...change,
    } as never);
    await expect(f.held.assertCurrent()).rejects.toThrow();
    expect(f.dispose).toHaveBeenCalledTimes(2);
  },
);
it('retains original initial-parser witness without treating coverage labels as source metadata', async () => {
  const f = await fixture();
  vi.mocked(inspectLocalRepositoryGitMetadata).mockResolvedValue({
    ...f.source,
    qualification: 'preparation',
    baseObservationCoverage: 'preparation-base-observation-v1',
  } as never);
  await expect(f.held.assertCurrent()).resolves.toBeUndefined();
  expect((f.held as unknown as { publicationPackedRefs: unknown }).publicationPackedRefs).toBe(
    f.witness,
  );
});
it('propagates the existing unsafe metadata parser refusal and joins reader disposal', async () => {
  const f = await fixture();
  vi.mocked(inspectLocalRepositoryGitMetadata).mockRejectedValue(
    Error('synthetic unsafe parser refusal'),
  );
  await expect(f.held.assertCurrent()).rejects.toThrow();
  expect(f.dispose).toHaveBeenCalledTimes(2);
});
