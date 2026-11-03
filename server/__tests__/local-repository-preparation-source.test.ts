import { afterEach, expect, it, vi } from 'vitest';
import type { NativeHostToolContext } from '../native-host-tool-context.js';
import * as nativeRead from '../local-repository-native-read.js';
import * as allocation from '../local-repository-allocation-facts.js';
import {
  captureNativeLocalRepositoryPreparationSource,
  preparationSourceIncludesContext,
} from '../local-repository-preparation-source.js';

afterEach(() => vi.restoreAllMocks());

// Composition-only control: fake facts/read port do not qualify native access.
// The signed native fixture separately exercises the actual producer and SRT.
it.each(['sync', 'async', 'current'] as const)(
  'retains original-context provenance and cleanup refusal (owner=%s)',
  async (kind) => {
    let live = true;
    const assertCurrentSync = vi.fn(() => {
      if (!live && kind === 'sync') throw Error('Original owner changed');
    });
    const assertCurrent = vi.fn(async () => {
      if (!live) throw Error('Original physical owner changed');
    });
    const context = {
      signal: new AbortController().signal,
      nativeBaseReadScope: { assertCurrentSync },
      assertCurrentSync,
      assertCurrent,
    } as unknown as NativeHostToolContext;
    const anchor = { rootPath: '/fixture/source', identity: { dev: '1', ino: '2' } };
    const facts = {
      version: 1 as const,
      workspaceId: 'd9fd4b8b-276a-4dd7-968b-7f879fc3c449',
      baseOid: 'a'.repeat(40),
      baseBranch: 'fixture',
      featureBranch: 'mitzo/fixture',
      source: {
        path: anchor.rootPath,
        gitDirectory: '/fixture/source/.git',
        commonDirectory: '/fixture/source/.git',
        objectFormat: 'sha1' as const,
        referenceCoverage: 'preparation-head-and-namespace-v1' as const,
        comparisonConfig: {},
        sourceAnchor: anchor,
        commonAnchor: { ...anchor, rootPath: '/fixture/source/.git' },
      },
      taskRoot: { ...anchor, rootPath: '/fixture/tasks' },
      directories: [],
      existingDirectories: [],
      absentPaths: [],
    };
    const dispose = vi.fn(async () => {
      await Promise.resolve();
      if (kind !== 'current') live = false;
    });
    vi.spyOn(nativeRead, 'captureNativeLocalRepositoryReader').mockResolvedValue({
      deadline: Date.now() + 30000,
      deniedRoots: [],
      assertReadable: vi.fn(async () => {}),
      captureReadAnchor: vi.fn(async () => anchor),
      dispose,
    });
    vi.spyOn(allocation, 'captureLocalRepositoryAllocationFacts').mockResolvedValue({
      facts,
      factsSha256: 'b'.repeat(64),
      publicationPackedRefs: Object.freeze({ kind: 'absent' as const }),
      verify: vi.fn(async () => {}),
    });
    const capture = captureNativeLocalRepositoryPreparationSource(context, {
      workspaceId: facts.workspaceId,
      sourcePath: anchor.rootPath,
      taskRoot: facts.taskRoot.rootPath,
    });
    if (kind === 'current') {
      const source = await capture;
      expect(preparationSourceIncludesContext(source, context)).toBe(true);
      expect(preparationSourceIncludesContext({ ...source }, context)).toBe(false);
      expect(preparationSourceIncludesContext(source, { ...context })).toBe(false);
    } else await expect(capture).rejects.toThrow('Original physical owner changed');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(assertCurrent).toHaveBeenCalledTimes(1);
  },
);
