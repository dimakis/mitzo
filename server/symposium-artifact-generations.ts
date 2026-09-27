import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalReviewJson, reviewRecordHash } from './symposium-review-records.js';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const identity = z.strictObject({ sessionId: id, workspace: id, custodyDigest: hash });
const initialSchema = identity.extend({
  generationId: id,
  volumeName: id,
  initializationReceiptDigest: hash,
});
const requestSchema = identity.extend({
  operationId: id,
  expectedPointerRevision: z.number().int().nonnegative(),
  parentGenerationId: id,
  parentSealDigest: hash,
  parentCommit: oid,
  parentTree: oid,
  parentManifestDigest: hash,
  parentCommittedTreeDigest: hash,
  bundleSha256: hash,
  exportReceiptDigest: hash,
  workflowId: id,
  fixAttemptId: id,
  actor: id,
  authorityGrantId: id,
  authorityRevision: z.number().int().positive(),
  seatId: id,
  membershipGeneration: z.number().int().positive(),
  accountId: id,
  model: id,
  profileId: id,
  profileRevision: id,
  findingFingerprints: z.array(hash).min(1).max(128),
  copierImageDigest: hash,
  copierCodeDigest: hash,
});
const intentSchema = z.strictObject({
  request: requestSchema,
  generationId: id,
  volumeName: id,
  helperName: id,
});
const receiptSchema = z.strictObject({
  intentDigest: hash,
  generationId: id,
  volumeName: id,
  helperName: id,
  helperId: id,
  initializationReceiptDigest: hash,
  exportReceiptDigest: hash,
  commit: oid,
  tree: oid,
  manifestDigest: hash,
  committedTreeDigest: hash,
  bundleSha256: hash,
  terminalExitCode: z.literal(0),
  helperRemoved: z.literal(true),
  verificationDigest: hash,
});
export type ArtifactGenerationRequest = z.infer<typeof requestSchema>;
export type ArtifactGenerationIntent = z.infer<typeof intentSchema>;
export type ArtifactGenerationCopyReceipt = z.infer<typeof receiptSchema>;
export type InitialArtifactGeneration = z.infer<typeof initialSchema>;
type Context = z.infer<typeof identity>;
function scope(value: Context) {
  return identity.parse({
    sessionId: value.sessionId,
    workspace: value.workspace,
    custodyDigest: value.custodyDigest,
  });
}
type State = 'initial' | 'reserved' | 'copy_uncertain' | 'quarantined' | 'verified' | 'active';
type Row = {
  generation_id: string;
  session_id: string;
  identity_json: string;
  operation_id: string | null;
  initial_json: string | null;
  intent_json: string | null;
  helper_id: string | null;
  receipt_json: string | null;
  state: State;
};

/** Dormant host ledger: no physical copy, lease, fence mutation or native dispatch.
 * Validators must synchronously verify retained trusted host records, never caller claims.
 * Use the same stable private-custody database for this ledger across host restarts.
 */
