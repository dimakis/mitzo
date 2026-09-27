import { canonicalReviewJson, reviewRecordHash } from './symposium-review-records.js';
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
type Workflow = Create & {
  hostTurns: number;
  reviewCycles: number;
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
  currentResultId: string;
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
    `);
  }

  close(): void {
    this.db.close();
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
      artifactRevision: parsed.implementation.artifactRevision,
      artifactHash: parsed.implementation.artifactHash,
      currentResultId: parsed.implementation.resultId,
      status: 'awaiting_review',
      reviewRounds: 0,
      hostTurns: 0,
      reviewCycles: 0,
      applicationAttempts: [],
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
    return this.create({
      ...input,
      implementer: admitted(roles.implementer),
      reviewer: admitted(roles.reviewer),
    });
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
    for (const attempt of state.applicationAttempts)
      if (!attempt.dispatched) attempt.settled = true;
    this.write(state, 'application_stopped', {
      code,
      attempts: state.applicationAttempts
        .filter((a) => a.dispatched && !a.settled)
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
        if (state.applicationAttempts.some((a) => !a.settled))
          throw new Error('Reconcile unresolved operations before continuation');
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
        if (state.applicationAttempts.some((a) => !a.settled))
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
          (state.status !== 'awaiting_review' ||
            state.reviewCycles > 0 ||
            state.applicationAttempts.some((a) => (a.effectiveKind ?? a.kind) === 'initial'))
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
        if (outcome !== 'completed' || (attempt.effectiveKind ?? attempt.kind) === 'initial')
          attempt.settled = true;
        this.write(state, 'application_execution_terminal', { attemptId, operationId, outcome });
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

  dismissFinding(input: z.infer<typeof DismissalSchema>): Workflow {
    const parsed = DismissalSchema.parse(input);
    return this.db
      .transaction(() => {
        const state = this.read(parsed.workflowId);
        this.requireArtifact(state, parsed.artifactRevision, parsed.artifactHash);
        if (
          [...state.reservations, ...state.applicationAttempts].some((attempt) => !attempt.settled)
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
            auth.artifactRevision === state.artifactRevision &&
            auth.artifactHash === state.artifactHash &&
            auth.actor === state.owner,
        )
        .flatMap((auth) => auth.findingFingerprints),
    );
    if (state.findings.some((item) => item.status === 'open' && !authorized.has(item.fingerprint)))
      throw new Error('Fix authority is required for every open finding');
  }

  advanceArtifact(workflowId: string, result: WorkResult): Workflow {
    const parsed = WorkResultSchema.parse(result);
    return this.db
      .transaction(() => {
        const state = this.read(workflowId);
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
        if ([...state.reservations, ...state.applicationAttempts].some((a) => !a.settled))
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
