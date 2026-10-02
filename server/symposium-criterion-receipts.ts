import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OutcomeEvidenceSchema, WorkResultSchema } from '@mitzo/protocol';
import type { ReviewContext } from './symposium-review-coordinator.js';
import { canonicalReviewJson } from './symposium-review-records.js';

const Id = z.string().trim().min(1);
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const CheckPath = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/)
  .refine((value) => value.split('/').every((part) => !['.', '..', '.git'].includes(part)));
function boundedJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return Buffer.byteLength(value) <= 4096;
  if (Array.isArray(value))
    return value.length <= 256 && value.every((item) => boundedJson(item, depth + 1));
  if (
    typeof value !== 'object' ||
    !value ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 256 &&
    entries.every(
      ([key, item]) =>
        !['__proto__', 'constructor', 'prototype'].includes(key) && boundedJson(item, depth + 1),
    )
  );
}
const JsonCaseValue = z.unknown().refine((value) => {
  if (!boundedJson(value)) return false;
  return Buffer.byteLength(JSON.stringify(value)) <= 4096;
}, 'Bounded finite JSON required');
export const SemanticCriterionDefinitionSchema = z
  .strictObject({
    id: Id.max(128),
    criterion: Id.max(2048),
    version: z.literal(1),
    kind: z.literal('python-json-cases'),
    path: CheckPath,
    cases: z
      .array(z.strictObject({ id: Id.max(128), input: JsonCaseValue, expected: JsonCaseValue }))
      .min(1)
      .max(8),
  })
  .refine(
    (value) => new Set(value.cases.map((c) => c.id)).size === value.cases.length,
    'Duplicate semantic case',
  )
  .refine(
    (value) => Buffer.byteLength(canonicalReviewJson(value)) <= 65536,
    'Semantic definition byte bound',
  );
export const CriterionCheckDefinitionSchema = z.union([
  z.strictObject({
    id: Id,
    criterion: Id,
    version: z.literal(1),
    kind: z.literal('file-sha256'),
    path: CheckPath,
    expectedSha256: Sha,
  }),
  SemanticCriterionDefinitionSchema,
]);
export type SemanticCriterionDefinition = z.infer<typeof SemanticCriterionDefinitionSchema>;
const SemanticCaseReceiptSchema = z.strictObject({
  id: Id,
  status: z.enum(['passed', 'mismatch', 'malformed', 'overflow', 'nonzero', 'missing', 'timeout']),
  stdoutCapturedBytes: z.number().int().nonnegative().max(16384),
  stdoutCapturedSha256: Sha,
});
const FileExecution = z.strictObject({
  executionId: Id,
  sealFenceId: Id,
  sealDigest: Sha,
  definitionDigest: Sha,
  artifactRevision: Id,
  artifactHash: Sha,
  observedSha256: Sha.nullable(),
  completedAt: z.number().int().nonnegative(),
});
export const SemanticCriterionExecutionSchema = FileExecution.omit({ observedSha256: true }).extend(
  {
    kind: z.literal('python-json-cases'),
    cases: z.array(SemanticCaseReceiptSchema).min(1).max(8),
  },
);
const Execution = z.union([FileExecution, SemanticCriterionExecutionSchema]);
function semanticCoverage(definition: CheckDefinition, execution: CheckExecution): boolean {
  if (definition.kind === 'file-sha256') return 'observedSha256' in execution;
  return (
    'cases' in execution &&
    execution.cases.length === definition.cases.length &&
    execution.cases.every((c, i) => c.id === definition.cases[i].id)
  );
}
function executionVerified(definition: CheckDefinition, execution: CheckExecution): boolean {
  if (!semanticCoverage(definition, execution))
    throw new Error('Criterion semantic coverage changed');
  return definition.kind === 'file-sha256'
    ? 'observedSha256' in execution && execution.observedSha256 === definition.expectedSha256
    : 'cases' in execution && execution.cases.every((c) => c.status === 'passed');
}
export type CheckDefinition = z.infer<typeof CriterionCheckDefinitionSchema>;
type WorkResult = z.infer<typeof WorkResultSchema>;
type CheckExecution = z.infer<typeof Execution>;
type Evidence = z.infer<typeof OutcomeEvidenceSchema>;
type SealIdentity = {
  fenceId: string;
  sessionId: string;
  git: { commit: string; committedTreeDigest: string };
};
const digest = (value: unknown) =>
  createHash('sha256').update(canonicalReviewJson(value)).digest('hex');

