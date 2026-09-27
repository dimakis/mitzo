import type Database from 'better-sqlite3';
import { z } from 'zod';
import { canonicalReviewJson } from './symposium-review-records.js';
import { parseUntrustedReviewOutput, ReviewOutputScopeSchema } from './symposium-review-output.js';
const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().nonnegative();
export const ReviewAttemptLinkSchema = z
  .strictObject({
    attemptId: id,
    workflowId: id,
    reservationAttemptId: id,
    enforcementId: id,
    owner: id,
    sessionId: id,
    seatId: id,
    accountId: id,
    model: id,
    profileId: id,
    profileRevision: id,
    membershipGeneration: revision,
    authorityRevision: revision,
    inputRevision: id,
    inputHash: hash,
    artifactRevision: id,
    artifactHash: hash,
    sourceSealId: id,
    nativeClaim: id,
    runtimeCapability: id,
    runtimeVersion: id,
    scope: ReviewOutputScopeSchema,
  })
  .refine(
    (value) => value.reservationAttemptId === value.attemptId,
    'Workflow reservation attempt differs from linkage',
  );
export type ReviewAttemptLink = z.infer<typeof ReviewAttemptLinkSchema>;
const nativeSchema = z.strictObject({ threadId: id, turnId: id });
type Native = z.infer<typeof nativeSchema>;
type Context = { owner: string; sessionId: string };
type Row = {
  link: string;
  state: 'linked' | 'dispatch_uncertain' | 'accepted';
  native: string | null;
  output: string | null;
  itemId: string | null;
  conflict: number;
};

/** Host-only pending evidence. No dispatch, budgets, terminal receipt or promotion API.
 * Caller supplies a stable private-custody DB and validates linkage against the existing
 * workflow reservation and fresh seat authority. enforcementId is a reference, not proof.
 */
