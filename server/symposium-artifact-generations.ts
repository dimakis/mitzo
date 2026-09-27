import { artifactAdmissionDigest } from './event-store.js';
import {
  ArtifactAdmissionBindingV1Schema,
  ArtifactActivationReceiptV1Schema,
  type ArtifactAdmissionBindingV1,
  type ArtifactActivationReceiptV1,
} from '@mitzo/protocol';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccountBindingSchema } from '@mitzo/protocol';
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
const commonRequest = identity.extend({
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
  actor: id,
  authorityGrantId: id,
  authorityRevision: z.number().int().positive(),
  seatId: id,
  membershipGeneration: z.number().int().positive(),
  accountId: id,
  model: id,
  profileId: id,
  profileRevision: id,
  copierImageDigest: hash,
  copierCodeDigest: hash,
});
const requestSchema = z.union([
  commonRequest.extend({
    kind: z.literal('initial'),
    sourceSealId: id,
    initialAttemptId: id,
    policyReservationId: id,
    expectedConfigRevision: z.number().int().positive(),
    predecessorMembershipGeneration: z.number().int().positive(),
    accountBinding: AccountBindingSchema,
    contextGrant: z.strictObject({ grantId: id, revision: z.number().int().positive() }),
  }),
  commonRequest.extend({
    kind: z.literal('fix').optional(),
    fixAttemptId: id,
    findingFingerprints: z.array(hash).min(1).max(128),
  }),
]);
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
const physicalSchema = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('volume_create_dispatched') }),
  z.strictObject({ phase: z.literal('volume_created'), name: id }),
  z.strictObject({ phase: z.literal('helper_create_dispatched') }),
  z.strictObject({ phase: z.literal('helper_created'), helperId: hash }),
  z.strictObject({
    phase: z.literal('terminal'),
    helperId: hash,
    exitCode: z.number().int().min(0).max(255),
    proofDigest: hash.nullable(),
  }),
  z.strictObject({ phase: z.literal('helper_removed'), helperId: hash }),
  z.strictObject({ phase: z.literal('helper_absent'), helperId: hash }),
]);
export type ArtifactGenerationPhysicalObservation = z.infer<typeof physicalSchema>;
const physicalPhases = [
  'volume_create_dispatched',
  'volume_created',
  'helper_create_dispatched',
  'helper_created',
  'terminal',
  'helper_removed',
  'helper_absent',
] as const;
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
  physical_json: string | null;
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
      CREATE TABLE IF NOT EXISTS symposium_generation_admissions (generation_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL, receipt_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS symposium_artifact_copy_observations (generation_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL);
    `);
    if (
      !(db.pragma('table_info(symposium_artifact_generations)') as { name: string }[]).some(
        (row) => row.name === 'physical_json',
      )
    )
      db.exec('ALTER TABLE symposium_artifact_generations ADD COLUMN physical_json TEXT');
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
    if (
      request.kind !== 'initial' &&
      new Set(request.findingFingerprints).size !== request.findingFingerprints.length
    )
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
  assertCopyCurrent(context: Context, generationId: string): void {
    const row = this.get(context, generationId);
    const intent = this.intent(row);
    if (row.state !== 'copy_uncertain') throw new Error('Copy is not dispatchable');
    this.require(this.proof.authority(intent.request));
    this.parent(intent);
    const current = this.active(context);
    if (
      current.generationId !== intent.request.parentGenerationId ||
      current.revision !== intent.request.expectedPointerRevision
    )
      throw new Error('Generation parent pointer changed');
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
  /** Append exact observations before any later authority/custody postcheck. Never authorizes redispatch. */
  observePhysical(
    context: Context,
    generationId: string,
    input: ArtifactGenerationPhysicalObservation,
  ): void {
    const value = physicalSchema.parse(input);
    this.db
      .transaction(() => {
        const row = this.get(context, generationId);
        const intent = this.intent(row);
        if (!['copy_uncertain', 'quarantined'].includes(row.state))
          throw new Error('Physical copy is not unsettled');
        const previous = this.physical(row);
        if (physicalPhases[previous.length] !== value.phase)
          throw new Error('Physical copy observation order changed');
        if (value.phase === 'volume_created' && value.name !== intent.volumeName)
          throw new Error('Child volume identity changed');
        if (
          'helperId' in value &&
          value.phase !== 'helper_created' &&
          value.helperId !== row.helper_id
        )
          throw new Error('Child helper identity changed');
        if (value.phase === 'helper_created')
          this.bindHelper(context, generationId, value.helperId);
        this.db
          .prepare(
            'UPDATE symposium_artifact_generations SET physical_json=? WHERE generation_id=?',
          )
          .run(canonicalReviewJson([...previous, value]), generationId);
      })
      .immediate();
  }
  private physical(row: Row): ArtifactGenerationPhysicalObservation[] {
    return row.physical_json
      ? z.array(physicalSchema).max(7).parse(JSON.parse(row.physical_json))
      : [];
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
  activateAdmission(
    input: ArtifactAdmissionBindingV1,
    assertIntent: (binding: ArtifactAdmissionBindingV1) => true,
  ): ArtifactActivationReceiptV1 {
    const binding = ArtifactAdmissionBindingV1Schema.parse(input);
    return this.db
      .transaction(() => {
        if (assertIntent(binding) !== true)
          throw new Error('Retained EventStore successor intent required');
        const context = {
          sessionId: binding.sessionId,
          workspace: binding.workspaceId,
          custodyDigest: binding.custodyDigest,
        };
        const row = this.get(context, binding.childGenerationId),
          intent = this.intent(row),
          request = intent.request;
        if (
          !row.receipt_json ||
          artifactAdmissionDigest(JSON.parse(row.receipt_json)) !== binding.copyReceiptDigest ||
          intent.volumeName !== binding.childVolumeName ||
          request.operationId !== binding.operationId ||
          request.parentGenerationId !== binding.parentGenerationId ||
          request.parentSealDigest !== binding.parentSealDigest ||
          request.expectedPointerRevision !== binding.expectedPointerRevision ||
          request.workflowId !== binding.workflowId ||
          request.kind !== binding.kind ||
          (request.kind === 'initial' && binding.kind === 'initial'
            ? request.sourceSealId !== binding.sourceSealId ||
              request.initialAttemptId !== binding.initialAttemptId ||
              request.policyReservationId !== binding.policyReservationId ||
              request.expectedConfigRevision !== binding.expectedConfigRevision ||
              request.predecessorMembershipGeneration !== binding.predecessorMembershipGeneration ||
              artifactAdmissionDigest(request.accountBinding) !==
                artifactAdmissionDigest(binding.accountBinding) ||
              request.contextGrant.grantId !== binding.contextGrant.grantId ||
              request.contextGrant.revision !== binding.contextGrant.revision
            : request.kind !== 'initial' && binding.kind !== 'initial'
              ? request.fixAttemptId !== binding.fixAttemptId ||
                artifactAdmissionDigest(request.findingFingerprints) !==
                  artifactAdmissionDigest(binding.findingFingerprints)
              : true) ||
          request.actor !== binding.actor ||
          request.seatId !== binding.seatId ||
          request.membershipGeneration !== binding.predecessorMembershipGeneration ||
          request.accountId !== binding.accountBinding.accountId ||
          request.model !== binding.accountBinding.model ||
          request.profileId !== binding.profileBinding.profileId ||
          request.profileRevision !== binding.profileBinding.profileRevision ||
          request.authorityGrantId !== binding.authorityGrant.grantId ||
          request.authorityRevision !== binding.authorityGrant.revision
        )
          throw new Error('Successor copy binding mismatch');
        const prior = this.db
          .prepare('SELECT binding_json FROM symposium_generation_admissions WHERE generation_id=?')
          .get(binding.childGenerationId) as { binding_json: string } | undefined;
        if (prior) return this.requireAdmission(binding);
        if (row.state !== 'verified') throw new Error('Legacy pointer is not successor admission');
        const pointer = this.activate(context, binding.childGenerationId);
        const receipt: ArtifactActivationReceiptV1 = {
          version: 1,
          transitionId: binding.transitionId,
          bindingDigest: artifactAdmissionDigest(binding),
          sessionId: binding.sessionId,
          parentGenerationId: binding.parentGenerationId,
          childGenerationId: binding.childGenerationId,
          childVolumeName: binding.childVolumeName,
          expectedPointerRevision: binding.expectedPointerRevision,
          pointerRevision: pointer.revision,
          copyReceiptDigest: binding.copyReceiptDigest,
        };
        this.db
          .prepare('INSERT INTO symposium_generation_admissions VALUES(?,?,?)')
          .run(binding.childGenerationId, JSON.stringify(binding), JSON.stringify(receipt));
        return receipt;
      })
      .immediate();
  }
  requireAdmission(input: ArtifactAdmissionBindingV1): ArtifactActivationReceiptV1 {
    const binding = ArtifactAdmissionBindingV1Schema.parse(input);
    const row = this.db
      .prepare(
        'SELECT binding_json,receipt_json FROM symposium_generation_admissions WHERE generation_id=?',
      )
      .get(binding.childGenerationId) as { binding_json: string; receipt_json: string } | undefined;
    const context = {
      sessionId: binding.sessionId,
      workspace: binding.workspaceId,
      custodyDigest: binding.custodyDigest,
    };
    const pointer = this.active(context);
    if (
      !row ||
      artifactAdmissionDigest(JSON.parse(row.binding_json)) !== artifactAdmissionDigest(binding) ||
      pointer.generationId !== binding.childGenerationId ||
      pointer.revision !== binding.activatedPointerRevision
    )
      throw new Error('Exact current successor activation required');
    const receipt = ArtifactActivationReceiptV1Schema.parse(JSON.parse(row.receipt_json));
    if (receipt.bindingDigest !== artifactAdmissionDigest(binding))
      throw new Error('Successor receipt identity changed');
    return receipt;
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
      physical: this.physical(row),
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

/** Read current admission proof from the existing private ledger; does not initialize or migrate it. */
export function readArtifactAdmissionReceipt(
  path: string,
  input: ArtifactAdmissionBindingV1,
): ArtifactActivationReceiptV1 {
  const binding = ArtifactAdmissionBindingV1Schema.parse(input);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => {
      const row = db
        .prepare(
          `SELECT a.binding_json,a.receipt_json,g.identity_json,h.generation_id,h.revision FROM symposium_generation_admissions a JOIN symposium_artifact_generations g ON g.generation_id=a.generation_id JOIN symposium_artifact_generation_heads h ON h.session_id=g.session_id WHERE a.generation_id=?`,
        )
        .get(binding.childGenerationId) as
        | {
            binding_json: string;
            receipt_json: string;
            identity_json: string;
            generation_id: string;
            revision: number;
          }
        | undefined;
      if (
        !row ||
        artifactAdmissionDigest(JSON.parse(row.binding_json)) !==
          artifactAdmissionDigest(binding) ||
        artifactAdmissionDigest(JSON.parse(row.identity_json)) !==
          artifactAdmissionDigest({
            sessionId: binding.sessionId,
            workspace: binding.workspaceId,
            custodyDigest: binding.custodyDigest,
          }) ||
        row.generation_id !== binding.childGenerationId ||
        row.revision !== binding.activatedPointerRevision
      )
        throw new Error('Exact current successor activation required');
      const receipt = ArtifactActivationReceiptV1Schema.parse(JSON.parse(row.receipt_json));
      if (receipt.bindingDigest !== artifactAdmissionDigest(binding))
        throw new Error('Successor receipt identity changed');
      return receipt;
    })();
  } finally {
    db.close();
  }
}
