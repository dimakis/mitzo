import { canonicalReviewJson, reviewRecordHash } from './symposium-review-records.js';
import { ARTIFACT_REVIEW_MAX_PAGES } from './symposium-artifact-git-export.js';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OutcomeEvidenceSchema, WorkResultSchema } from '@mitzo/protocol';
import { resolveRoleExecution } from './model-routing-policy.js';

const Id = z.string().trim().min(1);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const SelectionSchema = z.strictObject({
  seatId: Id,
  role: Id,
  selectionId: Id,
  policyRevision: Id,
  profileId: Id,
  profileRevision: z.number().int().positive(),
  accountId: Id,
  model: Id,
});
const NativeLimitsSchema = z.strictObject({
  version: z.literal(1).optional(),
  mode: z.literal('native-hard-cap').optional(),
  maxReviewRounds: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  maxCostUsd: z.number().finite().nonnegative().nullable(),
});
export const ApplicationPolicySchema = z.strictObject({
  version: z.literal(1),
  mode: z.literal('application'),
  maxHostTurns: z.number().int().positive(),
  maxReviewCycles: z.number().int().positive(),
  deadlineAt: z.number().int().positive(),
  noProgressLimit: z.number().int().positive(),
});
export const ReviewLimitsSchema = z.union([NativeLimitsSchema, ApplicationPolicySchema]);
export type ApplicationPolicy = z.infer<typeof ApplicationPolicySchema>;
export const isApplicationPolicy = (
  limits: z.infer<typeof ReviewLimitsSchema>,
): limits is ApplicationPolicy => 'mode' in limits && limits.mode === 'application';
const ApplicationAttemptSchema = z.strictObject({
  workflowId: Id,
  attemptId: Id,
  policyReservationId: Id,
  kind: z.enum(['initial', 'review', 'fix', 'delta', 'retry']),
  actorSeatId: Id,
  artifactRevision: Id,
  artifactHash: Sha256,
  retryOfAttemptId: Id.optional(),
  retryAuthorizationId: Id.optional(),
  binding: z.strictObject({
    claimToken: Id,
    deliveryId: Id,
    contentHash: Sha256,
    membershipGeneration: z.number().int().positive(),
    configRevision: z.number().int().positive(),
    accountId: Id,
    model: Id,
    profileId: Id,
    profileRevision: Id,
    accountProfileRevision: Id,
    authorityGrant: z.strictObject({ grantId: Id, revision: z.number().int().positive() }),
    contextGrant: z.strictObject({ grantId: Id, revision: z.number().int().positive() }),
  }),
});
export type ApplicationAttempt = z.infer<typeof ApplicationAttemptSchema>;
const ApplicationPreparationBase = z.strictObject({
  workflowId: Id,
  attemptId: Id,
  policyReservationId: Id,
  actorSeatId: Id,
  artifactRevision: Id,
  artifactHash: Sha256,
  transitionId: Id,
  resumeEpoch: z.number().int().nonnegative().optional(),
  resumeReady: z.boolean().optional(),
  seal: z.strictObject({
    fenceId: Id,
    artifactGenerationId: Id,
    volumeName: Id,
    sealDigest: Sha256,
    artifactRevision: Id,
    artifactHash: Sha256,
  }),
  from: z.strictObject({
    configRevision: z.number().int().positive(),
    membershipGeneration: z.number().int().positive(),
  }),
  to: z.strictObject({
    configRevision: z.number().int().positive(),
    membershipGeneration: z.number().int().positive(),
  }),
  expectedSelection: z.strictObject({
    accountId: Id,
    model: Id,
    profileId: Id,
    profileRevision: Id,
    accountProfileRevision: Id,
  }),
});
const ApplicationPreparationSchema = z.union([
  ApplicationPreparationBase.extend({ kind: z.literal('initial'), sourceSealId: Id }),
  ApplicationPreparationBase.extend({ kind: z.enum(['review', 'delta', 'fix']) }),
]);
export type ApplicationPreparation = z.infer<typeof ApplicationPreparationSchema>;
type PersistedApplicationPreparation = ApplicationPreparation & {
  requestHash: string;
  status: 'preparing' | 'bound' | 'settled';
  disposition?: 'not_applied' | 'applied_no_dispatch';
  /** EventStore delivery-control epoch proved while the application was stopped. */
  resumeEpoch?: number;
  resumeReady?: boolean;
};
const CreateSchema = z.strictObject({
  workflowId: Id,
  owner: Id,
  sessionId: Id,
  implementation: WorkResultSchema,
  implementer: SelectionSchema,
  reviewer: SelectionSchema,
  acceptanceCriteria: z.array(Id).min(1),
  limits: ReviewLimitsSchema,
});
const CreateApplicationRunSchema = CreateSchema.omit({ implementation: true }).extend({
  initialArtifact: z.strictObject({ revision: Id, hash: Sha256 }),
  limits: ApplicationPolicySchema,
});
const InitialResultSchema = z.strictObject({
  workflowId: Id,
  result: WorkResultSchema,
  implementerSeatId: Id,
  policyReservationId: Id,
  operationId: Id,
  usage: z.strictObject({
    attemptId: Id,
    tokens: z.number().int().nonnegative().nullable(),
    costUsd: z.number().finite().nonnegative().nullable(),
  }),
});
const UsageSchema = z.strictObject({
  attemptId: Id,
  tokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().finite().nonnegative().nullable(),
});
const FindingInputSchema = z.strictObject({
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  criterion: Id,
  summary: Id,
  location: Id,
  evidenceRefs: z.array(Id).min(1),
});
const ReviewSchema = z.strictObject({
  workflowId: Id,
  reviewId: Id,
  reviewerSeatId: Id,
  kind: z.enum(['full', 'delta']),
  artifactRevision: Id,
  artifactHash: Sha256,
  findings: z.array(FindingInputSchema),
  resolvedFingerprints: z.array(Sha256),
  usage: UsageSchema,
  failure: Id.optional(),
});
const FixAuthorizationSchema = z.strictObject({
  workflowId: Id,
  artifactRevision: Id,
  artifactHash: Sha256,
  actor: Id,
  authorityGrantId: Id,
  authorityRevision: z.number().int().positive(),
  findingFingerprints: z.array(Sha256).min(1),
  reason: Id,
});
const ApplicationFixIntentSchema = z.strictObject({
  workflowId: Id,
  artifactRevision: Id,
  artifactHash: Sha256,
  actor: Id,
  authorizationId: Id,
  findingFingerprints: z.array(Sha256).min(1),
  reason: Id,
});
const FixSchema = z.strictObject({
  workflowId: Id,
  result: WorkResultSchema,
  implementerSeatId: Id,
  usage: UsageSchema,
});
const DismissalSchema = z.strictObject({
  workflowId: Id,
  fingerprint: Sha256,
  artifactRevision: Id,
  artifactHash: Sha256,
  actor: Id,
  reason: Id,
  evidenceRefs: z.array(Id).min(1),
});
const AttemptAdmissionSchema = z.strictObject({
  workflowId: Id,
  attemptId: Id,
  enforcementId: Id,
  kind: z.enum(['review', 'fix']),
  actorSeatId: Id,
  artifactRevision: Id,
  artifactHash: Sha256,
  maxTokens: z.number().int().positive(),
  maxCostUsd: z.number().finite().nonnegative().nullable(),
});

type Create = z.infer<typeof CreateSchema>;
type RoleAdmission = {
  seatId: string;
  selectionId: string;
  profileRevision: number;
  policyInput: Parameters<typeof resolveRoleExecution>[0];
};
type Review = z.infer<typeof ReviewSchema>;
type FixAuthorization = z.infer<typeof FixAuthorizationSchema>;
type ApplicationFixIntent = z.infer<typeof ApplicationFixIntentSchema>;
type Fix = z.infer<typeof FixSchema>;
type Evidence = z.infer<typeof OutcomeEvidenceSchema>;
type WorkResult = z.infer<typeof WorkResultSchema>;
type Usage = z.infer<typeof UsageSchema>;
type AttemptAdmission = z.infer<typeof AttemptAdmissionSchema>;
type Finding = {
  severity?: z.infer<typeof FindingInputSchema>['severity'];
  fingerprint: string;
  criterion: string;
  summary: string;
  location: string;
  evidenceRefs: string[];
  status: 'open' | 'fixed' | 'dismissed' | 'superseded';
  reviewIds: string[];
  disposition?: { actor: string; reason: string; evidenceRefs: string[] };
};
type WorkflowStatus =
  | 'awaiting_initial'
  | 'awaiting_review'
  | 'awaiting_fix'
  | 'awaiting_delta_review'
  | 'awaiting_evidence'
  | 'decision_required'
  | 'verified';
type DecisionCode =
  | 'rounds_exhausted'
  | 'token_budget_exhausted'
  | 'cost_budget_exhausted'
  | 'unknown_cost'
  | 'review_failed'
  | 'stale_review'
  | 'missing_evidence'
  | 'open_findings'
  | 'attempt_in_progress'
  | 'host_turns_exhausted'
  | 'cycles_exhausted'
  | 'deadline_exceeded'
  | 'user_stop'
  | 'no_progress'
  | 'attempt_already_dispatched';
type Workflow = Omit<Create, 'implementation'> & {
  implementation: WorkResult | null;
  initialArtifact?: { revision: string; hash: string };
  initialResultRequestHash?: string;
  hostTurns: number;
  reviewCycles: number;
  applicationPreparations: PersistedApplicationPreparation[];
  applicationAttempts: Array<
    ApplicationAttempt & {
      requestHash: string;
      effectiveKind?: 'initial' | 'review' | 'fix' | 'delta';
      dispatched: boolean;
      settled: boolean;
      operationId?: string;
      terminalOutcome?: 'completed' | 'cancelled' | 'failed';
    }
  >;
  policyResumeStatus?: WorkflowStatus;
  progressSignatures: string[];
  artifactRevision: string;
  artifactHash: string;
  currentResultId: string | null;
  status: WorkflowStatus;
  decisionCode?: DecisionCode;
  reviewRounds: number;
  tokensUsed: number;
  usageCompleteness: { tokens: 'complete' | 'partial'; cost: 'complete' | 'partial' };
  costUsd: number;
  attempts: Usage[];
  reservations: Array<AttemptAdmission & { requestHash: string; settled: boolean }>;
  fixes: Array<{ attemptId: string; requestHash: string }>;
  findings: Finding[];
  reviews: Array<{
    reviewId: string;
    kind: 'full' | 'delta';
    artifactRevision: string;
    artifactHash: string;
    requestHash: string;
  }>;
  authorizations: FixAuthorization[];
  applicationFixIntents: ApplicationFixIntent[];
  evidence: Array<{ item: Evidence; artifactHash: string; source: 'host' | 'model' }>;
};