/** Only code-owned definitions may run. The executor must be a credential-free,
 * physically fenced reader that returns observed bytes from the committed artifact.
 * A model assertion or request-provided callback does not satisfy this contract. */
export function createOwnedCriterionReceipts(
  path: string,
  deps: {
    definitions: readonly CheckDefinition[];
    currentResult(context: ReviewContext): WorkResult | null;
    currentGeneration(context: ReviewContext): string | null;
    requireSeal(
      fenceId: string,
    ): Promise<{ seal: SealIdentity; digest: string; generationId: string }>;
    execute(
      context: ReviewContext,
      result: WorkResult,
      definition: CheckDefinition,
      definitionDigest: string,
    ): Promise<CheckExecution>;
  },
) {
  const definitions = new Map<string, CheckDefinition>();
  for (const raw of deps.definitions) {
    const item = CriterionCheckDefinitionSchema.parse(raw);
    if (
      definitions.has(item.id) ||
      [...definitions.values()].some((d) => d.criterion === item.criterion)
    )
      throw new Error('Duplicate criterion check definition');
    definitions.set(item.id, item);
  }
  const db = new Database(path);
  db.pragma('journal_mode=WAL');
  db.pragma('synchronous=FULL');
  db.pragma('busy_timeout=5000');
  db.transaction(() =>
    db.exec(`CREATE TABLE IF NOT EXISTS symposium_criterion_receipts (
    evidence_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL, owner TEXT NOT NULL, definition_id TEXT NOT NULL,
    definition_digest TEXT NOT NULL, result_id TEXT NOT NULL,
    artifact_revision TEXT NOT NULL, artifact_hash TEXT NOT NULL,
    seal_fence_id TEXT NOT NULL, seal_digest TEXT NOT NULL, generation_id TEXT NOT NULL,
    execution_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
    receipt_digest TEXT NOT NULL
  );
  DROP INDEX IF EXISTS symposium_criterion_exact_check;
  CREATE UNIQUE INDEX IF NOT EXISTS symposium_criterion_exact_definition
    ON symposium_criterion_receipts(session_id,owner,result_id,definition_id,definition_digest)`),
  )();
  const byId = db.prepare('SELECT * FROM symposium_criterion_receipts WHERE evidence_id=?');
  const byCheck = db.prepare(`SELECT * FROM symposium_criterion_receipts
    WHERE session_id=? AND owner=? AND result_id=? AND definition_id=? AND definition_digest=?`);
  const receipt = (context: ReviewContext, row: Record<string, unknown>): Evidence | null => {
    const definition = definitions.get(String(row.definition_id));
    const current = deps.currentResult(context);
    if (
      !definition ||
      !current ||
      row.owner !== context.owner ||
      row.session_id !== context.sessionId ||
      row.definition_digest !== digest(definition) ||
      row.result_id !== current.resultId ||
      row.artifact_revision !== current.artifactRevision ||
      row.artifact_hash !== current.artifactHash
    )
      return null;
    const evidence = OutcomeEvidenceSchema.parse(JSON.parse(String(row.evidence_json)));
    const execution = Execution.parse(JSON.parse(String(row.execution_json)));
    const payload = {
      context,
      definition,
      result: current,
      execution,
      evidence,
      sealFenceId: row.seal_fence_id,
      sealDigest: row.seal_digest,
      generationId: row.generation_id,
    };
    if (
      !semanticCoverage(definition, execution) ||
      evidence.verdict !== (executionVerified(definition, execution) ? 'verified' : 'failed') ||
      row.receipt_digest !== digest(payload) ||
      row.evidence_id !== evidence.evidenceId ||
      row.execution_id !== execution.executionId ||
      evidence.resultId !== current.resultId ||
      evidence.criterion !== definition.criterion ||
      evidence.artifactRevision !== current.artifactRevision ||
      execution.artifactRevision !== current.artifactRevision ||
      execution.artifactHash !== current.artifactHash ||
      execution.definitionDigest !== digest(definition) ||
      execution.sealFenceId !== row.seal_fence_id ||
      execution.sealDigest !== row.seal_digest ||
      typeof row.generation_id !== 'string' ||
      !row.generation_id ||
      row.generation_id !== deps.currentGeneration(context) ||
      current.evidenceRefs.length !== 1 ||
      current.evidenceRefs[0] !== `artifact-seal:${row.seal_fence_id}`
    )
      return null;
    return evidence;
  };
  return {
    close: () => db.close(),
    evidence(context: ReviewContext, evidenceId: string): Evidence | null {
      const row = byId.get(evidenceId) as Record<string, unknown> | undefined;
      return row ? receipt(context, row) : null;
    },
    async run(context: ReviewContext, definitionId: string): Promise<Evidence> {
      const definition = definitions.get(definitionId);
      if (!definition) throw new Error('Trusted check definition unavailable');
      const result = deps.currentResult(context);
      if (!result) throw new Error('Current sealed result unavailable');
      WorkResultSchema.parse(result);
      if (result.evidenceRefs.length !== 1 || !result.evidenceRefs[0].startsWith('artifact-seal:'))
        throw new Error('Exact result seal unavailable');
      const definitionDigest = digest(definition);
      const prior = byCheck.get(
        context.sessionId,
        context.owner,
        result.resultId,
        definitionId,
        definitionDigest,
      ) as Record<string, unknown> | undefined;
      if (prior) {
        const retained = receipt(context, prior);
        if (!retained) throw new Error('Retained criterion receipt changed');
        return retained;
      }
      const fenceId = result.evidenceRefs[0].slice('artifact-seal:'.length);
      if (!fenceId) throw new Error('Exact result seal unavailable');
      const checkSeal = async () => {
        const { seal, digest: sealDigest, generationId } = await deps.requireSeal(fenceId);
        if (
          !Sha.safeParse(sealDigest).success ||
          seal.fenceId !== fenceId ||
          !generationId ||
          seal.sessionId !== context.sessionId ||
          seal.git.commit !== result.artifactRevision ||
          seal.git.committedTreeDigest !== result.artifactHash
        )
          throw new Error('Physical seal binding changed');
        return { sealDigest, generationId };
      };
      const { sealDigest, generationId } = await checkSeal();
      if (generationId !== deps.currentGeneration(context))
        throw new Error('Current artifact generation changed');
      const execution = Execution.parse(
        await deps.execute(context, result, definition, definitionDigest),
      );
      if (
        !semanticCoverage(definition, execution) ||
        execution.sealFenceId !== fenceId ||
        execution.sealDigest !== sealDigest ||
        execution.definitionDigest !== definitionDigest ||
        execution.artifactRevision !== result.artifactRevision ||
        execution.artifactHash !== result.artifactHash ||
        execution.completedAt < result.completedAt ||
        canonicalReviewJson(await checkSeal()) !==
          canonicalReviewJson({ sealDigest, generationId }) ||
        canonicalReviewJson(deps.currentResult(context)) !== canonicalReviewJson(result) ||
        deps.currentGeneration(context) !== generationId
      )
        throw new Error('Criterion execution binding changed');
      const evidence = OutcomeEvidenceSchema.parse({
        version: 1,
        evidenceId: `criterion-${digest({ context, resultId: result.resultId, definitionDigest, execution })}`,
        resultId: result.resultId,
        criterion: definition.criterion,
        verdict: executionVerified(definition, execution) ? 'verified' : 'failed',
        artifactRevision: result.artifactRevision,
        evidenceRefs: [`criterion-execution:${execution.executionId}:${digest(execution)}`],
        checkedAt: execution.completedAt,
      });
      const payload = {
        context,
        definition,
        result,
        execution,
        evidence,
        sealFenceId: fenceId,
        sealDigest,
        generationId,
      };
      db.prepare(
        `INSERT INTO symposium_criterion_receipts
        (evidence_id,execution_id,session_id,owner,definition_id,definition_digest,result_id,
         artifact_revision,artifact_hash,seal_fence_id,seal_digest,generation_id,execution_json,evidence_json,receipt_digest)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        evidence.evidenceId,
        execution.executionId,
        context.sessionId,
        context.owner,
        definition.id,
        definitionDigest,
        result.resultId,
        result.artifactRevision,
        result.artifactHash,
        fenceId,
        sealDigest,
        generationId,
        canonicalReviewJson(execution),
        canonicalReviewJson(evidence),
        digest(payload),
      );
      return evidence;
    },
  };
}
