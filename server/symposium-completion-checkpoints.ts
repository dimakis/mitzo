import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  AccountBindingSchema,
  SymposiumProvenanceV2Schema,
  type SymposiumRecipientAttemptRecord,
} from '@mitzo/protocol';
import type { SymposiumSeatExecution } from './symposium-orchestrator.js';
import type { SymposiumNativeObservations } from './symposium-native-observations.js';
import { canonicalReviewJson } from './symposium-review-records.js';
const id = z
  .string()
  .min(1)
  .refine((v) => v.trim() === v && v.trim().length > 0);
const bytes = z
  .string()
  .refine((v) => Buffer.byteLength(v) <= 8 * 1024 * 1024 && Buffer.from(v).toString('utf8') === v);
const inputSchema = z
  .strictObject({
    version: z.literal(1),
    claimToken: id,
    sessionId: id,
    deliveryId: id,
    seatId: id,
    attemptId: z.number().int().positive(),
    dispatchSeq: z.number().int().nonnegative(),
    idempotencyKey: id,
    dispatchedContent: bytes,
    provenance: SymposiumProvenanceV2Schema,
    accountBinding: AccountBindingSchema,
  })
  .refine(
    (v) =>
      v.seatId === v.provenance.seatId &&
      v.accountBinding.profileRevision === v.provenance.accountProfileRevision &&
      canonicalReviewJson(v.accountBinding) === canonicalReviewJson(v.provenance.accountBinding),
    'Delivered input differs from immutable account or seat provenance',
  );
export type DeliveredInputCheckpoint = z.infer<typeof inputSchema>;
const completionSchema = z.strictObject({
  claimToken: id,
  providerThreadId: id,
  providerTurnId: id,
  output: bytes,
});
const digest = (domain: string, value: string) =>
  createHash('sha256')
    .update(domain + '\0')
    .update(value)
    .digest('hex');