export interface ImmutableReviewRecord {
  recordId: string;
  contentHash: string;
  createdAt: number;
  snapshot: {
    version: 1;
    owner: string;
    sessionId: string;
    workflowId: string;
    artifactRevision: string;
    artifactHash: string;
    historySequence: number;
    workflow: Workflow;
    history: Array<{ sequence: number; action: string; detail: unknown }>;
  };
}

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprint = (finding: z.infer<typeof FindingInputSchema>): string =>
  digest([
    finding.criterion.trim().toLowerCase(),
    finding.summary.trim().toLowerCase(),
    finding.location.trim().toLowerCase(),
  ]);

/** Workflow metadata only; conversation events remain in EventStore's tables. */
export class SymposiumReviewStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS symposium_review_workflows (
        workflow_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS symposium_review_records (
        record_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        session_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS symposium_review_events (
        workflow_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL,
        PRIMARY KEY (workflow_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS symposium_review_context_pages (
        workflow_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        page_index INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        seal_fence_id TEXT NOT NULL,
        evidence_sha256 TEXT NOT NULL,
        page_count INTEGER NOT NULL,
        context TEXT NOT NULL,
        receipt TEXT NOT NULL,
        accessed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (workflow_id, attempt_id, page_index)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Durable, immutable pages survive runtime restart. The transition has verified the
   * physical export before it calls this method; this enforces complete idempotence. */
  retainReviewPages(input: {
    sessionId: string;
    workflowId: string;
    attemptId: string;
    sealFenceId: string;
    evidenceSha256: string;
    pages: readonly {
      context: string;
      receipt: {
        contextSha256: string;
        pageIndex?: number;
        pageCount?: number;
        sealFenceId: string;
        artifactRevision: string;
        artifactHash: string;
      } & Record<string, unknown>;
    }[];
  }): void {
    // A same-operation physical replay may use a new short-lived helper. Bind
    // retained evidence to the stable sealed identity, not helper ID or time.
    const stableReceipt = (receipt: Record<string, unknown>) =>
      canonicalReviewJson({
        version: receipt.version,
        mode: receipt.mode,
        operationId: receipt.operationId,
        sealFenceId: receipt.sealFenceId,
        sealDigest: receipt.sealDigest,
        intentDigest: receipt.intentDigest,
        artifactRevision: receipt.artifactRevision,
        artifactHash: receipt.artifactHash,
        baseOid: receipt.baseOid,
        sourceOid: receipt.sourceOid,
        contextSha256: receipt.contextSha256,
        pageIndex: receipt.pageIndex,
        pageCount: receipt.pageCount,
        evidenceSha256: receipt.evidenceSha256,
        pagesSha256: receipt.pagesSha256,
      });
    const workflow = this.get(input.workflowId);
    const preparation = this.getApplicationPreparation(input.workflowId, input.attemptId);
    if (
      !workflow ||
      workflow.sessionId !== input.sessionId ||
      !preparation ||
      preparation.seal.fenceId !== input.sealFenceId ||
      preparation.artifactRevision !== workflow.artifactRevision ||
      preparation.artifactHash !== workflow.artifactHash ||
      input.pages.length < 1 ||
      input.pages.length > ARTIFACT_REVIEW_MAX_PAGES ||
      !/^[a-f0-9]{64}$/.test(input.evidenceSha256)
    )
      throw new Error('Exact prepared review pages required');
    this.db
      .transaction(() => {
        for (let index = 0; index < input.pages.length; index++) {
          const page = input.pages[index];
          if (
            page.receipt.pageIndex !== index ||
            page.receipt.pageCount !== input.pages.length ||
            page.receipt.sealFenceId !== input.sealFenceId ||
            page.receipt.artifactRevision !== preparation.artifactRevision ||
            page.receipt.artifactHash !== preparation.artifactHash ||
            page.receipt.contextSha256 !==
              createHash('sha256').update(page.context).digest('hex') ||
            (page.receipt as Record<string, unknown>).evidenceSha256 !== input.evidenceSha256
          )
            throw new Error('Inconsistent retained review page');
          const existing = this.db
            .prepare(
              `SELECT session_id, seal_fence_id, evidence_sha256, page_count, context, receipt
          FROM symposium_review_context_pages WHERE workflow_id=? AND attempt_id=? AND page_index=?`,
            )
            .get(input.workflowId, input.attemptId, index) as Record<string, unknown> | undefined;
          const receipt = canonicalReviewJson(page.receipt);
          if (existing) {
            if (
              existing.session_id !== input.sessionId ||
              existing.seal_fence_id !== input.sealFenceId ||
              existing.evidence_sha256 !== input.evidenceSha256 ||
              existing.page_count !== input.pages.length ||
              existing.context !== page.context ||
              stableReceipt(JSON.parse(existing.receipt as string) as Record<string, unknown>) !==
                stableReceipt(page.receipt)
            )
              throw new Error('Retained review page changed');
          } else {
            this.db
              .prepare(
                `INSERT INTO symposium_review_context_pages
            (workflow_id,attempt_id,page_index,session_id,seal_fence_id,evidence_sha256,page_count,context,receipt,accessed)
            VALUES(?,?,?,?,?,?,?,?,?,0)`,
              )
              .run(
                input.workflowId,
                input.attemptId,
                index,
                input.sessionId,
                input.sealFenceId,
                input.evidenceSha256,
                input.pages.length,
                page.context,
                receipt,
              );
          }
        }
        const count = this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM symposium_review_context_pages
        WHERE workflow_id=? AND attempt_id=?`,
          )
          .get(input.workflowId, input.attemptId) as { count: number };
        if (count.count !== input.pages.length) throw new Error('Retained review page set changed');
      })
      .immediate();
  }

  markReviewPromptPageDelivered(input: {
    sessionId: string;
    workflowId: string;
    attemptId: string;
    sealFenceId: string;
    contextSha256: string;
  }): void {
    const row = this.db
      .prepare(
        `SELECT context,receipt,page_count FROM symposium_review_context_pages
      WHERE workflow_id=? AND attempt_id=? AND session_id=? AND seal_fence_id=? AND page_index=0`,
      )
      .get(input.workflowId, input.attemptId, input.sessionId, input.sealFenceId) as
      { context: string; receipt: string; page_count: number } | undefined;
    if (
      !row ||
      createHash('sha256').update(row.context).digest('hex') !== input.contextSha256 ||
      (JSON.parse(row.receipt) as { contextSha256: string }).contextSha256 !== input.contextSha256
    )
      throw new Error('Exact staged review prompt page required');
    this.db
      .prepare(
        `UPDATE symposium_review_context_pages SET accessed=1
      WHERE workflow_id=? AND attempt_id=? AND page_index=0`,
      )
      .run(input.workflowId, input.attemptId);
  }

  readReviewPage(input: {
    sessionId: string;
    workflowId: string;
    attemptId: string;
    sealFenceId: string;
    pageIndex: number;
    claimToken: string;
    seatId: string;
    artifactRevision: string;
    artifactHash: string;
  }): { context: string; receipt: Record<string, unknown> } {
    if (
      !Number.isSafeInteger(input.pageIndex) ||
      input.pageIndex < 0 ||
      input.pageIndex >= ARTIFACT_REVIEW_MAX_PAGES
    )
      throw new Error('Review page index is out of bounds');
    return this.db
      .transaction(() => {
        const workflow = this.get(input.workflowId);
        const attempt = workflow?.applicationAttempts.find(
          (entry) => entry.attemptId === input.attemptId,
        );
        if (
          !workflow ||
          workflow.sessionId !== input.sessionId ||
          workflow.artifactRevision !== input.artifactRevision ||
          workflow.artifactHash !== input.artifactHash ||
          !attempt ||
          (attempt.kind !== 'review' && attempt.kind !== 'delta') ||
          attempt.binding.claimToken !== input.claimToken ||
          attempt.actorSeatId !== input.seatId ||
          attempt.settled ||
          !attempt.dispatched ||
          attempt.artifactRevision !== input.artifactRevision ||
          attempt.artifactHash !== input.artifactHash
        )
          throw new Error('Exact active review attempt required');
        const row = this.db
          .prepare(
            `SELECT context,receipt,page_count,evidence_sha256 FROM symposium_review_context_pages
        WHERE workflow_id=? AND attempt_id=? AND session_id=? AND seal_fence_id=? AND page_index=?`,
          )
          .get(
            input.workflowId,
            input.attemptId,
            input.sessionId,
            input.sealFenceId,
            input.pageIndex,
          ) as
          | { context: string; receipt: string; page_count: number; evidence_sha256: string }
          | undefined;
        if (!row || input.pageIndex >= row.page_count)
          throw new Error('Sealed review page unavailable');
        const receipt = JSON.parse(row.receipt) as Record<string, unknown>;
        if (
          receipt.pageIndex !== input.pageIndex ||
          receipt.pageCount !== row.page_count ||
          receipt.sealFenceId !== input.sealFenceId ||
          receipt.evidenceSha256 !== row.evidence_sha256 ||
          receipt.artifactRevision !== input.artifactRevision ||
          receipt.artifactHash !== input.artifactHash ||
          receipt.contextSha256 !== createHash('sha256').update(row.context).digest('hex')
        )
          throw new Error('Retained review page identity changed');
        return { context: row.context, receipt };
      })
      .immediate();
  }

  markReviewPageDelivered(input: {
    workflowId: string;
    attemptId: string;
    pageIndex: number;
    contextSha256: string;
  }): void {
    const result = this.db
      .prepare(
        `UPDATE symposium_review_context_pages SET accessed=1
         WHERE workflow_id=? AND attempt_id=? AND page_index=?
           AND json_extract(receipt, '$.contextSha256')=?`,
      )
      .run(input.workflowId, input.attemptId, input.pageIndex, input.contextSha256);
    if (result.changes !== 1) throw new Error('Exact review page delivery required');
  }

  hasCompleteReviewPageCoverage(workflowId: string, attemptId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count, MIN(page_count) AS pageCount,
      SUM(accessed) AS accessed FROM symposium_review_context_pages WHERE workflow_id=? AND attempt_id=?`,
      )
      .get(workflowId, attemptId) as {
      count: number;
      pageCount: number | null;
      accessed: number | null;
    };
    return row.count > 0 && row.count === row.pageCount && row.accessed === row.pageCount;
  }

  /** Read and persist one coherent verified state/history snapshot in a single transaction.
   * The coordinator supplies a synchronous final host assertion. Throwing rolls back
   * a new insertion, while previously committed historical records remain unchanged. */
  exportVerifiedRecord(
    input: {
      owner: string;
      sessionId: string;
      workflowId: string;
      artifactRevision: string;
      artifactHash: string;
    },
    assertCurrentArtifact?: () => void,
  ): ImmutableReviewRecord {
    return this.db
      .transaction(() => {
        const workflow = this.read(input.workflowId);
        if (workflow.owner !== input.owner || workflow.sessionId !== input.sessionId)
          throw new Error('Review workflow not found');
        if (
          workflow.status !== 'verified' ||
          workflow.decisionCode ||
          workflow.artifactRevision !== input.artifactRevision ||
          workflow.artifactHash !== input.artifactHash
        )
          throw new Error('A verified current artifact is required');
        const history = this.history(input.workflowId);
        const snapshot: ImmutableReviewRecord['snapshot'] = {
          version: 1,
          owner: workflow.owner,
          sessionId: workflow.sessionId,
          workflowId: workflow.workflowId,
          artifactRevision: workflow.artifactRevision,
          artifactHash: workflow.artifactHash,
          historySequence: history.at(-1)?.sequence ?? 0,
          workflow,
          history,
        };
        const payload = canonicalReviewJson(snapshot);
        const contentHash = reviewRecordHash(payload);
        const recordId = `review-${contentHash}`;
        this.db
          .prepare(
            `INSERT OR IGNORE INTO symposium_review_records
        (record_id, owner, session_id, workflow_id, payload, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            recordId,
            input.owner,
            input.sessionId,
            input.workflowId,
            payload,
            contentHash,
            Date.now(),
          );
        const record = this.getReviewRecord(input.owner, input.sessionId, recordId);
        if (!record) throw new Error('Review record integrity check failed');
        assertCurrentArtifact?.();
        return record;
      })
      .immediate();
  }

  /** Historical records remain readable without an active provider or mutable workflow. */
  getReviewRecord(
    owner: string,
    sessionId: string,
    recordId: string,
  ): ImmutableReviewRecord | null {
    if (!/^review-[a-f0-9]{64}$/.test(recordId)) return null;
    const row = this.db
      .prepare(
        `SELECT * FROM symposium_review_records
      WHERE record_id = ? AND owner = ? AND session_id = ?`,
      )
      .get(recordId, owner, sessionId) as
      | {
          record_id: string;
          owner: string;
          session_id: string;
          workflow_id: string;
          payload: string;
          content_hash: string;
          created_at: number;
        }
      | undefined;
    if (!row) return null;
    try {
      const snapshot = JSON.parse(row.payload) as ImmutableReviewRecord['snapshot'];
      if (
        reviewRecordHash(row.payload) !== row.content_hash ||
        recordId !== `review-${row.content_hash}` ||
        canonicalReviewJson(snapshot) !== row.payload ||
        snapshot.version !== 1 ||
        snapshot.owner !== owner ||
        snapshot.sessionId !== sessionId ||
        snapshot.workflowId !== row.workflow_id ||
        snapshot.workflow.owner !== owner ||
        snapshot.workflow.sessionId !== sessionId ||
        snapshot.workflow.workflowId !== snapshot.workflowId ||
        snapshot.workflow.status !== 'verified' ||
        snapshot.workflow.artifactRevision !== snapshot.artifactRevision ||
        snapshot.workflow.artifactHash !== snapshot.artifactHash ||
        snapshot.historySequence !== snapshot.history.at(-1)?.sequence
      )
        throw new Error('mismatch');
      return { recordId, contentHash: row.content_hash, createdAt: row.created_at, snapshot };
    } catch {
      throw new Error('Review record integrity check failed');
    }
  }

  private hydrate(state: Workflow): Workflow {
    state.applicationAttempts ??= [];
    state.applicationPreparations ??= [];
    state.applicationFixIntents ??= [];
    state.hostTurns ??= 0;
    state.reviewCycles ??= 0;
    state.progressSignatures ??= [];
    state.usageCompleteness ??= {
      tokens: state.attempts.some((a) => a.tokens === null) ? 'partial' : 'complete',
      cost: state.attempts.some((a) => a.costUsd === null) ? 'partial' : 'complete',
    };
    return state;
  }

  private read(workflowId: string): Workflow {
    const row = this.db
      .prepare('SELECT state FROM symposium_review_workflows WHERE workflow_id = ?')
      .get(Id.parse(workflowId)) as { state: string } | undefined;
    if (!row) throw new Error('Review workflow not found');
    return this.hydrate(JSON.parse(row.state) as Workflow);
  }

  get(workflowId: string): Workflow | null {
    const row = this.db
      .prepare('SELECT state FROM symposium_review_workflows WHERE workflow_id = ?')
      .get(Id.parse(workflowId)) as { state: string } | undefined;
    return row ? this.hydrate(JSON.parse(row.state) as Workflow) : null;
  }

  list(owner: string, sessionId: string): Workflow[] {
    const rows = this.db
      .prepare('SELECT state FROM symposium_review_workflows WHERE owner = ?')
      .all(owner) as Array<{ state: string }>;
    return rows
      .map((row) => JSON.parse(row.state) as Workflow)
      .filter((state) => state.sessionId === sessionId);
  }

  history(workflowId: string): Array<{ sequence: number; action: string; detail: unknown }> {
    this.read(workflowId);
    const rows = this.db
      .prepare(
        `SELECT sequence, action, detail FROM symposium_review_events
      WHERE workflow_id = ? ORDER BY sequence`,
      )
      .all(workflowId) as Array<{
      sequence: number;
      action: string;
      detail: string;
    }>;
    return rows.map((row) => ({
      sequence: row.sequence,
      action: row.action,
      detail: JSON.parse(row.detail) as unknown,
    }));
  }

  private write(state: Workflow, action: string, detail: unknown): Workflow {
    this.db
      .prepare('UPDATE symposium_review_workflows SET state = ? WHERE workflow_id = ?')
      .run(JSON.stringify(state), state.workflowId);
    const next = this.db
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next
      FROM symposium_review_events WHERE workflow_id = ?`,
      )
      .get(state.workflowId) as { next: number };
    this.db
      .prepare(
        `INSERT INTO symposium_review_events
      (workflow_id, sequence, action, detail) VALUES (?, ?, ?, ?)`,
      )
      .run(state.workflowId, next.next, action, JSON.stringify(detail));
    return state;
  }

  create(input: Create): Workflow {
    const parsed = CreateSchema.parse(input);
    return this.insertWorkflow(parsed);
  }

  createApplicationRun(input: z.infer<typeof CreateApplicationRunSchema>): Workflow {
    const parsed = CreateApplicationRunSchema.parse(input);
    return this.insertWorkflow({ ...parsed, implementation: null });
  }

  private insertWorkflow(
    parsed: Omit<Create, 'implementation'> & {
      implementation: WorkResult | null;
      initialArtifact?: { revision: string; hash: string };
    },
  ): Workflow {
    if (parsed.implementer.role !== 'coder')
      throw new Error('Implementer must be a coder selection');
    if (parsed.reviewer.role !== 'reviewer') throw new Error('Reviewer role is required');
    if (
      parsed.reviewer.seatId === parsed.implementer.seatId ||
      parsed.reviewer.selectionId === parsed.implementer.selectionId
    )
      throw new Error('Reviewer must be independently selected');
    if (new Set(parsed.acceptanceCriteria).size !== parsed.acceptanceCriteria.length)
      throw new Error('Acceptance criteria must be distinct');
    const state: Workflow = {
      ...parsed,
      artifactRevision: parsed.implementation?.artifactRevision ?? parsed.initialArtifact!.revision,
      artifactHash: parsed.implementation?.artifactHash ?? parsed.initialArtifact!.hash,
      currentResultId: parsed.implementation?.resultId ?? null,
      status: parsed.implementation ? 'awaiting_review' : 'awaiting_initial',
      reviewRounds: 0,
      hostTurns: 0,
      reviewCycles: 0,
      applicationAttempts: [],
      applicationPreparations: [],
      applicationFixIntents: [],
      progressSignatures: [],
      tokensUsed: 0,
      usageCompleteness: { tokens: 'complete', cost: 'complete' },
      costUsd: 0,
      attempts: [],
      reservations: [],
      fixes: [],
      findings: [],
      reviews: [],
      authorizations: [],
      evidence: [],
    };
    this.db
      .transaction(() => {
        if (
          isApplicationPolicy(parsed.limits) &&
          this.applicationWorkflowForSession(parsed.sessionId)
        )
          throw new Error('Session already has application policy');
        this.db
          .prepare(
            `INSERT INTO symposium_review_workflows
        (workflow_id, owner, state) VALUES (?, ?, ?)`,
          )
          .run(state.workflowId, state.owner, JSON.stringify(state));
        this.write(state, 'created', {
          resultId: state.currentResultId,
          artifactRevision: state.artifactRevision,
          artifactHash: state.artifactHash,
        });
      })
      .immediate();
    return state;
  }

  /** Resolve O1 policy at admission; persist only pins, never account credentials or grants. */
  createWithPolicies(
    input: Omit<Create, 'implementer' | 'reviewer'>,
    roles: { implementer: RoleAdmission; reviewer: RoleAdmission },
  ): Workflow {
    return this.create({ ...input, ...this.admitRoles(roles) });
  }

  createApplicationRunWithPolicies(
    input: Omit<z.infer<typeof CreateApplicationRunSchema>, 'implementer' | 'reviewer'>,
    roles: { implementer: RoleAdmission; reviewer: RoleAdmission },
  ): Workflow {
    return this.createApplicationRun({ ...input, ...this.admitRoles(roles) });
  }

  private admitRoles(roles: { implementer: RoleAdmission; reviewer: RoleAdmission }) {
    const admitted = (role: RoleAdmission): z.infer<typeof SelectionSchema> => {
      const decision = resolveRoleExecution(role.policyInput);
      if (decision.kind !== 'selected')
        throw new Error(`Role policy decision required: ${decision.code}`);
      const audit = decision.audit;
      if (audit.profileBinding.profileRevision !== String(role.profileRevision))
        throw new Error('Portable profile revision does not match role policy');
      return SelectionSchema.parse({
        seatId: role.seatId,
        role: audit.role,
        selectionId: role.selectionId,
        policyRevision: audit.policyRevision,
        profileId: audit.profileBinding.profileId,
        profileRevision: role.profileRevision,
        accountId: audit.actual.accountId,
        model: audit.actual.model,
      });
    };
    return { implementer: admitted(roles.implementer), reviewer: admitted(roles.reviewer) };
  }

  private requireArtifact(state: Workflow, revision: string, hash: string): void {
    if (state.artifactRevision !== revision || state.artifactHash !== hash)
      throw new Error('Stale artifact revision or hash');
  }

  /** Admission is checked before dispatch so an exhausted budget cannot launch another call. */
  admitAttempt(input: z.infer<typeof AttemptAdmissionSchema>):
    | { kind: 'admitted'; attemptId: string; maxTokens: number; maxCostUsd: number | null }
    | {
        kind: 'already_admitted' | 'already_settled';
        attemptId: string;
        maxTokens: number;
        maxCostUsd: number | null;
      }
    | { kind: 'decision_required'; code: DecisionCode } {
    const parsed = AttemptAdmissionSchema.parse(input);
    return this.db
      .transaction(() => {
        const state = this.read(parsed.workflowId);
        this.requireArtifact(state, parsed.artifactRevision, parsed.artifactHash);
        if (isApplicationPolicy(state.limits)) throw new Error('Application reservation required');
        const requestHash = digest(parsed);
        const existing = state.reservations.find((entry) => entry.attemptId === parsed.attemptId);
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw new Error('Attempt admission idempotency conflict');
          return {
            kind: existing.settled ? ('already_settled' as const) : ('already_admitted' as const),
            attemptId: parsed.attemptId,
            maxTokens: existing.maxTokens,
            maxCostUsd: existing.maxCostUsd,
          };
        }
        if (state.reservations.some((entry) => !entry.settled))
          return { kind: 'decision_required' as const, code: 'attempt_in_progress' as const };
        const stop = (code: DecisionCode) => {
          state.status = 'decision_required' as const;
          state.decisionCode = code;
          this.write(state, 'attempt_admission_denied', { ...parsed, code });
          return { kind: 'decision_required' as const, code };
        };
        if (state.decisionCode)
          return { kind: 'decision_required' as const, code: state.decisionCode };
        if (
          state.tokensUsed >= state.limits.maxTokens ||
          state.tokensUsed + parsed.maxTokens > state.limits.maxTokens
        )
          return stop('token_budget_exhausted');
        if (state.limits.maxCostUsd !== null && parsed.maxCostUsd === null)
          return stop('unknown_cost');
        if (
          state.limits.maxCostUsd !== null &&
          (state.costUsd >= state.limits.maxCostUsd ||
            (parsed.maxCostUsd !== null &&
              state.costUsd + parsed.maxCostUsd > state.limits.maxCostUsd))
        )
          return stop('cost_budget_exhausted');
        if (parsed.kind === 'review') {
          if (parsed.actorSeatId !== state.reviewer.seatId)
            throw new Error('Independently selected reviewer seat required');
          if (state.reviewRounds >= state.limits.maxReviewRounds) return stop('rounds_exhausted');
          if (state.status !== 'awaiting_review' && state.status !== 'awaiting_delta_review')
            throw new Error('Review admission is not due');
        } else {
          if (parsed.actorSeatId !== state.implementer.seatId)
            throw new Error('Controlled implementer selection required');
          if (state.status !== 'awaiting_fix') throw new Error('Fix admission is not due');
          this.requireFixAuthority(state);
        }
        if (state.attempts.some((attempt) => attempt.attemptId === parsed.attemptId))
          throw new Error('Attempt already accounted');
        state.reservations.push({ ...parsed, requestHash, settled: false });
        this.write(state, 'attempt_admitted', parsed);
        return {
          kind: 'admitted' as const,
          attemptId: parsed.attemptId,
          maxTokens: parsed.maxTokens,
          maxCostUsd: parsed.maxCostUsd,
        };
      })
      .immediate();
  }

  private applicationStop(state: Workflow, code: DecisionCode): void {
    state.policyResumeStatus ??= state.status;
    state.status = 'decision_required';
    state.decisionCode = code;
    for (const prep of state.applicationPreparations)
      if (prep.status === 'bound') prep.resumeReady = false;
    for (const attempt of state.applicationAttempts)
      if (
        !attempt.dispatched &&
        !state.applicationPreparations.some(
          (prep) => prep.attemptId === attempt.attemptId && prep.status === 'bound',
        )
      )
        attempt.settled = true;
    this.write(state, 'application_stopped', {
      code,
      preparations: state.applicationPreparations
        .filter((p) => p.status !== 'settled')
        .map((p) => ({
          attemptId: p.attemptId,
          transitionId: p.transitionId,
          sealDigest: p.seal.sealDigest,
        })),
      attempts: state.applicationAttempts
        .filter((a) => !a.settled)
        .map((a) => ({ attemptId: a.attemptId, operationId: a.operationId ?? null })),
    });
  }

  stopApplication(
    workflowId: string,
    actor: string,
    reason: 'user_stop' | 'deadline_exceeded' | 'no_progress',
  ): Workflow {
    return this.db
      .transaction(() => {
        const state = this.read(workflowId);
        if (state.owner !== actor || !isApplicationPolicy(state.limits))
          throw new Error('Application owner required');
        this.applicationStop(state, reason);
        return state;
      })
      .immediate();
  }

  continueApplication(input: {
    workflowId: string;
    actor: string;
    authorizationId: string;
    reason: string;
    limits: ApplicationPolicy;
  }): Workflow {
    const limits = ApplicationPolicySchema.parse(input.limits);
    Id.parse(input.authorizationId);
    Id.parse(input.reason);
    return this.db
      .transaction(() => {
        const state = this.read(input.workflowId);
        if (state.owner !== input.actor || !isApplicationPolicy(state.limits))
          throw new Error('Application owner required');
        if (state.status !== 'decision_required' || !state.decisionCode)
          throw new Error('Stopped application policy required for continuation');
        const pendingAttempts = state.applicationAttempts.filter((a) => !a.settled);
        const pendingPreparations = state.applicationPreparations.filter(
          (p) => p.status !== 'settled',
        );
        const resumable =
          pendingAttempts.length === 1 &&
          pendingPreparations.length === 1 &&
          (pendingPreparations[0].kind === 'initial' || pendingPreparations[0].kind === 'fix') &&
          pendingPreparations[0].status === 'bound' &&
          Number.isSafeInteger(pendingPreparations[0].resumeEpoch) &&
          (pendingPreparations[0].resumeEpoch ?? 0) > 0 &&
          pendingPreparations[0].resumeReady === true &&
          pendingAttempts[0].attemptId === pendingPreparations[0].attemptId &&
          pendingAttempts[0].policyReservationId === pendingPreparations[0].policyReservationId &&
          !pendingAttempts[0].dispatched;
        if ((pendingAttempts.length || pendingPreparations.length) && !resumable)
          throw new Error(
            'Reconcile unresolved application preparation or operations before continuation',
          );
        const activeWriterSuccessor = state.applicationPreparations.find(
          (p) =>
            (p.kind === 'initial' || p.kind === 'fix') &&
            p.status === 'settled' &&
            p.disposition === 'applied_no_dispatch',
        );
        if (activeWriterSuccessor)
          throw new Error(
            `Retire active ${activeWriterSuccessor.kind} successor before continuation`,
          );
        if (
          this.history(input.workflowId).some(
            (e) =>
              e.action === 'application_continued' &&
              (e.detail as { authorizationId: string }).authorizationId === input.authorizationId,
          )
        )
          throw new Error('Fresh continuation authorization required');
        if (
          limits.maxHostTurns <= state.hostTurns ||
          limits.maxReviewCycles < state.reviewCycles ||
          limits.deadlineAt <= Date.now()
        )
          throw new Error('Amended limits do not permit continuation');
        const previous = state.limits;
        state.limits = limits;
        state.status = state.policyResumeStatus ?? 'awaiting_review';
        delete state.policyResumeStatus;
        delete state.decisionCode;
        return this.write(state, 'application_continued', { ...input, previous });
      })
      .immediate();
  }

  reserveApplicationPreparation(
    input: ApplicationPreparation,
  ):
    | { kind: 'prepared' | 'already_prepared'; policyReservationId: string }
    | { kind: 'decision_required'; code: string } {
    const parsed = ApplicationPreparationSchema.parse(input);
    return this.db
      .transaction(() => {
        const state = this.read(parsed.workflowId);
        if (!isApplicationPolicy(state.limits)) throw new Error('Application policy required');
        this.requireArtifact(state, parsed.artifactRevision, parsed.artifactHash);
        if (
          parsed.seal.artifactRevision !== parsed.artifactRevision ||
          parsed.seal.artifactHash !== parsed.artifactHash ||
          (parsed.kind === 'initial' && parsed.sourceSealId !== parsed.seal.fenceId) ||
          parsed.to.configRevision <= parsed.from.configRevision ||
          parsed.to.membershipGeneration <= parsed.from.membershipGeneration
        )
          throw new Error('Exact sealed reader transition pins required');
        const prior = state.applicationPreparations.find(
          (p) =>
            p.attemptId === parsed.attemptId ||
            p.policyReservationId === parsed.policyReservationId ||
            p.transitionId === parsed.transitionId,
        );
        if (prior) {
          if (prior.requestHash !== digest(parsed))
            throw new Error('Application preparation idempotency conflict');
          return {
            kind: 'already_prepared' as const,
            policyReservationId: prior.policyReservationId,
          };
        }
        if (state.decisionCode)
          return { kind: 'decision_required' as const, code: state.decisionCode };
        if (Date.now() >= state.limits.deadlineAt) {
          this.applicationStop(state, 'deadline_exceeded');
          return { kind: 'decision_required' as const, code: 'deadline_exceeded' };
        }
        if (state.hostTurns >= state.limits.maxHostTurns) {
          this.applicationStop(state, 'host_turns_exhausted');
          return { kind: 'decision_required' as const, code: 'host_turns_exhausted' };
        }
        if (
          state.applicationAttempts.some((a) => !a.settled) ||
          state.applicationPreparations.some((p) => p.status === 'preparing')
        )
          return { kind: 'decision_required' as const, code: 'attempt_in_progress' };
        if (parsed.kind === 'initial') {
          if (state.status !== 'awaiting_initial' || state.implementation !== null)
            throw new Error('Initial preparation is not due');
          if (
            state.initialArtifact?.revision !== parsed.artifactRevision ||
            state.initialArtifact.hash !== parsed.artifactHash
          )
            throw new Error('Exact imported initial artifact required');
        } else if (parsed.kind === 'review') {
          if (state.status !== 'awaiting_review') throw new Error('Review preparation is not due');
          if (state.reviewCycles >= state.limits.maxReviewCycles) {
            this.applicationStop(state, 'cycles_exhausted');
            return { kind: 'decision_required' as const, code: 'cycles_exhausted' };
          }
          state.reviewCycles++;
        } else if (parsed.kind === 'delta') {
          if (state.status !== 'awaiting_delta_review')
            throw new Error('Delta preparation is not due');
        } else {
          if (state.status !== 'awaiting_fix') throw new Error('Fix preparation is not due');
          this.requireFixAuthority(state);
          const fixes =
            state.applicationAttempts.filter((a) => (a.effectiveKind ?? a.kind) === 'fix').length +
            state.applicationPreparations.filter((p) => p.kind === 'fix').length;
          if (fixes >= state.reviewCycles) {
            if (state.reviewCycles >= state.limits.maxReviewCycles) {
              this.applicationStop(state, 'cycles_exhausted');
              return { kind: 'decision_required' as const, code: 'cycles_exhausted' };
            }
            state.reviewCycles++;
          }
        }
        const selection =
          parsed.kind === 'review' || parsed.kind === 'delta' ? state.reviewer : state.implementer;
        if (
          parsed.actorSeatId !== selection.seatId ||
          parsed.expectedSelection.accountId !== selection.accountId ||
          parsed.expectedSelection.model !== selection.model ||
          parsed.expectedSelection.profileId !== selection.profileId ||
          parsed.expectedSelection.profileRevision !== String(selection.profileRevision)
        )
          throw new Error('Exact selected future role pins required');
        state.hostTurns++;
        state.applicationPreparations.push({
          ...parsed,
          requestHash: digest(parsed),
          status: 'preparing',
        });
        this.write(state, 'application_preparation_reserved', parsed);
        return { kind: 'prepared' as const, policyReservationId: parsed.policyReservationId };
      })
      .immediate();
  }

  getApplicationPreparation(
    workflowId: string,
    attemptId: string,
  ): PersistedApplicationPreparation | null {
    return (
      this.read(workflowId).applicationPreparations.find((p) => p.attemptId === attemptId) ?? null
    );
  }

  markStoppedBoundPreparationResumable(
    workflowId: string,
    attemptId: string,
    transitionId: string,
    nextEpoch: number,
  ): void {
    if (!Number.isSafeInteger(nextEpoch) || nextEpoch <= 0)
      throw new Error('Durable application delivery epoch required');
    this.db
      .transaction(() => {
        const state = this.read(workflowId);
        const prep = state.applicationPreparations.find(
          (p) => p.attemptId === attemptId && p.transitionId === transitionId,
        );
        const attempt = state.applicationAttempts.find(
          (a) => a.attemptId === attemptId && a.policyReservationId === prep?.policyReservationId,
        );
        if (
          !state.decisionCode ||
          !prep ||
          prep.status !== 'bound' ||
          (prep.kind !== 'initial' && prep.kind !== 'fix') ||
          !attempt ||
          attempt.dispatched ||
          attempt.settled ||
          nextEpoch !== (prep.resumeEpoch ?? 0) + 1
        )
          throw new Error('Exact stopped bound writer and fresh delivery epoch required');
        prep.resumeEpoch = nextEpoch;
        prep.resumeReady = true;
        this.write(state, 'application_bound_writer_resumable', {
          attemptId,
          transitionId,
          nextEpoch,
        });
      })
      .immediate();
  }

  completeApplicationPreparation(
    input: ApplicationAttempt,
    proof: { transitionId: string; sealDigest: string },
  ):
    | { kind: 'admitted'; policyReservationId: string }
    | { kind: 'decision_required'; code: string } {
    const parsed = ApplicationAttemptSchema.parse(input);
    Sha256.parse(proof.sealDigest);
    Id.parse(proof.transitionId);
    return this.db
      .transaction(() => {
        const state = this.read(parsed.workflowId);
        if (!isApplicationPolicy(state.limits)) throw new Error('Application policy required');
        const prep = state.applicationPreparations.find(
          (p) =>
            p.attemptId === parsed.attemptId &&
            p.policyReservationId === parsed.policyReservationId,
        );
        if (
          !prep ||
          prep.transitionId !== proof.transitionId ||
          prep.seal.sealDigest !== proof.sealDigest ||
          prep.status !== 'preparing'
        )
          throw new Error('Exact confirmed transition preparation required');
        this.requireArtifact(state, prep.artifactRevision, prep.artifactHash);
        if (state.decisionCode)
          return { kind: 'decision_required' as const, code: state.decisionCode };
        if (Date.now() >= state.limits.deadlineAt) {
          this.applicationStop(state, 'deadline_exceeded');
          return { kind: 'decision_required' as const, code: 'deadline_exceeded' };
        }
        if (
          parsed.kind !== prep.kind ||
          parsed.actorSeatId !== prep.actorSeatId ||
          parsed.artifactRevision !== prep.artifactRevision ||
          parsed.artifactHash !== prep.artifactHash ||
          parsed.binding.configRevision !== prep.to.configRevision ||
          parsed.binding.membershipGeneration !== prep.to.membershipGeneration ||
          parsed.binding.accountId !== prep.expectedSelection.accountId ||
          parsed.binding.model !== prep.expectedSelection.model ||
          parsed.binding.profileId !== prep.expectedSelection.profileId ||
          parsed.binding.profileRevision !== prep.expectedSelection.profileRevision ||
          parsed.binding.accountProfileRevision !== prep.expectedSelection.accountProfileRevision
        )
          throw new Error('Confirmed transition binding differs from preparation pins');
        if (
          state.applicationAttempts.some(
            (a) =>
              a.attemptId === parsed.attemptId ||
              a.policyReservationId === parsed.policyReservationId ||
              a.binding.claimToken === parsed.binding.claimToken,
          )
        )
          throw new Error('Application claim idempotency conflict');
        state.applicationAttempts.push({
          ...parsed,
          effectiveKind: parsed.kind,
          requestHash: digest(parsed),
          dispatched: false,
          settled: false,
        });
        prep.status = 'bound';
        this.write(state, 'application_preparation_bound', { proof, attempt: parsed });
        return { kind: 'admitted' as const, policyReservationId: parsed.policyReservationId };
      })
      .immediate();
  }

  settleApplicationPreparation(
    workflowId: string,
    attemptId: string,
    transitionId: string,
    disposition: 'not_applied' | 'applied_no_dispatch',
  ): void {
    this.db
      .transaction(() => {
        const state = this.read(workflowId);
        const prep = state.applicationPreparations.find(
          (p) => p.attemptId === attemptId && p.transitionId === transitionId,
        );
        if (!prep) throw new Error('Exact transition preparation required');
        if (prep.status === 'bound') {
          const attempt = state.applicationAttempts.find(
            (a) => a.attemptId === attemptId && a.policyReservationId === prep.policyReservationId,
          );
          if (
            disposition !== 'applied_no_dispatch' ||
            !state.decisionCode ||
            !attempt ||
            attempt.dispatched ||
            attempt.settled
          )
            throw new Error('Exact stopped bound no-dispatch proof required');
          attempt.settled = true;
        }
        if (prep.status === 'settled') {
          if (prep.disposition !== disposition) throw new Error('Preparation disposition conflict');
          return;
        }
        prep.status = 'settled';
        prep.disposition = disposition;
        this.write(state, 'application_preparation_settled', {
          attemptId,
          transitionId,
          disposition,
        });
      })
      .immediate();
  }

  reserveApplicationAttempt(
    input: ApplicationAttempt,
  ):
    | { kind: 'admitted'; policyReservationId: string }
    | { kind: 'decision_required'; code: string } {
    const parsed = ApplicationAttemptSchema.parse(input);
    return this.db
      .transaction(() => {
        const state = this.read(parsed.workflowId);
        if (!isApplicationPolicy(state.limits)) throw new Error('Application policy required');
        this.requireArtifact(state, parsed.artifactRevision, parsed.artifactHash);
        const existing = state.applicationAttempts.find(
          (a) =>
            a.attemptId === parsed.attemptId ||
            a.policyReservationId === parsed.policyReservationId ||
            a.binding.claimToken === parsed.binding.claimToken,
        );
        if (existing) {
          if (existing.requestHash !== digest(parsed))
            throw new Error('Application reservation idempotency conflict');
          return { kind: 'decision_required' as const, code: 'attempt_already_reserved' };
        }
        const stop = (code: DecisionCode) => {
          this.applicationStop(state, code);
          return { kind: 'decision_required' as const, code };
        };
        if (state.decisionCode)
          return { kind: 'decision_required' as const, code: state.decisionCode };
        if (Date.now() >= state.limits.deadlineAt) return stop('deadline_exceeded');
        if (state.hostTurns >= state.limits.maxHostTurns) return stop('host_turns_exhausted');
        if (
          state.applicationAttempts.some((a) => !a.settled) ||
          state.applicationPreparations.some((p) => p.status === 'preparing')
        )
          return { kind: 'decision_required' as const, code: 'attempt_in_progress' };
        const original = parsed.retryOfAttemptId
          ? state.applicationAttempts.find((a) => a.attemptId === parsed.retryOfAttemptId)
          : undefined;
        if (
          parsed.kind === 'retry' &&
          (!parsed.retryAuthorizationId ||
            !original?.settled ||
            !original.operationId ||
            !original.terminalOutcome ||
            original.terminalOutcome === 'completed')
        )
          throw new Error('Explicit retry requires reconciled failed/cancelled original operation');
        if (
          parsed.kind === 'retry' &&
          state.applicationAttempts.some(
            (a) => a.retryAuthorizationId === parsed.retryAuthorizationId,
          )
        )
          throw new Error('Fresh retry authorization required');
        const selectedKind =
          parsed.kind === 'retry' ? (original!.effectiveKind ?? original!.kind) : parsed.kind;
        if (selectedKind === 'retry') throw new Error('Original retry kind is unresolved');
        const selection =
          selectedKind === 'review' || selectedKind === 'delta'
            ? state.reviewer
            : state.implementer;
        if (
          selection.seatId !== parsed.actorSeatId ||
          selection.accountId !== parsed.binding.accountId ||
          selection.model !== parsed.binding.model ||
          selection.profileId !== parsed.binding.profileId
        )
          throw new Error('Exact selected seat binding required');
        if (selectedKind === 'review') {
          if (state.status !== 'awaiting_review') throw new Error('Review is not due');
          if (state.reviewCycles >= state.limits.maxReviewCycles) return stop('cycles_exhausted');
          state.reviewCycles++;
        } else if (selectedKind === 'delta') {
          if (state.status !== 'awaiting_delta_review') throw new Error('Delta is not due');
        } else if (selectedKind === 'fix') {
          if (state.status !== 'awaiting_fix') throw new Error('Fix is not due');
          if (
            state.applicationAttempts.filter((a) => (a.effectiveKind ?? a.kind) === 'fix').length >=
            state.reviewCycles
          ) {
            if (state.reviewCycles >= state.limits.maxReviewCycles) return stop('cycles_exhausted');
            state.reviewCycles++;
          }
          this.requireFixAuthority(state);
        }
        if (
          selectedKind === 'initial' &&
          (state.status !== 'awaiting_initial' ||
            state.implementation !== null ||
            (parsed.kind !== 'retry' &&
              state.applicationAttempts.some(
                (a) => (a.effectiveKind ?? a.kind) === 'initial' && (a.dispatched || !a.settled),
              )))
        )
          throw new Error('Initial dispatch is not due');
        state.hostTurns++;
        state.applicationAttempts.push({
          ...parsed,
          effectiveKind: selectedKind,
          requestHash: digest(parsed),
          dispatched: false,
          settled: false,
        });
        this.write(state, 'application_attempt_reserved', parsed);
        return { kind: 'admitted' as const, policyReservationId: parsed.policyReservationId };
      })
      .immediate();
  }

  applicationAttemptForClaim(claimToken: string): ApplicationAttempt | null {
    const rows = this.db.prepare('SELECT state FROM symposium_review_workflows').all() as Array<{
      state: string;
    }>;
    const matches = rows
      .flatMap((row) => (JSON.parse(row.state) as Workflow).applicationAttempts ?? [])
      .filter((a) => a.binding.claimToken === claimToken);
    if (matches.length > 1) throw new Error('Ambiguous application claim');
    if (!matches[0]) return null;
    const {
      workflowId,
      attemptId,
      policyReservationId,
      kind,
      actorSeatId,
      artifactRevision,
      artifactHash,
      binding,
      retryOfAttemptId,
      retryAuthorizationId,
    } = matches[0];
    return {
      workflowId,
      attemptId,
      policyReservationId,
      kind,
      actorSeatId,
      artifactRevision,
      artifactHash,
      binding,
      ...(retryOfAttemptId ? { retryOfAttemptId } : {}),
      ...(retryAuthorizationId ? { retryAuthorizationId } : {}),
    };
  }

  applicationWorkflowForSession(sessionId: string): Workflow | null {
    const rows = this.db.prepare('SELECT state FROM symposium_review_workflows').all() as Array<{
      state: string;
    }>;
    return (
      rows
        .map((row) => this.hydrate(JSON.parse(row.state) as Workflow))
        .find((s) => s.sessionId === sessionId && isApplicationPolicy(s.limits)) ?? null
    );
  }

  assertApplicationDispatch(input: ApplicationAttempt): void {
    const parsed = ApplicationAttemptSchema.parse(input);
    const state = this.read(parsed.workflowId);
    if (!isApplicationPolicy(state.limits)) throw new Error('Application policy required');
    const attempt = state.applicationAttempts.find(
      (a) => a.policyReservationId === parsed.policyReservationId,
    );
    if (!attempt || attempt.requestHash !== digest(parsed) || attempt.settled)
      throw new Error('Exact live application reservation required');
    this.requireArtifact(state, parsed.artifactRevision, parsed.artifactHash);
    if (state.decisionCode) throw new Error(state.decisionCode);
    if (Date.now() >= state.limits.deadlineAt) {
      this.stopApplication(state.workflowId, state.owner, 'deadline_exceeded');
      throw new Error('deadline_exceeded');
    }
  }

  consumeApplicationDispatch(
    input: ApplicationAttempt,
  ):
    | { kind: 'dispatch_authorized'; policyReservationId: string }
    | { kind: 'decision_required'; code: string } {
    const parsed = ApplicationAttemptSchema.parse(input);
    return this.db
      .transaction(() => {
        const state = this.read(parsed.workflowId);
        if (!isApplicationPolicy(state.limits)) throw new Error('Application policy required');
        const attempt = state.applicationAttempts.find(
          (a) => a.policyReservationId === parsed.policyReservationId,
        );
        if (!attempt || attempt.requestHash !== digest(parsed))
          throw new Error('Exact application reservation required');
        this.requireArtifact(state, parsed.artifactRevision, parsed.artifactHash);
        if (state.decisionCode)
          return { kind: 'decision_required' as const, code: state.decisionCode };
        if (Date.now() >= state.limits.deadlineAt) {
          this.applicationStop(state, 'deadline_exceeded');
          return { kind: 'decision_required' as const, code: 'deadline_exceeded' };
        }
        if (attempt.dispatched || attempt.settled)
          return { kind: 'decision_required' as const, code: 'attempt_already_dispatched' };
        attempt.dispatched = true;
        this.write(state, 'application_dispatch_consumed', parsed);
        return {
          kind: 'dispatch_authorized' as const,
          policyReservationId: parsed.policyReservationId,
        };
      })
      .immediate();
  }

  bindApplicationOperation(workflowId: string, attemptId: string, operationId: string): void {
    Id.parse(operationId);
    this.db
      .transaction(() => {
        const state = this.read(workflowId);
        const attempt = state.applicationAttempts.find((a) => a.attemptId === attemptId);
        if (!attempt?.dispatched || (attempt.operationId && attempt.operationId !== operationId))
          throw new Error('Exact dispatched operation required');
        if (
          state.applicationAttempts.some(
            (a) => a.attemptId !== attemptId && a.operationId === operationId,
          )
        )
          throw new Error('Native operation already bound to another host turn');
        attempt.operationId = operationId;
        this.write(state, 'application_operation_bound', { attemptId, operationId });
      })
      .immediate();
  }

  settleApplicationExecution(
    workflowId: string,
    attemptId: string,
    operationId: string,
    outcome: 'completed' | 'cancelled' | 'failed',
  ): void {
    this.db
      .transaction(() => {
        const state = this.read(workflowId);
        const attempt = state.applicationAttempts.find((a) => a.attemptId === attemptId);
        if (!attempt?.dispatched || attempt.operationId !== operationId)
          throw new Error('Exact accepted operation required');
        if (attempt.terminalOutcome && attempt.terminalOutcome !== outcome)
          throw new Error('Terminal outcome conflict');
        attempt.terminalOutcome = outcome;
        if (outcome !== 'completed') attempt.settled = true;
        this.write(state, 'application_execution_terminal', { attemptId, operationId, outcome });
      })
      .immediate();
  }

  recordInitialResult(input: z.infer<typeof InitialResultSchema>): Workflow {
    const parsed = InitialResultSchema.parse(input);
    return this.db
      .transaction(() => {
        const state = this.read(parsed.workflowId);
        const requestHash = digest(parsed);
        if (state.initialResultRequestHash) {
          if (state.initialResultRequestHash !== requestHash)
            throw new Error('Initial result idempotency conflict');
          return state;
        }
        if (
          !isApplicationPolicy(state.limits) ||
          state.implementation !== null ||
          (state.status !== 'awaiting_initial' && state.policyResumeStatus !== 'awaiting_initial')
        )
          throw new Error('Initial result is not due');
        const attempt = state.applicationAttempts.find(
          (a) => a.attemptId === parsed.usage.attemptId,
        );
        if (
          !attempt ||
          (attempt.effectiveKind ?? attempt.kind) !== 'initial' ||
          attempt.policyReservationId !== parsed.policyReservationId ||
          attempt.operationId !== parsed.operationId ||
          attempt.actorSeatId !== parsed.implementerSeatId ||
          state.implementer.seatId !== parsed.implementerSeatId ||
          attempt.artifactRevision !== parsed.result.inputRevision ||
          attempt.artifactHash !== parsed.result.inputHash ||
          parsed.result.attemptId !== parsed.usage.attemptId
        )
          throw new Error('Exact initial reservation and operation required');
        this.requireArtifact(state, parsed.result.inputRevision, parsed.result.inputHash);
        this.charge(state, parsed.usage);
        state.implementation = parsed.result;
        state.initialResultRequestHash = requestHash;
        state.artifactRevision = parsed.result.artifactRevision;
        state.artifactHash = parsed.result.artifactHash;
        state.currentResultId = parsed.result.resultId;
        if (state.decisionCode) state.policyResumeStatus = 'awaiting_review';
        else state.status = 'awaiting_review';
        return this.write(state, 'initial_result_recorded', parsed);
      })
      .immediate();
  }

  private charge(state: Workflow, usage: Usage): void {
    if (state.attempts.some((attempt) => attempt.attemptId === usage.attemptId))
      throw new Error('Attempt already accounted');
    if (isApplicationPolicy(state.limits)) {
      const admitted = state.applicationAttempts.find((a) => a.attemptId === usage.attemptId);
      if (
        !admitted ||
        !admitted.dispatched ||
        admitted.settled ||
        !admitted.operationId ||
        admitted.terminalOutcome !== 'completed'
      )
        throw new Error('Dispatched application reservation required');
      admitted.settled = true;
      state.attempts.push(usage);
      if (usage.tokens !== null) state.tokensUsed += usage.tokens;
      else state.usageCompleteness.tokens = 'partial';
      if (usage.costUsd !== null) state.costUsd += usage.costUsd;
      else state.usageCompleteness.cost = 'partial';
      return;
    }
    if (usage.tokens === null) throw new Error('Native capped receipt requires final usage');
    const reservation = state.reservations.find((entry) => entry.attemptId === usage.attemptId);
    if (!reservation || reservation.settled)
      throw new Error('Pre-dispatch attempt reservation is required');
    state.attempts.push(usage);
    reservation.settled = true;
    if (
      usage.tokens > reservation.maxTokens ||
      (reservation.maxCostUsd !== null &&
        usage.costUsd !== null &&
        usage.costUsd > reservation.maxCostUsd)
    )
      state.decisionCode =
        usage.tokens > reservation.maxTokens ? 'token_budget_exhausted' : 'cost_budget_exhausted';
    state.tokensUsed += usage.tokens;
    if (state.tokensUsed > state.limits.maxTokens) state.decisionCode = 'token_budget_exhausted';
    if (usage.costUsd === null && state.limits.maxCostUsd !== null)
      state.decisionCode = 'unknown_cost';
    else if (usage.costUsd !== null) {
      state.costUsd += usage.costUsd;
      if (state.limits.maxCostUsd !== null && state.costUsd > state.limits.maxCostUsd)
        state.decisionCode = 'cost_budget_exhausted';
    }
    if (state.decisionCode) state.status = 'decision_required';
  }

  recordReview(input: Review): Workflow {
    const parsed = ReviewSchema.parse(input);
    return this.db
      .transaction(() => {
        const state = this.read(parsed.workflowId);
        this.requireArtifact(state, parsed.artifactRevision, parsed.artifactHash);
        const requestHash = digest(parsed);
        const prior = state.reviews.find((review) => review.reviewId === parsed.reviewId);
        if (prior) {
          if (prior.requestHash !== requestHash) throw new Error('Review idempotency conflict');
          return state;
        }
        if (
          (!isApplicationPolicy(state.limits) && state.status === 'decision_required') ||
          state.status === 'verified'
        )
          throw new Error('Review rounds or budget exhausted');
        if (parsed.reviewerSeatId !== state.reviewer.seatId)
          throw new Error('Independently selected reviewer seat required');
        if (
          parsed.kind === 'full' &&
          (state.policyResumeStatus ?? state.status) !== 'awaiting_review'
        )
          throw new Error('Full review is not due');
        if (
          parsed.kind === 'delta' &&
          (state.policyResumeStatus ?? state.status) !== 'awaiting_delta_review'
        )
          throw new Error('Delta review is not due');
        if (
          !isApplicationPolicy(state.limits) &&
          state.reviewRounds >= state.limits.maxReviewRounds
        )
          throw new Error('Review rounds exhausted');
        if (
          ![...state.reservations, ...state.applicationAttempts].some(
            (entry) =>
              !entry.settled &&
              entry.attemptId === parsed.usage.attemptId &&
              (entry.kind === 'review' ||
                entry.kind === 'delta' ||
                (entry.kind === 'retry' &&
                  (entry.effectiveKind === 'review' || entry.effectiveKind === 'delta'))) &&
              entry.actorSeatId === parsed.reviewerSeatId &&
              entry.artifactRevision === parsed.artifactRevision &&
              entry.artifactHash === parsed.artifactHash,
          )
        )
          throw new Error('Matching pre-dispatch review reservation is required');
        state.reviewRounds++;
        this.charge(state, parsed.usage);
        state.reviews.push({
          reviewId: parsed.reviewId,
          kind: parsed.kind,
          artifactRevision: parsed.artifactRevision,
          artifactHash: parsed.artifactHash,
          requestHash,
        });
        if (parsed.failure) {
          state.status = 'decision_required';
          state.decisionCode = 'review_failed';
        } else {
          for (const key of parsed.resolvedFingerprints) {
            const found = state.findings.find((item) => item.fingerprint === key);
            if (!found || found.status !== 'open')
              throw new Error('Unknown open finding disposition');
            found.status = 'fixed';
          }
          for (const candidate of parsed.findings) {
            if (!state.acceptanceCriteria.includes(candidate.criterion))
              throw new Error('Finding criterion is not in the acceptance contract');
            const key = fingerprint(candidate);
            const found = state.findings.find((item) => item.fingerprint === key);
            if (found) {
              found.status = 'open';
              // Missing severity means unreported, not a downgrade or an inferred default.
              if (candidate.severity !== undefined) found.severity = candidate.severity;
              found.reviewIds.push(parsed.reviewId);
              found.evidenceRefs = [...new Set([...found.evidenceRefs, ...candidate.evidenceRefs])];
            } else
              state.findings.push({
                ...candidate,
                fingerprint: key,
                status: 'open',
                reviewIds: [parsed.reviewId],
              });
          }
          if (state.decisionCode && isApplicationPolicy(state.limits))
            state.policyResumeStatus = state.findings.some((f) => f.status === 'open')
              ? 'awaiting_fix'
              : 'awaiting_evidence';
          if (!state.decisionCode) {
            const open = state.findings.some((item) => item.status === 'open');
            state.status = open ? 'awaiting_fix' : 'awaiting_evidence';
            if (
              open &&
              !isApplicationPolicy(state.limits) &&
              state.reviewRounds >= state.limits.maxReviewRounds
            ) {
              state.status = 'decision_required';
              state.decisionCode = 'rounds_exhausted';
            }
          }
        }
        if (isApplicationPolicy(state.limits) && !parsed.failure) {
          const signature = digest([
            state.artifactHash,
            state.findings
              .filter((f) => f.status === 'open')
              .map((f) => f.fingerprint)
              .sort(),
          ]);
          const previous = state.progressSignatures.at(-1);
          state.progressSignatures.push(signature);
          let repeated = 0;
          for (
            let i = state.progressSignatures.length - 2;
            i >= 0 && state.progressSignatures[i] === signature;
            i--
          )
            repeated++;
          if (
            previous === signature &&
            repeated >= state.limits.noProgressLimit &&
            state.findings.some((f) => f.status === 'open')
          )
            this.applicationStop(state, 'no_progress');
        }
        return this.write(state, 'review_recorded', parsed);
      })
      .immediate();
  }

  authorizeFix(input: FixAuthorization): Workflow {
    const parsed = FixAuthorizationSchema.parse(input);
    return this.db
      .transaction(() => {
        const state = this.read(parsed.workflowId);
        if (isApplicationPolicy(state.limits))
          throw new Error('Application fixes require an interactive fix intent');
        this.requireArtifact(state, parsed.artifactRevision, parsed.artifactHash);
        if (state.status !== 'awaiting_fix') throw new Error('Fix authority is not due');
        if (parsed.actor !== state.owner) throw new Error('Owner authority is required');
        for (const key of parsed.findingFingerprints)
          if (
            !state.findings.some(
              (finding) => finding.fingerprint === key && finding.status === 'open',
            )
          )
            throw new Error('Fix authority references an unknown open finding');
        state.authorizations.push(parsed);
        return this.write(state, 'fix_authorized', parsed);
      })
      .immediate();
  }

  authorizeApplicationFixIntent(input: ApplicationFixIntent): Workflow {
    const parsed = ApplicationFixIntentSchema.parse(input);
    return this.db
      .transaction(() => {
        const state = this.read(parsed.workflowId);
        if (!isApplicationPolicy(state.limits)) throw new Error('Application policy required');
        this.requireArtifact(state, parsed.artifactRevision, parsed.artifactHash);
        if (state.status !== 'awaiting_fix') throw new Error('Fix authority is not due');
        if (parsed.actor !== state.owner) throw new Error('Owner authority is required');
        const open = state.findings.filter((finding) => finding.status === 'open');
        if (
          parsed.findingFingerprints.length !== open.length ||
          new Set(parsed.findingFingerprints).size !== open.length ||
          open.some((finding) => !parsed.findingFingerprints.includes(finding.fingerprint))
        )
          throw new Error('Exact open finding scope required');
        const prior = state.applicationFixIntents.find(
          (intent) => intent.authorizationId === parsed.authorizationId,
        );
        if (prior) {
          if (digest(prior) !== digest(parsed)) throw new Error('Fix intent idempotency conflict');
          return state;
        }
        const matchingScope = state.applicationFixIntents.filter(
          (intent) =>
            intent.actor === parsed.actor &&
            intent.artifactRevision === parsed.artifactRevision &&
            intent.artifactHash === parsed.artifactHash &&
            intent.findingFingerprints.length === parsed.findingFingerprints.length &&
            intent.findingFingerprints.every((key) => parsed.findingFingerprints.includes(key)),
        );
        if (
          matchingScope.length > 1 ||
          (matchingScope[0] && matchingScope[0].reason !== parsed.reason)
        )
          throw new Error('Fix intent retry conflict');
        // The host can issue a new action ID after an HTTP response is lost. Keep
        // the original exact authorization so one fix scope has one transition.
        if (matchingScope.length === 1) return state;
        state.applicationFixIntents.push(parsed);
        return this.write(state, 'application_fix_intent_authorized', parsed);
      })
      .immediate();
  }

  dismissFinding(input: z.infer<typeof DismissalSchema>): Workflow {
    const parsed = DismissalSchema.parse(input);
    return this.db
      .transaction(() => {
        const state = this.read(parsed.workflowId);
        this.requireArtifact(state, parsed.artifactRevision, parsed.artifactHash);
        if (
          [...state.reservations, ...state.applicationAttempts].some(
            (attempt) => !attempt.settled,
          ) ||
          state.applicationPreparations.some((p) => p.status === 'preparing')
        )
          throw new Error('An attempt is in progress; wait before changing a finding disposition');
        if (state.status !== 'awaiting_fix') throw new Error('Finding disposition is not due');
        if (parsed.actor !== state.owner) throw new Error('Owner authority is required');
        const finding = state.findings.find(
          (item) => item.fingerprint === parsed.fingerprint && item.status === 'open',
        );
        if (!finding) throw new Error('Open finding not found');
        finding.status = 'dismissed';
        finding.disposition = {
          actor: parsed.actor,
          reason: parsed.reason,
          evidenceRefs: parsed.evidenceRefs,
        };
        if (!state.findings.some((item) => item.status === 'open'))
          state.status = 'awaiting_evidence';
        return this.write(state, 'finding_dismissed', parsed);
      })
      .immediate();
  }

  recordFix(input: Fix): Workflow {
    const parsed = FixSchema.parse(input);
    return this.db
      .transaction(() => {
        const state = this.read(parsed.workflowId);
        const requestHash = digest(parsed);
        const prior = state.fixes?.find((fix) => fix.attemptId === parsed.usage.attemptId);
        if (prior) {
          if (prior.requestHash !== requestHash) throw new Error('Fix idempotency conflict');
          return state;
        }
        if ((state.policyResumeStatus ?? state.status) !== 'awaiting_fix')
          throw new Error('Fix is not due');
        if (parsed.implementerSeatId !== state.implementer.seatId)
          throw new Error('Controlled implementer selection required');
        this.requireArtifact(state, parsed.result.inputRevision, parsed.result.inputHash);
        if (
          !isApplicationPolicy(state.limits) &&
          (parsed.result.artifactRevision === state.artifactRevision ||
            parsed.result.artifactHash === state.artifactHash)
        )
          throw new Error('Fix must produce a new artifact revision and hash');
        if (parsed.result.attemptId !== parsed.usage.attemptId)
          throw new Error('Fix result and usage attempt mismatch');
        if (
          ![...state.reservations, ...state.applicationAttempts].some(
            (entry) =>
              !entry.settled &&
              entry.attemptId === parsed.usage.attemptId &&
              (entry.kind === 'fix' || (entry.kind === 'retry' && entry.effectiveKind === 'fix')) &&
              entry.actorSeatId === parsed.implementerSeatId &&
              entry.artifactRevision === parsed.result.inputRevision &&
              entry.artifactHash === parsed.result.inputHash,
          )
        )
          throw new Error('Matching pre-dispatch fix reservation is required');
        this.requireFixAuthority(state);
        this.charge(state, parsed.usage);
        state.artifactRevision = parsed.result.artifactRevision;
        state.artifactHash = parsed.result.artifactHash;
        state.currentResultId = parsed.result.resultId;
        (state.fixes ??= []).push({ attemptId: parsed.usage.attemptId, requestHash });
        if (!state.decisionCode) state.status = 'awaiting_delta_review';
        else if (isApplicationPolicy(state.limits))
          state.policyResumeStatus = 'awaiting_delta_review';
        return this.write(state, 'fix_recorded', parsed);
      })
      .immediate();
  }

  private requireFixAuthority(state: Workflow): void {
    const authorized = new Set(
      state.authorizations
        .filter(
          (auth) =>
            !isApplicationPolicy(state.limits) &&
            auth.artifactRevision === state.artifactRevision &&
            auth.artifactHash === state.artifactHash &&
            auth.actor === state.owner,
        )
        .flatMap((auth) => auth.findingFingerprints),
    );
    if (isApplicationPolicy(state.limits)) {
      for (const intent of state.applicationFixIntents) {
        if (
          intent.artifactRevision === state.artifactRevision &&
          intent.artifactHash === state.artifactHash &&
          intent.actor === state.owner
        )
          for (const fingerprint of intent.findingFingerprints) authorized.add(fingerprint);
      }
    }
    if (state.findings.some((item) => item.status === 'open' && !authorized.has(item.fingerprint)))
      throw new Error('Fix authority is required for every open finding');
  }

  advanceArtifact(workflowId: string, result: WorkResult): Workflow {
    const parsed = WorkResultSchema.parse(result);
    return this.db
      .transaction(() => {
        const state = this.read(workflowId);
        if (state.implementation === null)
          throw new Error('Initial implementation must complete first');
        if (
          [...state.reservations, ...state.applicationAttempts].some(
            (reservation) => !reservation.settled,
          )
        )
          throw new Error('In-flight attempt must settle before advancing the artifact');
        this.requireArtifact(state, parsed.inputRevision, parsed.inputHash);
        if (
          parsed.artifactRevision === state.artifactRevision ||
          parsed.artifactHash === state.artifactHash
        )
          throw new Error('Artifact revision must change');
        state.artifactRevision = parsed.artifactRevision;
        state.artifactHash = parsed.artifactHash;
        state.currentResultId = parsed.resultId;
        for (const finding of state.findings)
          if (finding.status === 'open') finding.status = 'superseded';
        if (!state.decisionCode) state.status = 'awaiting_review';
        return this.write(state, 'artifact_advanced', parsed);
      })
      .immediate();
  }

  recordEvidence(
    workflowId: string,
    evidence: Evidence,
    artifactHash: string,
    source: 'host' | 'model',
  ): Workflow {
    const item = OutcomeEvidenceSchema.parse(evidence);
    Sha256.parse(artifactHash);
    return this.db
      .transaction(() => {
        const state = this.read(workflowId);
        this.requireArtifact(state, item.artifactRevision, artifactHash);
        if (!state.acceptanceCriteria.includes(item.criterion))
          throw new Error('Unknown acceptance criterion');
        if (item.resultId !== state.currentResultId)
          throw new Error('Evidence references a stale result');
        const prior = state.evidence.find((entry) => entry.item.evidenceId === item.evidenceId);
        if (prior) {
          if (digest(prior) !== digest({ item, artifactHash, source }))
            throw new Error('Evidence idempotency conflict');
          return state;
        }
        state.evidence.push({ item, artifactHash, source });
        if (state.status === 'verified') state.status = 'awaiting_evidence';
        return this.write(state, 'evidence_recorded', { item, artifactHash, source });
      })
      .immediate();
  }

  finalize(
    workflowId: string,
  ):
    | { kind: 'verified'; artifactRevision: string; artifactHash: string }
    | { kind: 'decision_required'; code: DecisionCode } {
    return this.db
      .transaction(() => {
        const state = this.read(workflowId);
        if (
          [...state.reservations, ...state.applicationAttempts].some((a) => !a.settled) ||
          state.applicationPreparations.some((p) => p.status === 'preparing')
        )
          return { kind: 'decision_required' as const, code: 'attempt_in_progress' as const };
        if (state.status === 'verified')
          return {
            kind: 'verified' as const,
            artifactRevision: state.artifactRevision,
            artifactHash: state.artifactHash,
          };
        if (state.decisionCode)
          return { kind: 'decision_required' as const, code: state.decisionCode };
        const currentReview = state.reviews.some(
          (review) =>
            review.artifactRevision === state.artifactRevision &&
            review.artifactHash === state.artifactHash,
        );
        if (!currentReview)
          return { kind: 'decision_required' as const, code: 'stale_review' as const };
        if (state.findings.some((finding) => finding.status === 'open'))
          return { kind: 'decision_required' as const, code: 'open_findings' as const };
        const verified = state.acceptanceCriteria.every((criterion) => {
          const current = state.evidence.filter(
            (entry) =>
              entry.source === 'host' &&
              entry.item.criterion === criterion &&
              entry.item.resultId === state.currentResultId &&
              entry.item.artifactRevision === state.artifactRevision &&
              entry.artifactHash === state.artifactHash,
          );
          const latest = current.at(-1);
          return latest?.item.verdict === 'verified' && latest.item.evidenceRefs.length > 0;
        });
        if (!verified)
          return { kind: 'decision_required' as const, code: 'missing_evidence' as const };
        state.status = 'verified';
        this.write(state, 'verified', {
          artifactRevision: state.artifactRevision,
          artifactHash: state.artifactHash,
        });
        return {
          kind: 'verified' as const,
          artifactRevision: state.artifactRevision,
          artifactHash: state.artifactHash,
        };
      })
      .immediate();
  }
}