export class SymposiumArtifactGenerations {
  constructor(
    private readonly db: Database.Database,
    private readonly proof: {
      initial(value: InitialArtifactGeneration): true;
      authority(value: ArtifactGenerationRequest): true;
      parent(
        value: ArtifactGenerationIntent,
        parent: InitialArtifactGeneration | ArtifactGenerationIntent,
      ): true;
      copy(value: ArtifactGenerationIntent, receipt: ArtifactGenerationCopyReceipt): true;
    },
  ) {
    db.pragma('journal_mode=WAL');
    db.pragma('synchronous=FULL');
    db.pragma('busy_timeout=5000');
    if (Number(db.pragma('synchronous', { simple: true })) < 2)
      throw new Error('Durable generation ledger required');
    db.exec(`CREATE TABLE IF NOT EXISTS symposium_artifact_generations (
      generation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, identity_json TEXT NOT NULL,
      volume_name TEXT NOT NULL UNIQUE, operation_id TEXT UNIQUE, initial_json TEXT, intent_json TEXT,
      helper_id TEXT UNIQUE, receipt_json TEXT,
      state TEXT NOT NULL CHECK(state IN ('initial','reserved','copy_uncertain','quarantined','verified','active')));
      CREATE TABLE IF NOT EXISTS symposium_artifact_generation_heads (
      session_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS symposium_artifact_copy_observations (generation_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL);
    `);
    // The unique storage key includes the session; migrate earlier unscoped keys atomically.
    db.transaction(() => {
      const rows = db
        .prepare(
          'SELECT generation_id,intent_json FROM symposium_artifact_generations WHERE intent_json IS NOT NULL',
        )
        .all() as { generation_id: string; intent_json: string }[];
      for (const row of rows) {
        const intent = intentSchema.parse(JSON.parse(row.intent_json));
        db.prepare(
          'UPDATE symposium_artifact_generations SET operation_id=? WHERE generation_id=?',
        ).run(this.operationKey(intent.request), row.generation_id);
      }
    }).immediate();
  }
  private operationKey(request: ArtifactGenerationRequest) {
    return canonicalReviewJson([request.sessionId, request.operationId]);
  }
  private require(value: unknown) {
    if (value !== true) throw new Error('Affirmative synchronous generation proof required');
  }
  private get(context: Context, generationId: string): Row {
    const row = this.db
      .prepare('SELECT * FROM symposium_artifact_generations WHERE generation_id=?')
      .get(generationId) as Row | undefined;
    if (!row || row.identity_json !== canonicalReviewJson(scope(context)))
      throw new Error('Artifact generation not found in custody');
    return row;
  }
  private intent(row: Row): ArtifactGenerationIntent {
    if (!row.intent_json) throw new Error('Initial generation is not a copy operation');
    return intentSchema.parse(JSON.parse(row.intent_json));
  }
  private parent(intent: ArtifactGenerationIntent) {
    const row = this.get(intent.request, intent.request.parentGenerationId);
    this.require(
      this.proof.parent(
        intent,
        row.initial_json ? initialSchema.parse(JSON.parse(row.initial_json)) : this.intent(row),
      ),
    );
  }
  registerInitial(input: InitialArtifactGeneration): void {
    const value = initialSchema.parse(input);
    const encoded = canonicalReviewJson(value);
    this.db
      .transaction(() => {
        this.require(this.proof.initial(value));
        const previous = this.db
          .prepare('SELECT initial_json FROM symposium_artifact_generations WHERE generation_id=?')
          .get(value.generationId) as { initial_json: string | null } | undefined;
        if (previous) {
          if (previous.initial_json !== encoded)
            throw new Error('Initial generation identity conflict');
          return;
        }
        if (
          this.db
            .prepare('SELECT 1 FROM symposium_artifact_generation_heads WHERE session_id=?')
            .get(value.sessionId)
        )
          throw new Error('Initial generation already exists');
        this.db
          .prepare(
            "INSERT INTO symposium_artifact_generations(generation_id,session_id,identity_json,volume_name,initial_json,state) VALUES(?,?,?,?,?,'initial')",
          )
          .run(
            value.generationId,
            value.sessionId,
            canonicalReviewJson(scope(value)),
            value.volumeName,
            encoded,
          );
        this.db
          .prepare('INSERT INTO symposium_artifact_generation_heads VALUES(?,?,0)')
          .run(value.sessionId, value.generationId);
      })
      .immediate();
  }
  reserve(input: ArtifactGenerationRequest): ArtifactGenerationIntent {
    const request = requestSchema.parse(input);
    if (new Set(request.findingFingerprints).size !== request.findingFingerprints.length)
      throw new Error('Duplicate finding scope');
    return this.db
      .transaction(() => {
        this.require(this.proof.authority(request));
        const prior = this.db
          .prepare(
            'SELECT * FROM symposium_artifact_generations WHERE session_id=? AND operation_id=?',
          )
          .get(request.sessionId, this.operationKey(request)) as Row | undefined;
        if (prior) {
          const intent = this.intent(this.get(request, prior.generation_id));
          if (canonicalReviewJson(intent.request) !== canonicalReviewJson(request))
            throw new Error('Generation operation identity conflict');
          return intent;
        }
        const current = this.active(request);
        if (
          current.generationId !== request.parentGenerationId ||
          current.revision !== request.expectedPointerRevision
        )
          throw new Error('Generation parent pointer changed');
        const intent: ArtifactGenerationIntent = {
          request,
          generationId: randomUUID(),
          volumeName: `mitzo-artifacts-${randomUUID()}`,
          helperName: `mitzo-fork-${randomUUID()}`,
        };
        this.parent(intent);
        this.db
          .prepare(
            "INSERT INTO symposium_artifact_generations(generation_id,session_id,identity_json,volume_name,operation_id,intent_json,state) VALUES(?,?,?,?,?,?,'reserved')",
          )
          .run(
            intent.generationId,
            request.sessionId,
            canonicalReviewJson(scope(request)),
            intent.volumeName,
            this.operationKey(request),
            canonicalReviewJson(intent),
          );
        return intent;
      })
      .immediate();
  }
  /** Only true is the first durable claim; false never permits another copy dispatch. */
  claimCopy(context: Context, generationId: string): boolean {
    return this.db
      .transaction(() => {
        const row = this.get(context, generationId);
        const intent = this.intent(row);
        this.require(this.proof.authority(intent.request));
        this.parent(intent);
        if (row.state !== 'reserved') return false;
        const current = this.active(context);
        if (
          current.generationId !== intent.request.parentGenerationId ||
          current.revision !== intent.request.expectedPointerRevision
        )
          throw new Error('Generation parent pointer changed');
        return (
          this.db
            .prepare(
              "UPDATE symposium_artifact_generations SET state='copy_uncertain' WHERE generation_id=? AND state='reserved'",
            )
            .run(generationId).changes === 1
        );
      })
      .immediate();
  }
  bindHelper(context: Context, generationId: string, helperId: string): void {
    id.parse(helperId);
    this.db
      .transaction(() => {
        const row = this.get(context, generationId);
        this.intent(row); // Retain cleanup identity even if approval was revoked after dispatch.
        if (
          !['copy_uncertain', 'quarantined'].includes(row.state) ||
          (row.helper_id && row.helper_id !== helperId)
        )
          throw new Error('Copy helper identity changed or unavailable');
        this.db
          .prepare('UPDATE symposium_artifact_generations SET helper_id=? WHERE generation_id=?')
          .run(helperId, generationId);
      })
      .immediate();
  }
  quarantine(context: Context, generationId: string): void {
    this.db
      .transaction(() => {
        const row = this.get(context, generationId);
        if (!['reserved', 'copy_uncertain', 'quarantined'].includes(row.state))
          throw new Error('Cannot quarantine settled generation');
        const changed = this.db
          .prepare(
            "UPDATE symposium_artifact_generations SET state='quarantined' WHERE generation_id=? AND state IN ('reserved','copy_uncertain','quarantined')",
          )
          .run(generationId);
        if (changed.changes !== 1) throw new Error('Generation quarantine transition failed');
      })
      .immediate();
  }

