import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOwnedCriterionReceipts,
  CriterionCheckDefinitionSchema,
} from '../symposium-criterion-receipts.js';
const sha = (c: string) => c.repeat(64);
const definition = {
  id: 'sum',
  criterion: 'Totals match declared cases',
  version: 1,
  kind: 'python-json-cases',
  path: 'total.py',
  cases: [
    { id: 'empty', input: [], expected: 0 },
    { id: 'signed', input: [3, -2], expected: 1 },
  ],
} as const;
const result = {
  version: 1 as const,
  resultId: 'result',
  attemptId: 'attempt',
  inputRevision: 'base',
  inputHash: sha('a'),
  artifactRevision: 'b'.repeat(40),
  artifactHash: sha('c'),
  summary: 'sealed',
  evidenceRefs: ['artifact-seal:fence'],
  completedAt: 10,
};
it('registers bounded trusted semantic cases and rejects arbitrary executable or incomplete definitions', () => {
  expect(CriterionCheckDefinitionSchema.parse(definition)).toEqual(definition);
  for (const bad of [
    { ...definition, command: 'npm test' },
    { ...definition, cases: [] },
    { ...definition, cases: Array(9).fill(definition.cases[0]) },
    { ...definition, cases: [...definition.cases, definition.cases[0]] },
    { ...definition, path: '../total.py' },
    { ...definition, cases: [{ id: 'bad', input: 'x'.repeat(4097), expected: 0 }] },
  ])
    expect(() => CriterionCheckDefinitionSchema.parse(bad)).toThrow();
});
it('retains failed behavioral evidence even when bytes match, then verifies complete exact-result semantic coverage across restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'semantic-receipts-'));
  let owner: ReturnType<typeof createOwnedCriterionReceipts> | undefined;
  try {
    let success = false;
    const execute = vi.fn(async (_c, _r, _d, definitionDigest) => ({
      executionId: success ? 'correct' : 'wrong',
      sealFenceId: 'fence',
      sealDigest: sha('d'),
      definitionDigest,
      artifactRevision: result.artifactRevision,
      artifactHash: result.artifactHash,
      completedAt: 20,
      kind: 'python-json-cases',
      cases: definition.cases.map((c) => ({
        id: c.id,
        status: success ? 'passed' : 'mismatch',
        stdoutCapturedBytes: 2,
        stdoutCapturedSha256: sha('f'),
      })),
    }));
    const deps = {
      definitions: [definition] as never,
      currentResult: () => result,
      currentGeneration: () => 'generation',
      requireSeal: async () => ({
        seal: {
          fenceId: 'fence',
          sessionId: 'session',
          git: { commit: result.artifactRevision, committedTreeDigest: result.artifactHash },
        },
        digest: sha('d'),
        generationId: 'generation',
      }),
      execute: execute as never,
    };
    owner = createOwnedCriterionReceipts(join(root, 'db'), deps);
    const context = { sessionId: 'session', owner: 'user' };
    const failed = await owner.run(context, 'sum');
    expect(failed.verdict).toBe('failed');
    expect(await owner.run(context, 'sum')).toEqual(failed);
    expect(execute).toHaveBeenCalledOnce();
    owner.close();
    owner = undefined;
    success = true;
    const revised = {
      ...definition,
      cases: [...definition.cases, { id: 'zero', input: [0], expected: 0 }],
    };
    owner = createOwnedCriterionReceipts(join(root, 'db'), {
      ...deps,
      definitions: [revised] as never,
      execute: async (c, r, d, hash) =>
        ({
          ...(await execute(c, r, d, hash)),
          cases: revised.cases.map((c) => ({
            id: c.id,
            status: 'passed',
            stdoutCapturedBytes: 2,
            stdoutCapturedSha256: sha('f'),
          })),
        }) as never,
    });
    expect(owner.evidence(context, failed.evidenceId)).toBeNull();
    expect((await owner.run(context, 'sum')).verdict).toBe('verified');
  } finally {
    owner?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
