import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumReviewStore } from '../symposium-review-workflows.js';

let directory: string;
let store: SymposiumReviewStore;
const scope = {
  owner: 'owner',
  sessionId: 'session',
  workflowId: 'flow',
  artifactRevision: 'commit',
  artifactHash: 'b'.repeat(64),
};
const evidence = {
  version: 1 as const,
  evidenceId: 'check',
  resultId: 'result',
  criterion: 'works',
  artifactRevision: 'commit',
  verdict: 'verified' as const,
  evidenceRefs: ['test:1'],
  checkedAt: 1,
};
function verified() {
  const seat = (id: string) => ({
    seatId: id,
    role: id,
    selectionId: id,
    policyRevision: 'p',
    profileId: id,
    profileRevision: 1,
    accountId: id,
    model: 'mock',
  });
  store.create({
    workflowId: 'flow',
    owner: 'owner',
    sessionId: 'session',
    implementation: {
      version: 1,
      resultId: 'result',
      attemptId: 'build',
      inputRevision: 'input',
      inputHash: 'a'.repeat(64),
      artifactRevision: 'commit',
      artifactHash: scope.artifactHash,
      summary: 'Implemented',
      evidenceRefs: ['commit'],
      completedAt: 1,
    },
    implementer: seat('coder'),
    reviewer: seat('reviewer'),
    acceptanceCriteria: ['works'],
    limits: { maxReviewRounds: 3, maxTokens: 100, maxCostUsd: 1 },
  });
  store.admitAttempt({
    workflowId: 'flow',
    attemptId: 'review',
    enforcementId: 'cap',
    kind: 'review',
    actorSeatId: 'reviewer',
    artifactRevision: 'commit',
    artifactHash: scope.artifactHash,
    maxTokens: 10,
    maxCostUsd: 0.1,
  });
  store.recordReview({
    workflowId: 'flow',
    reviewId: 'review',
    reviewerSeatId: 'reviewer',
    kind: 'full',
    artifactRevision: 'commit',
    artifactHash: scope.artifactHash,
    findings: [],
    resolvedFingerprints: [],
    usage: { attemptId: 'review', tokens: 1, costUsd: 0.01 },
  });
  store.recordEvidence('flow', evidence, scope.artifactHash, 'host');
  expect(store.finalize('flow').kind).toBe('verified');
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'review-record-'));
  store = new SymposiumReviewStore(join(directory, 'db'));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
it('exports one canonical immutable snapshot durably and idempotently', () => {
  verified();
  const record = store.exportVerifiedRecord(scope);
  expect(record.recordId).toBe(`review-${record.contentHash}`);
  expect(record.snapshot).toMatchObject({
    version: 1,
    ...scope,
    historySequence: 5,
    workflow: { currentResultId: 'result', status: 'verified' },
  });
  expect(record.snapshot.history).toHaveLength(5);
  expect(store.exportVerifiedRecord(scope)).toEqual(record);
  store.close();
  store = new SymposiumReviewStore(join(directory, 'db'));
  expect(store.getReviewRecord('owner', 'session', record.recordId)).toEqual(record);
  expect(store.exportVerifiedRecord(scope)).toEqual(record);
});
it('scopes retrieval and export to owner/session and rejects a stale artifact', () => {
  verified();
  const record = store.exportVerifiedRecord(scope);
  expect(store.getReviewRecord('other', 'session', record.recordId)).toBeNull();
  expect(store.getReviewRecord('owner', 'other', record.recordId)).toBeNull();
  expect(() => store.exportVerifiedRecord({ ...scope, owner: 'other' })).toThrow();
  expect(() => store.exportVerifiedRecord({ ...scope, artifactHash: 'c'.repeat(64) })).toThrow();
});
it('keeps old snapshots unchanged when newly verified evidence adds history', () => {
  verified();
  const first = store.exportVerifiedRecord(scope);
  store.recordEvidence(
    'flow',
    { ...evidence, evidenceId: 'check2', checkedAt: 2 },
    scope.artifactHash,
    'host',
  );
  store.finalize('flow');
  const second = store.exportVerifiedRecord(scope);
  expect(second.recordId).not.toBe(first.recordId);
  expect(second.snapshot.historySequence).toBeGreaterThan(first.snapshot.historySequence);
  expect(store.getReviewRecord('owner', 'session', first.recordId)).toEqual(first);
});
it('detects payload tampering rather than returning an altered record', () => {
  verified();
  const record = store.exportVerifiedRecord(scope);
  const db = new Database(join(directory, 'db'));
  db.prepare('UPDATE symposium_review_records SET payload = ? WHERE record_id = ?').run(
    '{}',
    record.recordId,
  );
  db.close();
  expect(() => store.getReviewRecord('owner', 'session', record.recordId)).toThrow(/integrity/i);
});
