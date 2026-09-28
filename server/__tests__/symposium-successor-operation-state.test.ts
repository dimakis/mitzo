import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectStoppedSuccessorOperation } from '../symposium-artifact-generations.js';
import { canonicalReviewJson } from '../symposium-review-records.js';

it('reads exact successor operation state without changing the ledger or treating uncertain copy as absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'stopped-successor-'));
  const path = join(root, 'artifact.db');
  const db = new Database(path);
  db.exec(
    'CREATE TABLE symposium_artifact_generations (session_id TEXT,operation_id TEXT,intent_json TEXT,state TEXT)',
  );
  const selected = {
    sessionId: 'session',
    transitionId: 'transition',
    workflowId: 'workflow',
    attemptId: 'attempt',
    kind: 'fix' as const,
  };
  try {
    expect(inspectStoppedSuccessorOperation(path, selected)).toBe('absent');
    const request = {
      sessionId: 'session',
      operationId: 'transition',
      workflowId: 'workflow',
      fixAttemptId: 'attempt',
      kind: 'fix',
    };
    db.prepare('INSERT INTO symposium_artifact_generations VALUES (?,?,?,?)').run(
      'session',
      canonicalReviewJson(['session', 'transition']),
      JSON.stringify({ request }),
      'reserved',
    );
    expect(inspectStoppedSuccessorOperation(path, selected)).toBe('reserved');
    db.prepare("UPDATE symposium_artifact_generations SET state='copy_uncertain'").run();
    expect(inspectStoppedSuccessorOperation(path, selected)).toBe('copy_uncertain');
    expect(
      inspectStoppedSuccessorOperation(path, { ...selected, attemptId: 'different' }),
    ).toBeNull();
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