export class SymposiumReviewAttemptStaging {
  constructor(
    private readonly db: Database.Database,
    private readonly validateCurrentLink: (link: ReviewAttemptLink) => void,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS symposium_review_attempt_staging (
      attempt_id TEXT PRIMARY KEY, native_claim TEXT NOT NULL UNIQUE,
      link TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('linked','dispatch_uncertain','accepted')),
      native TEXT UNIQUE, output TEXT, item_id TEXT, conflict INTEGER NOT NULL DEFAULT 0 CHECK(conflict IN (0,1))
    )`);
  }
  private row(context: Context, attemptId: string): Row {
    const row = this.db
      .prepare(
        'SELECT link,state,native,output,item_id AS itemId,conflict FROM symposium_review_attempt_staging WHERE attempt_id=?',
      )
      .get(attemptId) as Row | undefined;
    if (!row) throw new Error('Review attempt not found');
    const link = ReviewAttemptLinkSchema.parse(JSON.parse(row.link));
    if (link.owner !== context.owner || link.sessionId !== context.sessionId)
      throw new Error('Review attempt not found');
    return row;
  }
  link(input: ReviewAttemptLink): void {
    const link = ReviewAttemptLinkSchema.parse(input);
    const encoded = canonicalReviewJson(link);
    this.db
      .transaction(() => {
        this.validateCurrentLink(link);
        const existing = this.db
          .prepare('SELECT link FROM symposium_review_attempt_staging WHERE attempt_id=?')
          .get(link.attemptId) as { link: string } | undefined;
        if (existing) {
          if (existing.link !== encoded) throw new Error('Review attempt linkage conflict');
          return;
        }
        this.db
          .prepare(
            "INSERT INTO symposium_review_attempt_staging(attempt_id,native_claim,link,state) VALUES (?,?,?,'linked')",
          )
          .run(link.attemptId, link.nativeClaim, encoded);
      })
      .immediate();
  }
  /** Persist before dispatch; false is replay/ambiguity and never permission to resend. */
  markDispatchUncertain(context: Context, attemptId: string): boolean {
    return this.db
      .transaction(() => {
        const row = this.row(context, attemptId);
        this.validateCurrentLink(ReviewAttemptLinkSchema.parse(JSON.parse(row.link)));
        if (row.conflict || row.state !== 'linked') return false;
        return (
          this.db
            .prepare(
              "UPDATE symposium_review_attempt_staging SET state='dispatch_uncertain' WHERE attempt_id=? AND state='linked'",
            )
            .run(attemptId).changes === 1
        );
      })
      .immediate();
  }
  accept(context: Context, attemptId: string, nativeInput: Native): void {
    const native = canonicalReviewJson(nativeSchema.parse(nativeInput));
    const conflict = this.db
      .transaction(() => {
        const current = this.row(context, attemptId);
        this.validateCurrentLink(ReviewAttemptLinkSchema.parse(JSON.parse(current.link)));
        if (current.native && current.native !== native) {
          this.taint(attemptId);
          return true;
        }
        if (current.conflict || current.state === 'linked')
          throw new Error('Review attempt was not safely dispatched');
        if (current.native === native) return false;
        this.db
          .prepare(
            "UPDATE symposium_review_attempt_staging SET state='accepted',native=? WHERE attempt_id=? AND state='dispatch_uncertain'",
          )
          .run(native, attemptId);
        return false;
      })
      .immediate();
    if (conflict) throw new Error('Review native identity conflict');
  }

  stageOutput(
    context: Context,
    attemptId: string,
    nativeInput: Native,
    item: { itemId: string; final: true; truncated: false; text: string },
  ): void {
    const native = canonicalReviewJson(nativeSchema.parse(nativeInput));
    const row = this.row(context, attemptId);
    if (row.state !== 'accepted' || row.native !== native || row.conflict)
      throw new Error('Review output is not from accepted attempt');
    const link = ReviewAttemptLinkSchema.parse(JSON.parse(row.link));
    this.validateCurrentLink(link);
    id.parse(item.itemId);
    if (item.final !== true || item.truncated !== false) {
      this.taint(attemptId);
      throw new Error('Final complete review item required');
    }
    let output: string;
    try {
      output = parseUntrustedReviewOutput(item.text, link.scope).canonical;
    } catch {
      this.taint(attemptId);
      throw new Error('Invalid structured review output');
    }
    const conflict = this.db
      .transaction(() => {
        const current = this.row(context, attemptId);
        this.validateCurrentLink(ReviewAttemptLinkSchema.parse(JSON.parse(current.link)));
        if (current.conflict || current.native !== native)
          throw new Error('Review evidence changed');
        if (current.output !== null) {
          if (current.output !== output || current.itemId !== item.itemId) {
            this.taint(attemptId);
            return true;
          }
          return false;
        }
        this.db
          .prepare(
            'UPDATE symposium_review_attempt_staging SET output=?,item_id=? WHERE attempt_id=? AND output IS NULL',
          )
          .run(output, item.itemId, attemptId);
        return false;
      })
      .immediate();
    if (conflict) throw new Error('Review final output conflict');
  }

  private taint(attemptId: string) {
    this.db
      .prepare('UPDATE symposium_review_attempt_staging SET conflict=1 WHERE attempt_id=?')
      .run(attemptId);
  }
  pending(context: Context, attemptId: string) {
    const row = this.row(context, attemptId);
    const link = ReviewAttemptLinkSchema.parse(JSON.parse(row.link));
    this.validateCurrentLink(link);
    return {
      link,
      state: row.state,
      native: row.native ? nativeSchema.parse(JSON.parse(row.native)) : null,
      conflict: row.conflict === 1,
      trust: 'untrusted' as const,
      output:
        row.output && !row.conflict ? parseUntrustedReviewOutput(row.output, link.scope) : null,
      receipt: null,
      finalUsage: null,
      completedSeal: null,
    };
  }
}
