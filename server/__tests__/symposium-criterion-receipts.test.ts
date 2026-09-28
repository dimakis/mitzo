import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createOwnedCriterionReceipts } from '../symposium-criterion-receipts.js';

const hash = (letter: string) => letter.repeat(64);
const scope = { owner: 'user', sessionId: 'session' };
const result = {
  version: 1 as const,
  resultId: 'result',
  attemptId: 'attempt',
  inputRevision: 'base',
  inputHash: hash('a'),
  artifactRevision: 'b'.repeat(40),
  artifactHash: hash('c'),
  summary: 'sealed result',
  evidenceRefs: ['artifact-seal:fence'],
  completedAt: 10,
};
const seal = {
  fenceId: 'fence',
  sessionId: 'session',
  git: { commit: result.artifactRevision, committedTreeDigest: result.artifactHash },
};
const definition = {
  id: 'required-file',
  criterion: 'The approved marker exists',
  version: 1 as const,
  kind: 'file-sha256' as const,
  path: 'marker.txt',
  expectedSha256: hash('d'),
};

it('runs one registered check and retains an immutable exact-result receipt across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'criterion-receipt-'));
  try {
    const check = vi.fn(async (_scope, _result, _definition, definitionDigest) => ({
      executionId: 'physical-execution-1',
      sealFenceId: 'fence',
      sealDigest: hash('e'),
      definitionDigest,
      artifactRevision: result.artifactRevision,
      artifactHash: result.artifactHash,
      observedSha256: hash('d'),
      completedAt: 20,
    }));
    const deps = {
      definitions: [definition],
      currentResult: () => result,
      requireSeal: async () => ({ seal, digest: hash('e'), generationId: 'generation' }),
      execute: check,
    };
    const owner = createOwnedCriterionReceipts(join(directory, 'receipts.db'), deps);
    const evidence = await owner.run(scope, 'required-file');
    expect(evidence).toMatchObject({
      resultId: 'result',
      criterion: definition.criterion,
      verdict: 'verified',
      artifactRevision: result.artifactRevision,
    });
    expect(owner.evidence(scope, evidence.evidenceId)).toEqual(evidence);
    expect(check).toHaveBeenCalledOnce();
    expect(await owner.run(scope, 'required-file')).toEqual(evidence);
    expect(check).toHaveBeenCalledOnce();
    owner.close();
    const recovered = createOwnedCriterionReceipts(join(directory, 'receipts.db'), deps);
    expect(recovered.evidence(scope, evidence.evidenceId)).toEqual(evidence);
    recovered.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('fails closed on unregistered definitions, forged physical bindings and stale artifacts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'criterion-receipt-'));
  try {
    let current = result;
    const owner = createOwnedCriterionReceipts(join(directory, 'receipts.db'), {
      definitions: [definition],
      currentResult: () => current,
      requireSeal: async () => ({ seal, digest: hash('e'), generationId: 'generation' }),
      execute: async (_scope, _result, _definition, digest) => ({
        executionId: 'physical-execution-1',
        sealFenceId: 'fence',
        sealDigest: hash('e'),
        definitionDigest: digest,
        artifactRevision: result.artifactRevision,
        artifactHash: hash('0'),
        observedSha256: hash('d'),
        completedAt: 20,
      }),
    });
    await expect(owner.run(scope, 'unknown')).rejects.toThrow(/definition/i);
    await expect(owner.run(scope, 'required-file')).rejects.toThrow(/binding/i);
    expect(owner.evidence(scope, 'forged')).toBeNull();
    current = { ...result, resultId: 'successor' };
    expect(owner.evidence(scope, 'forged')).toBeNull();
    owner.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('does not reuse an old receipt after the current result advances', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'criterion-receipt-'));
  try {
    let current = result;
    const owner = createOwnedCriterionReceipts(join(directory, 'receipts.db'), {
      definitions: [definition],
      currentResult: () => current,
      requireSeal: async () => ({ seal, digest: hash('e'), generationId: 'generation' }),
      execute: async (_scope, _result, _definition, definitionDigest) => ({
        executionId: 'physical-execution-1',
        sealFenceId: 'fence',
        sealDigest: hash('e'),
        definitionDigest,
        artifactRevision: result.artifactRevision,
        artifactHash: result.artifactHash,
        observedSha256: null,
        completedAt: 20,
      }),
    });
    const evidence = await owner.run(scope, 'required-file');
    expect(evidence.verdict).toBe('failed');
    current = { ...result, resultId: 'new-result' };
    expect(owner.evidence(scope, evidence.evidenceId)).toBeNull();
    owner.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('rejects a changed stored execution or artifact generation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'criterion-receipt-'));
  try {
    const path = join(directory, 'receipts.db');
    const owner = createOwnedCriterionReceipts(path, {
      definitions: [definition],
      currentResult: () => result,
      requireSeal: async () => ({ seal, digest: hash('e'), generationId: 'generation' }),
      execute: async (_scope, _result, _definition, definitionDigest) => ({
        executionId: 'physical-execution-1',
        sealFenceId: 'fence',
        sealDigest: hash('e'),
        definitionDigest,
        artifactRevision: result.artifactRevision,
        artifactHash: result.artifactHash,
        observedSha256: hash('d'),
        completedAt: 20,
      }),
    });
    const evidence = await owner.run(scope, 'required-file');
    owner.close();
    const raw = new Database(path);
    raw
      .prepare(
        "UPDATE symposium_criterion_receipts SET generation_id='another' WHERE evidence_id=?",
      )
      .run(evidence.evidenceId);
    raw.close();
    const reopened = createOwnedCriterionReceipts(path, {
      definitions: [definition],
      currentResult: () => result,
      requireSeal: async () => ({ seal, digest: hash('e'), generationId: 'generation' }),
      execute: async () => {
        throw new Error('No replay');
      },
    });
    expect(reopened.evidence(scope, evidence.evidenceId)).toBeNull();
    await expect(reopened.run(scope, 'required-file')).rejects.toThrow(/changed/i);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