  recordCopy(context: Context, generationId: string, input: ArtifactGenerationCopyReceipt): void {
    const receipt = receiptSchema.parse(input);
    const encoded = canonicalReviewJson(receipt);
    this.db
      .transaction(() => {
        const row = this.get(context, generationId);
        const intent = this.intent(row);

        if (row.receipt_json) {
          if (row.receipt_json !== encoded) throw new Error('Copy receipt conflict');
          return;
        }
        if (
          !['copy_uncertain', 'quarantined'].includes(row.state) ||
          row.helper_id !== receipt.helperId ||
          receipt.helperName !== intent.helperName ||
          receipt.generationId !== generationId ||
          receipt.volumeName !== intent.volumeName ||
          receipt.intentDigest !== reviewRecordHash(canonicalReviewJson(intent))
        )
          throw new Error('Copy terminal receipt does not match dispatched intent');
        const observed = this.db
          .prepare(
            'SELECT receipt_json FROM symposium_artifact_copy_observations WHERE generation_id=?',
          )
          .get(generationId) as { receipt_json: string } | undefined;
        if (observed && observed.receipt_json !== encoded)
          throw new Error('Copy terminal observation conflict');
        this.db
          .prepare('INSERT OR IGNORE INTO symposium_artifact_copy_observations VALUES(?,?)')
          .run(generationId, encoded);
      })
      .immediate();
    // Observation reaches durable storage before proof/custody checks can fail.
    this.db
      .transaction(() => {
        const row = this.get(context, generationId);
        const intent = this.intent(row);
        if (row.receipt_json) {
          if (row.receipt_json !== encoded) throw new Error('Copy receipt conflict');
          return;
        }
        if (row.state !== 'copy_uncertain') throw new Error('Copy is quarantined');
        this.require(this.proof.authority(intent.request));
        // A bound helper may report a failed import. Retain that observation,
        // but never promote mismatched lineage or replace its immutable evidence.
        if (
          receipt.exportReceiptDigest !== intent.request.exportReceiptDigest ||
          receipt.commit !== intent.request.parentCommit ||
          receipt.tree !== intent.request.parentTree ||
          receipt.manifestDigest !== intent.request.parentManifestDigest ||
          receipt.committedTreeDigest !== intent.request.parentCommittedTreeDigest ||
          receipt.bundleSha256 !== intent.request.bundleSha256
        )
          throw new Error('Copy terminal lineage differs from dispatched intent');
        this.parent(intent);
        this.require(this.proof.copy(intent, receipt));
        this.db
          .prepare(
            "UPDATE symposium_artifact_generations SET receipt_json=?,state='verified' WHERE generation_id=? AND state='copy_uncertain'",
          )
          .run(encoded, generationId);
      })
      .immediate();
  }
  activate(context: Context, generationId: string): { generationId: string; revision: number } {
    return this.db
      .transaction(() => {
        const row = this.get(context, generationId);
        const intent = this.intent(row);
        this.require(this.proof.authority(intent.request));
        this.parent(intent);
        if (!row.receipt_json || !['verified', 'active'].includes(row.state))
          throw new Error('Verified terminal copy receipt required');
        this.require(this.proof.copy(intent, receiptSchema.parse(JSON.parse(row.receipt_json))));
        const current = this.active(context);
        if (current.generationId === generationId && row.state === 'active') return current;
        if (
          row.state === 'active' ||
          current.generationId !== intent.request.parentGenerationId ||
          current.revision !== intent.request.expectedPointerRevision
        )
          throw new Error('Generation activation CAS conflict');
        const changed = this.db
          .prepare(
            'UPDATE symposium_artifact_generation_heads SET generation_id=?,revision=revision+1 WHERE session_id=? AND generation_id=? AND revision=?',
          )
          .run(generationId, context.sessionId, current.generationId, current.revision);
        if (changed.changes !== 1) throw new Error('Generation activation CAS conflict');
        this.db
          .prepare(
            "UPDATE symposium_artifact_generations SET state='active' WHERE generation_id=? AND state='verified'",
          )
          .run(generationId);
        return { generationId, revision: current.revision + 1 };
      })
      .immediate();
  }
  active(context: Context) {
    const row = this.db
      .prepare(
        'SELECT generation_id,revision FROM symposium_artifact_generation_heads WHERE session_id=?',
      )
      .get(context.sessionId) as { generation_id: string; revision: number } | undefined;
    if (!row) throw new Error('Artifact generation not found');
    this.get(context, row.generation_id);
    return { generationId: row.generation_id, revision: row.revision };
  }
  historical(context: Context, generationId: string) {
    const row = this.get(context, generationId);
    return {
      state: row.state,
      terminalObservation: (() => {
        const observed = this.db
          .prepare(
            'SELECT receipt_json FROM symposium_artifact_copy_observations WHERE generation_id=?',
          )
          .get(generationId) as { receipt_json: string } | undefined;
        return observed ? receiptSchema.parse(JSON.parse(observed.receipt_json)) : null;
      })(),
      initial: row.initial_json ? initialSchema.parse(JSON.parse(row.initial_json)) : null,
      intent: row.intent_json ? this.intent(row) : null,
      helperId: row.helper_id,
      receipt: row.receipt_json ? receiptSchema.parse(JSON.parse(row.receipt_json)) : null,
    };
  }
}