/** Captures only immutable host-claimed delivered text/provenance, not provider context. */
export function captureDeliveredInput(
  record: SymposiumRecipientAttemptRecord | undefined,
  execution: SymposiumSeatExecution,
): DeliveredInputCheckpoint {
  if (
    !record ||
    record.status !== 'executing' ||
    record.claimToken !== execution.claimToken ||
    record.deliveryId !== execution.deliveryId ||
    record.seatId !== execution.seat.id ||
    record.idempotencyKey !== execution.idempotencyKey ||
    record.dispatchedContent !== execution.content ||
    canonicalReviewJson(record.provenance) !== canonicalReviewJson(execution.provenance)
  )
    throw new Error('Delivered input differs from immutable execution claim');
  return inputSchema.parse({
    version: 1,
    claimToken: record.claimToken,
    sessionId: execution.sessionId,
    deliveryId: record.deliveryId,
    seatId: record.seatId,
    attemptId: record.attemptId,
    dispatchSeq: record.dispatchSeq,
    idempotencyKey: record.idempotencyKey,
    dispatchedContent: record.dispatchedContent,
    provenance: record.provenance,
    accountBinding: execution.seat.accountBinding,
  });
}
export interface NativeCompletionCheckpoint {
  kind: 'native_completion_checkpoint';
  version: 1;
  input: DeliveredInputCheckpoint;
  deliveredInputHash: string;
  output: string;
  outputHash: string;
  providerThreadId: string;
  providerTurnId: string;
  recordedAt: number;
  valid: boolean;
}
/** Not WorkResult, ReviewReceipt, final usage, artifact identity or hard-cap proof. */
export class SymposiumCompletionCheckpoints {
  constructor(
    private db: Database.Database,
    private observations: SymposiumNativeObservations,
    private claim: (token: string) => { sessionId: string; state: string } | undefined,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS symposium_delivered_inputs (claim_token TEXT PRIMARY KEY, input_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS symposium_completion_checkpoints (claim_token TEXT PRIMARY KEY, checkpoint_json TEXT NOT NULL);`);
  }
  capture(value: DeliveredInputCheckpoint): void {
    const input = inputSchema.parse(value);
    const encoded = canonicalReviewJson(input);
    this.db
      .transaction(() => {
        const claim = this.claim(input.claimToken);
        if (!claim || claim.sessionId !== input.sessionId)
          throw new Error('Delivered input claim unavailable');
        const previous = this.readInput(input.claimToken);
        if (previous && canonicalReviewJson(previous) !== encoded)
          throw new Error('Delivered input identity changed');
        if (!previous && claim.state !== 'reserved')
          throw new Error('Delivered input claim is not dispatchable');
        this.db
          .prepare('INSERT OR IGNORE INTO symposium_delivered_inputs VALUES (?, ?)')
          .run(input.claimToken, encoded);
      })
      .immediate();
  }
  private readInput(token: string): DeliveredInputCheckpoint | undefined {
    const row = this.db
      .prepare('SELECT input_json FROM symposium_delivered_inputs WHERE claim_token=?')
      .get(token) as { input_json: string } | undefined;
    return row ? inputSchema.parse(JSON.parse(row.input_json)) : undefined;
  }
  private valid(input: DeliveredInputCheckpoint, thread: string, turn: string): boolean {
    const observation = this.observations.get(input.claimToken);
    const claim = this.claim(input.claimToken);
    return !!(
      claim?.state === 'confirmed' &&
      claim.sessionId === input.sessionId &&
      observation?.status === 'completed' &&
      !observation.terminalConflict &&
      observation.identity.sessionId === input.sessionId &&
      observation.identity.seatId === input.seatId &&
      observation.identity.providerThreadId === thread &&
      observation.identity.providerTurnId === turn &&
      canonicalReviewJson(observation.identity.provenance) ===
        canonicalReviewJson(input.provenance) &&
      canonicalReviewJson(observation.identity.accountBinding) ===
        canonicalReviewJson(input.accountBinding)
    );
  }
  complete(value: z.infer<typeof completionSchema>): NativeCompletionCheckpoint {
    const completed = completionSchema.parse(value);
    return this.db
      .transaction(() => {
        const input = this.readInput(completed.claimToken);
        if (!input || !this.valid(input, completed.providerThreadId, completed.providerTurnId))
          throw new Error('Native completion checkpoint lacks terminal or cleanup proof');
        const previous = this.get(completed.claimToken);
        if (previous) {
          if (
            previous.output !== completed.output ||
            previous.providerThreadId !== completed.providerThreadId ||
            previous.providerTurnId !== completed.providerTurnId
          )
            throw new Error('Native completion bytes changed');
          return previous;
        }
        const checkpoint: NativeCompletionCheckpoint = {
          kind: 'native_completion_checkpoint',
          version: 1,
          input,
          deliveredInputHash: digest('mitzo-delivered-input-v1', canonicalReviewJson(input)),
          output: completed.output,
          outputHash: digest('mitzo-native-output-v1', completed.output),
          providerThreadId: completed.providerThreadId,
          providerTurnId: completed.providerTurnId,
          recordedAt: Date.now(),
          valid: true,
        };
        const durable = { ...checkpoint, valid: undefined };
        this.db
          .prepare('INSERT INTO symposium_completion_checkpoints VALUES (?, ?)')
          .run(completed.claimToken, JSON.stringify(durable));
        return checkpoint;
      })
      .immediate();
  }
  /** Rechecks durable conflicts on every read, including conflicts received after commit. */
  get(token: string): NativeCompletionCheckpoint | undefined {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT checkpoint_json FROM symposium_completion_checkpoints WHERE claim_token=?')
        .get(token) as { checkpoint_json: string } | undefined;
      if (!row) return undefined;
      const checkpoint = JSON.parse(row.checkpoint_json) as NativeCompletionCheckpoint;
      return {
        ...checkpoint,
        valid: this.valid(checkpoint.input, checkpoint.providerThreadId, checkpoint.providerTurnId),
      };
    })();
  }
}
