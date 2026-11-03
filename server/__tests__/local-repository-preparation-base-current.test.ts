import { afterEach, expect, it, vi } from 'vitest';
import type { NativeHostToolContext } from '../native-host-tool-context.js';
import { captureNativeLocalRepositoryPreparationSource } from '../local-repository-preparation-source.js';
import { readLocalRepositoryBaseReference } from '../local-repository-base.js';
import { captureLocalRepositoryAllocationFacts } from '../local-repository-allocation-facts.js';
import { captureNativeLocalRepositoryReader } from '../local-repository-native-read.js';
import { inspectLocalRepositoryGitMetadata } from '../local-repository-git-inspection.js';
import { readLocalRepositoryPreparationBaseReferences } from '../local-repository-git-snapshot.js';
import { captureLocalRepositoryPreparationAuthorization } from '../local-repository-preparation-authorization.js';
import { captureLocalRepositoryPreparationObjectData } from '../local-repository-preparation-object-data.js';
import {
  executeLocalRepositoryPreparation,
  withLocalRepositoryPreparationEnvelope,
  type LocalRepositoryPreparationOwners,
} from '../local-repository-preparation-operation.js';

vi.mock('../local-repository-preparation-authorization.js', () => ({
  captureLocalRepositoryPreparationAuthorization: vi.fn(),
}));
vi.mock('../local-repository-preparation-object-data.js', () => ({
  captureLocalRepositoryPreparationObjectData: vi.fn(),
}));

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
vi.mock('../local-repository-allocation-facts.js', async (original) => ({
  ...(await original<typeof import('../local-repository-allocation-facts.js')>()),
  captureLocalRepositoryAllocationFacts: vi.fn(),
}));
vi.mock('../local-repository-base.js', async (original) => ({
  ...(await original<typeof import('../local-repository-base.js')>()),
  readLocalRepositoryBaseReference: vi.fn(),
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
    async pinRoot(path: string) {
      return anchor(path);
    }
    async verify() {}
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
afterEach(() => vi.resetAllMocks());
async function fixture(base?: { kind: 'ref'; ref: string }, detached = false) {
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
  const facts = {
    source,
    baseBranch: detached ? 'a'.repeat(40) : 'base',
    baseOid: 'a'.repeat(40),
    ...(base
      ? {
          layout: 'standalone' as const,
          baseIntent: base,
          sourceBaseOid: 'a'.repeat(40),
          sourceBaseBranch: detached ? 'a'.repeat(40) : 'base',
        }
      : {}),
  };
  vi.mocked(readLocalRepositoryBaseReference).mockImplementation(
    async (_access, _metadata, selected) => ({
      oid: selected === 'HEAD' ? facts.baseOid : 'c'.repeat(40),
      ...(selected === 'HEAD' ? (detached ? {} : { branch: 'base' }) : { branch: 'chosen' }),
    }),
  );
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
    branch: detached ? null : facts.baseBranch,
    head: facts.baseOid,
  } as never);
  const held = await captureNativeLocalRepositoryPreparationSource(context, {
    workspaceId: 'fixture',
    sourcePath: source.path,
    taskRoot: '/fixture/tasks',
    ...(base ? { base } : {}),
  });
  return { held, source, witness, dispose, context };
}
it('forwards the original operation deadline and parser witness through the actual native source qualifier', async () => {
  const f = await fixture();
  const intent = Object.freeze({
    workspaceId: 'fixture',
    sourcePath: f.source.path,
    taskRoot: '/fixture/tasks',
  });
  const objects = Object.freeze({ dispose: vi.fn(async () => {}) });
  const owners = {
    context: f.context,
    async qualifySource(path, context, input, options) {
      expect(this).toBe(owners);
      expect(path).toBe(f.source.path);
      expect(context).toBe(f.context);
      expect(input).toBe(intent);
      expect(options).toEqual({ deadline });
      const held = await captureNativeLocalRepositoryPreparationSource(context, input, options);
      expect(held.publicationPackedRefs).toBe(f.witness);
      await held.assertCurrent(options);
      return held;
    },
  } as LocalRepositoryPreparationOwners;
  let deadline = 0;
  vi.mocked(captureLocalRepositoryPreparationAuthorization).mockImplementation(async (actual) => {
    const held = await actual.qualifySource(f.source.path, f.context, intent);
    return {
      ...held,
      request: { id: 'controlled-original-request' },
      owner: f.context,
      approve: vi.fn(async () => {}),
      materialize: vi.fn(async (value) => {
        expect(value).toBe(objects);
        return { state: 'materialized' };
      }),
    } as never;
  });
  vi.mocked(captureLocalRepositoryPreparationObjectData).mockImplementation(async (...args) => {
    expect(args[0]).toBe(f.context);
    expect(args[4]).toBe(deadline);
    expect(args[5]).toBe(f.witness);
    return objects as never;
  });
  await withLocalRepositoryPreparationEnvelope(f.context.signal, async (envelope) => {
    deadline = envelope.deadline;
    await expect(
      executeLocalRepositoryPreparation(owners, { path: f.source.path }, envelope),
    ).resolves.toMatchObject({ state: 'materialized' });
  });
  expect(captureLocalRepositoryPreparationObjectData).toHaveBeenCalledOnce();
  expect(objects.dispose).toHaveBeenCalledOnce();
  // Controlled read/allocation ports qualify composition only, not SRT access,
  // permission evidence, actual creation or a consumed decision owner.
  for (const [, options] of vi.mocked(captureNativeLocalRepositoryReader).mock.calls)
    expect(options.deadline).toBeLessThanOrEqual(deadline);
  expect(f.dispose).toHaveBeenCalledTimes(3);
});
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

// Pure composition variants; the allocation/reference tests prove actual Git
// bytes and the signed journey qualifies native source ownership separately.
it.each([false, true])(
  'reuses one verified HEAD allocation but refreshes later source proofs (detached=%s)',
  async (detached) => {
    const f = await fixture({ kind: 'ref', ref: 'HEAD' }, detached);
    expect(captureLocalRepositoryAllocationFacts).toHaveBeenCalledOnce();
    expect(captureNativeLocalRepositoryReader).toHaveBeenCalledOnce();
    await expect(f.held.assertCurrent()).resolves.toBeUndefined();
    expect(captureLocalRepositoryAllocationFacts).toHaveBeenCalledOnce();
    expect(captureNativeLocalRepositoryReader).toHaveBeenCalledTimes(2);
    vi.mocked(readLocalRepositoryPreparationBaseReferences).mockResolvedValue({
      branch: detached ? null : 'base',
      head: 'c'.repeat(40),
    } as never);
    vi.mocked(readLocalRepositoryBaseReference).mockResolvedValue({ oid: 'c'.repeat(40) });
    await expect(f.held.assertCurrent()).rejects.toThrow();
  },
);

it.each(['chosen', 'c'.repeat(40)])(
  'projects selected %s data without another allocation read',
  async (ref) => {
    const f = await fixture({ kind: 'ref', ref });
    expect(captureLocalRepositoryAllocationFacts).toHaveBeenCalledOnce();
    expect(captureNativeLocalRepositoryReader).toHaveBeenCalledTimes(ref === 'chosen' ? 2 : 1);
    expect(f.held.baseOid).toBe('c'.repeat(40));
    expect(f.held.baseBranch).toBe(ref === 'chosen' ? 'chosen' : 'c'.repeat(40));
    expect(f.held.allocationFacts.sourceBaseOid).toBe('a'.repeat(40));
    await expect(f.held.assertCurrent()).resolves.toBeUndefined();
    expect(captureLocalRepositoryAllocationFacts).toHaveBeenCalledOnce();
  },
);
