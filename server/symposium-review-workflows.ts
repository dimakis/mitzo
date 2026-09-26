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
const LimitsSchema = z.strictObject({
  maxReviewRounds: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  maxCostUsd: z.number().finite().nonnegative().nullable(),
});
const CreateSchema = z.strictObject({
  workflowId: Id,
  owner: Id,
  sessionId: Id,
  implementation: WorkResultSchema,
  implementer: SelectionSchema,
  reviewer: SelectionSchema,
  acceptanceCriteria: z.array(Id).min(1),
  limits: LimitsSchema,
});
const UsageSchema = z.strictObject({
  attemptId: Id,
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative().nullable(),
});
const FindingInputSchema = z.strictObject({
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
  | 'attempt_in_progress';
type Workflow = Create & {
  artifactRevision: string;
  artifactHash: string;
  currentResultId: string;
  status: WorkflowStatus;
  decisionCode?: DecisionCode;
  reviewRounds: number;
  tokensUsed: number;
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

  private read(workflowId: string): Workflow {
    const row = this.db
      .prepare('SELECT state FROM symposium_review_workflows WHERE workflow_id = ?')
      .get(Id.parse(workflowId)) as { state: string } | undefined;
    if (!row) throw new Error('Review workflow not found');
    return JSON.parse(row.state) as Workflow;
  }

  get(workflowId: string): Workflow | null {
    const row = this.db
      .prepare('SELECT state FROM symposium_review_workflows WHERE workflow_id = ?')
      .get(Id.parse(workflowId)) as { state: string } | undefined;
    return row ? (JSON.parse(row.state) as Workflow) : null;
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
      tokensUsed: 0,
      costUsd: 0,
      attempts: [],
      reservations: [],
      fixes: [],
      findings: [],
      reviews: [],
      authorizations: [],
      evidence: [],
    };
    this.db.transaction(() => {
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
    })();
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
    return this.db.transaction(() => {
      const state = this.read(parsed.workflowId);
      this.requireArtifact(state, parsed.artifactRevision, parsed.artifactHash);
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
    })();
  }

  private charge(state: Workflow, usage: Usage): void {
    if (state.attempts.some((attempt) => attempt.attemptId === usage.attemptId))
      throw new Error('Attempt already accounted');
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
    return this.db.transaction(() => {
      const state = this.read(parsed.workflowId);
      this.requireArtifact(state, parsed.artifactRevision, parsed.artifactHash);
      const requestHash = digest(parsed);
      const prior = state.reviews.find((review) => review.reviewId === parsed.reviewId);
      if (prior) {
        if (prior.requestHash !== requestHash) throw new Error('Review idempotency conflict');
        return state;
      }
      if (state.status === 'decision_required' || state.status === 'verified')
        throw new Error('Review rounds or budget exhausted');
      if (parsed.reviewerSeatId !== state.reviewer.seatId)
        throw new Error('Independently selected reviewer seat required');
      if (parsed.kind === 'full' && state.status !== 'awaiting_review')
        throw new Error('Full review is not due');
      if (parsed.kind === 'delta' && state.status !== 'awaiting_delta_review')
        throw new Error('Delta review is not due');
      if (state.reviewRounds >= state.limits.maxReviewRounds)
        throw new Error('Review rounds exhausted');
      if (
        !state.reservations.some(
          (entry) =>
            !entry.settled &&
            entry.attemptId === parsed.usage.attemptId &&
            entry.kind === 'review' &&
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
        if (!state.decisionCode) {
          const open = state.findings.some((item) => item.status === 'open');
          state.status = open ? 'awaiting_fix' : 'awaiting_evidence';
          if (open && state.reviewRounds >= state.limits.maxReviewRounds) {
            state.status = 'decision_required';
            state.decisionCode = 'rounds_exhausted';
          }
        }
      }
      return this.write(state, 'review_recorded', parsed);
    })();
  }

  authorizeFix(input: FixAuthorization): Workflow {
    const parsed = FixAuthorizationSchema.parse(input);
    return this.db.transaction(() => {
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
    })();
  }

  dismissFinding(input: z.infer<typeof DismissalSchema>): Workflow {
    const parsed = DismissalSchema.parse(input);
    return this.db.transaction(() => {
      const state = this.read(parsed.workflowId);
      this.requireArtifact(state, parsed.artifactRevision, parsed.artifactHash);
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
    })();
  }

  recordFix(input: Fix): Workflow {
    const parsed = FixSchema.parse(input);
    return this.db.transaction(() => {
      const state = this.read(parsed.workflowId);
      const requestHash = digest(parsed);
      const prior = state.fixes?.find((fix) => fix.attemptId === parsed.usage.attemptId);
      if (prior) {
        if (prior.requestHash !== requestHash) throw new Error('Fix idempotency conflict');
        return state;
      }
      if (state.status !== 'awaiting_fix') throw new Error('Fix is not due');
      if (parsed.implementerSeatId !== state.implementer.seatId)
        throw new Error('Controlled implementer selection required');
      this.requireArtifact(state, parsed.result.inputRevision, parsed.result.inputHash);
      if (
        parsed.result.artifactRevision === state.artifactRevision ||
        parsed.result.artifactHash === state.artifactHash
      )
        throw new Error('Fix must produce a new artifact revision and hash');
      if (parsed.result.attemptId !== parsed.usage.attemptId)
        throw new Error('Fix result and usage attempt mismatch');
      if (
        !state.reservations.some(
          (entry) =>
            !entry.settled &&
            entry.attemptId === parsed.usage.attemptId &&
            entry.kind === 'fix' &&
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
      return this.write(state, 'fix_recorded', parsed);
    })();
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
    return this.db.transaction(() => {
      const state = this.read(workflowId);
      if (state.reservations.some((reservation) => !reservation.settled))
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
    })();
  }

  recordEvidence(
    workflowId: string,
    evidence: Evidence,
    artifactHash: string,
    source: 'host' | 'model',
  ): Workflow {
    const item = OutcomeEvidenceSchema.parse(evidence);
    Sha256.parse(artifactHash);
    return this.db.transaction(() => {
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
    })();
  }

  finalize(
    workflowId: string,
  ):
    | { kind: 'verified'; artifactRevision: string; artifactHash: string }
    | { kind: 'decision_required'; code: DecisionCode } {
    return this.db.transaction(() => {
      const state = this.read(workflowId);
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
    })();
  }
}
