import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { WorkResultSchema } from '@mitzo/protocol';
import type { z } from 'zod';
import type { CompletedArtifactSeal } from './symposium-physical-artifact-seal.js';
import type { ReviewContext } from './symposium-review-coordinator.js';
import type { TrustedReviewCompletion } from './symposium-trusted-review-host.js';
import { canonicalReviewJson } from './symposium-review-records.js';

type Result = z.infer<typeof WorkResultSchema>;
type Completion = Pick<TrustedReviewCompletion, 'attempt' | 'execution' | 'observation'>;
type SealIntent = {
  fenceId: string;
  capturedAt: number;
  selection: {
    sessionId: string;
    artifact: { volumeGeneration: string };
  };
};
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalReviewJson(value)).digest('hex');
const operationId = (completion: Completion) =>
  canonicalReviewJson({
    thread: completion.observation.identity.providerThreadId,
    turn: completion.observation.identity.providerTurnId,
  });

/** Review results are derived only from a completed, physically verified owner seal.
 * The callback that initiates sealing must retain the actual session runtime and writer. */
export function createOwnedReviewArtifactResults(
  path: string,
  deps: {
    /** Parent owner must bind its retained writer claim and native operation to this seal. */
    sealCompleted(
      context: ReviewContext,
      completion: Completion,
    ): Promise<{
      seal: CompletedArtifactSeal;
      claimToken: string;
      operationId: string;
    }>;
    sealByFence(fenceId: string): Promise<CompletedArtifactSeal>;
    sealIntent(fenceId: string): SealIntent | null;
    volumeGeneration(sessionId: string): string | null;
  },
) {
  const db = new Database(path);
  db.pragma('journal_mode=WAL');
  db.pragma('synchronous=FULL');
  db.pragma('busy_timeout=5000');
  db.exec(`CREATE TABLE IF NOT EXISTS symposium_review_artifact_results (
    session_id TEXT NOT NULL, workflow_id TEXT NOT NULL, attempt_id TEXT PRIMARY KEY,
    claim_token TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL, fence_id TEXT NOT NULL UNIQUE,
    seal_digest TEXT NOT NULL, result_json TEXT NOT NULL, completed_at INTEGER NOT NULL
  )`);
  const read = (attemptId: string) =>
    db
      .prepare('SELECT * FROM symposium_review_artifact_results WHERE attempt_id=?')
      .get(attemptId) as Record<string, unknown> | undefined;
  const exact = (context: ReviewContext, completion: Completion) => {
    const { attempt, execution, observation } = completion;
    const identity = observation.identity;
    if (
      !['initial', 'fix'].includes(attempt.kind) ||
      observation.status !== 'completed' ||
      observation.terminalConflict ||
      observation.terminalAt === null ||
      execution.completedAt === null ||
      execution.status !== 'delivered' ||
      identity.sessionId !== context.sessionId ||
      identity.claimToken !== attempt.binding.claimToken ||
      identity.seatId !== attempt.actorSeatId ||
      identity.providerThreadId !== execution.providerThreadId ||
      identity.providerTurnId !== execution.providerTurnId ||
      execution.claimToken !== attempt.binding.claimToken ||
      execution.deliveryId !== attempt.binding.deliveryId ||
      execution.seatId !== attempt.actorSeatId
    )
      throw new Error('Completed review claim is not exact');
    return operationId(completion);
  };
  const result = (context: ReviewContext, completion: Completion): Result | null => {
    const op = exact(context, completion);
    const row = read(completion.attempt.attemptId);
    if (!row) return null;
    if (
      row.session_id !== context.sessionId ||
      row.workflow_id !== completion.attempt.workflowId ||
      row.claim_token !== completion.attempt.binding.claimToken ||
      row.operation_id !== op
    )
      throw new Error('Retained review artifact result identity changed');
    const value = WorkResultSchema.parse(JSON.parse(String(row.result_json)));
    if (
      value.inputRevision !== completion.attempt.artifactRevision ||
      value.inputHash !== completion.attempt.artifactHash ||
      value.attemptId !== completion.attempt.attemptId
    )
      throw new Error('Retained review artifact input changed');
    return value;
  };
  const currentOrNull = (context: ReviewContext) => {
    const row = db
      .prepare(
        'SELECT result_json FROM symposium_review_artifact_results WHERE session_id=? ORDER BY completed_at DESC, attempt_id DESC LIMIT 1',
      )
      .get(context.sessionId) as { result_json: string } | undefined;
    if (!row) return null;
    const value = WorkResultSchema.parse(JSON.parse(row.result_json));
    return { revision: value.artifactRevision, hash: value.artifactHash };
  };
  return {
    close: () => db.close(),
    currentOrNull,
    /** Only an immutable completed owner result may identify a retired reader's
     * historical input. Never select the latest artifact as a history substitute. */
    completedSourceResult(
      context: ReviewContext,
      input: {
        workflowId: string;
        artifactRevision: string;
        artifactHash: string;
        fenceId: string;
      },
    ): (Result & { sealDigest: string }) | null {
      const rows = db
        .prepare(
          `SELECT * FROM symposium_review_artifact_results
        WHERE session_id=? AND workflow_id=? AND fence_id=?
          AND json_extract(result_json,'$.artifactRevision')=?
          AND json_extract(result_json,'$.artifactHash')=?`,
        )
        .all(
          context.sessionId,
          input.workflowId,
          input.fenceId,
          input.artifactRevision,
          input.artifactHash,
        ) as Array<Record<string, unknown>>;
      if (rows.length > 1) throw new Error('Historical completed source is ambiguous');
      const row = rows[0];
      if (!row) return null;
      const value = WorkResultSchema.parse(JSON.parse(String(row.result_json)));
      const sealDigest = String(row.seal_digest);
      const expectedResultId = `review-result-${hash({
        sessionId: context.sessionId,
        attemptId: row.attempt_id,
        claimToken: row.claim_token,
        operationId: row.operation_id,
        fenceId: input.fenceId,
        sealDigest,
      })}`;
      if (
        !/^[a-f0-9]{64}$/.test(sealDigest) ||
        value.resultId !== expectedResultId ||
        value.attemptId !== row.attempt_id ||
        value.completedAt !== row.completed_at ||
        canonicalReviewJson(value.evidenceRefs) !==
          canonicalReviewJson([`artifact-seal:${input.fenceId}`])
      )
        throw new Error('Historical completed source binding changed');
      return { ...value, sealDigest };
    },
    currentResult(context: ReviewContext): Result | null {
      const row = db
        .prepare(
          'SELECT result_json FROM symposium_review_artifact_results WHERE session_id=? ORDER BY completed_at DESC, attempt_id DESC LIMIT 1',
        )
        .get(context.sessionId) as { result_json: string } | undefined;
      return row ? WorkResultSchema.parse(JSON.parse(row.result_json)) : null;
    },
    currentFence(context: ReviewContext, artifact: { revision: string; hash: string }) {
      const row = db
        .prepare(
          'SELECT fence_id, result_json FROM symposium_review_artifact_results WHERE session_id=? ORDER BY completed_at DESC, attempt_id DESC LIMIT 1',
        )
        .get(context.sessionId) as { fence_id: string; result_json: string } | undefined;
      if (!row) throw new Error('Current artifact seal unavailable');
      const result = WorkResultSchema.parse(JSON.parse(row.result_json));
      if (result.artifactRevision !== artifact.revision || result.artifactHash !== artifact.hash)
        throw new Error('Current artifact seal changed');
      return row.fence_id;
    },
    current(context: ReviewContext) {
      const current = currentOrNull(context);
      if (!current) throw new Error('No physically sealed review artifact is current');
      return current;
    },
    result,
    async refresh(context: ReviewContext, completion: Completion) {
      const op = exact(context, completion);
      const prior = result(context, completion);
      if (prior) return;
      const receipt = await deps.sealCompleted(context, completion);
      const { seal } = receipt;
      const verified = await deps.sealByFence(seal.fenceId);
      const intent = deps.sealIntent(seal.fenceId);
      if (
        canonicalReviewJson(verified) !== canonicalReviewJson(seal) ||
        receipt.claimToken !== completion.attempt.binding.claimToken ||
        receipt.operationId !== op ||
        !intent ||
        intent.fenceId !== seal.fenceId ||
        intent.selection.sessionId !== context.sessionId ||
        seal.sessionId !== context.sessionId ||
        intent.selection.artifact.volumeGeneration !== deps.volumeGeneration(context.sessionId) ||
        intent.capturedAt < completion.observation.terminalAt! ||
        seal.completedAt < intent.capturedAt
      )
        throw new Error('Physical artifact seal does not bind completed review operation');
      const value = WorkResultSchema.parse({
        version: 1,
        resultId: `review-result-${hash({
          sessionId: context.sessionId,
          attemptId: completion.attempt.attemptId,
          claimToken: completion.attempt.binding.claimToken,
          operationId: op,
          fenceId: seal.fenceId,
          sealDigest: hash(seal),
        })}`,
        attemptId: completion.attempt.attemptId,
        inputRevision: completion.attempt.artifactRevision,
        inputHash: completion.attempt.artifactHash,
        artifactRevision: seal.git.commit,
        artifactHash: seal.git.committedTreeDigest,
        summary: `Physically sealed Git commit ${seal.git.commit}`,
        evidenceRefs: [`artifact-seal:${seal.fenceId}`],
        completedAt: seal.completedAt,
      });
      db.transaction(() => {
        if (read(completion.attempt.attemptId))
          throw new Error('Review result changed during seal');
        db.prepare(
          `INSERT INTO symposium_review_artifact_results
          (session_id,workflow_id,attempt_id,claim_token,operation_id,fence_id,seal_digest,result_json,completed_at)
          VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(
          context.sessionId,
          completion.attempt.workflowId,
          completion.attempt.attemptId,
          completion.attempt.binding.claimToken,
          op,
          seal.fenceId,
          hash(seal),
          canonicalReviewJson(value),
          seal.completedAt,
        );
      }).immediate();
    },
  };
}
