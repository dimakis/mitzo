import {
  ArtifactReaderReferenceV1Schema,
  type ArtifactReaderReferenceV1,
  type ArtifactAdmissionReferenceV1,
} from '@mitzo/protocol';
import { canonicalReviewJson, reviewRecordHash } from './symposium-review-records.js';
import {
  ARTIFACT_GIT_EXPORT,
  ARTIFACT_INSPECTION_MAX_OUTPUT_BYTES,
  ARTIFACT_REVIEW_CONTEXT_MAX_BYTES,
  ARTIFACT_REVIEW_CONTEXT_MAX_OUTPUT_BYTES,
} from './symposium-artifact-git-export.js';
import type { GithubSandboxInspection } from './connections/capabilities/github-publish-pr.js';
import { assertSessionArtifactVolume } from './symposium-session-artifacts.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from './symposium-artifact-lease.js';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { EventStore } from './event-store.js';
type SymposiumArtifactSealIntent = NonNullable<
  ReturnType<EventStore['getSymposiumArtifactSealIntent']>
>;
import type { SymposiumSeatSandboxRecord } from '@mitzo/protocol/event-store';
import {
  SqliteArtifactLeaseHost,
  ArtifactCommandNotDispatched,
} from './symposium-artifact-host.js';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import type { SymposiumAttemptRegistry } from './symposium-attempt-registry.js';
import {
  assertSymposiumRuntimeForArtifactSeal,
  drainSymposiumRuntimeForArtifactSeal,
} from './symposium-session-runtime.js';
import { OpenShellRuntimeManager, type OpenShellRuntimeConfig } from './openshell-runtime.js';
import { TESTED_SYMPOSIUM_NATIVE_BUILD } from './symposium-production-gate.js';
import { ARTIFACT_GIT_VERIFIER } from './symposium-artifact-git-verifier.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const gitProofSchema = z.strictObject({
  version: z.literal(1),
  commit: oid,
  tree: oid,
  entries: z.number().int().min(0).max(10000),
  bytes: z
    .number()
    .int()
    .min(0)
    .max(64 * 1024 * 1024),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  committedTreeDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const containerId = /^[a-f0-9]{64}$/;
const inputSchema = z.strictObject({
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  expectedConfigRevision: z.number().int().positive(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  repositoryPath: z
    .string()
    .min(1)
    .max(2048)
    .refine(
      (value) =>
        value === '.' ||
        value
          .split('/')
          .every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..'),
    ),
});
export type PhysicalArtifactSealInput = z.infer<typeof inputSchema>;
export interface CompletedArtifactSeal {
  kind: 'completed_artifact_seal';
  version: 1;
  fenceId: string;
  sessionId: string;
  custodyDigest: string;
  intentDigest: string;
  retentionDigest: string;
  revocationDigest: string;
  repositoryPath: string;
  git: z.infer<typeof gitProofSchema>;
  verifier: { id: string; image: string; codeDigest: string };
  completedAt: number;
}

const successorSelectionSchema = z.strictObject({
  sourceRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/),
  sourceOid: oid,
  baseRef: z.string().regex(/^refs\/remotes\/origin\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/),
  baseOid: oid,
  defaultBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/),
  originUrl: z
    .string()
    .max(2048)
    .regex(
      /^(https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/,
    ),
});
export interface SuccessorArtifactExportReceipt {
  version: 1;
  mode: 'successor';
  jobId: string;
  operationId: string;
  parentGenerationId: string;
  parentVolumeName: string;
  parentSealDigest: string;
  seal: CompletedArtifactSeal;
  selection: z.infer<typeof successorSelectionSchema>;
  bundleSha256: string;
  bytes: number;
  helper: {
    id: string;
    name: string;
    image: string;
    codeDigest: string;
    terminalExitCode: 0;
    removed: true;
  };
}

export interface CompletedArtifactReviewContext {
  context: string;
  pages?: Array<{ context: string; receipt: CompletedArtifactReviewContext['receipt'] }>;
  receipt: {
    version: 1;
    mode: 'review_context';
    jobId: string;
    operationId: string;
    sealFenceId: string;
    sealDigest: string;
    intentDigest: string;
    artifactRevision: string;
    artifactHash: string;
    baseOid: string;
    sourceOid: string;
    contextSha256: string;
    pageIndex?: number;
    pageCount?: number;
    evidenceSha256?: string;
    pagesSha256?: string;
    completedAt: number;
    helper: SuccessorArtifactExportReceipt['helper'];
  };
}

/** Concrete host-only operation. No request route installs it and no model runs here.
 * Stable pending locks never imply reconstructed custody on a new gateway lifetime.
 */
const sealedInspectionSchema = z.strictObject({
  canonicalRepositoryPath: z.string(),
  status: z.literal('clean'),
  sourceBranch: z.string(),
  sourceOid: oid,
  defaultBranch: z.string(),
  originUrl: z.string(),
  commitsAhead: z.number().int().nonnegative(),
  changedFiles: z.array(z.string()).max(500),
  sourceBranchProtected: z.literal(false),
  symlinkFree: z.literal(true),
});

function parseSealedBundle(value: Record<string, unknown>, maxBytes: number): Buffer {
  if (
    typeof value.bundle !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bundle)
  )
    throw new Error('Sealed bundle encoding is invalid');
  const bundle = Buffer.from(value.bundle, 'base64');
  if (
    !bundle.length ||
    bundle.length > maxBytes ||
    value.bytes !== bundle.length ||
    value.bundleSha256 !== createHash('sha256').update(bundle).digest('hex')
  )
    throw new Error('Sealed bundle integrity changed');
  return bundle;
}

export class PhysicalArtifactSealer {
  private readonly db: Database.Database;
  private readonly command: (args: readonly string[], maxOutputBytes?: number) => Promise<string>;
  constructor(
    private readonly deps: {
      store: EventStore;
      leaseHost: SqliteArtifactLeaseHost;
      gateway: OwnedSymposiumGateway;
      attemptRegistry: SymposiumAttemptRegistry;
      runtimeConfig: OpenShellRuntimeConfig;
      /** Requires matching activated generation ledger receipt, not EventStore alone. */
      assertSuccessorAdmissionCurrent?: (
        sessionId: string,
        reference: ArtifactAdmissionReferenceV1,
      ) => true;
    },
  ) {
    deps.leaseHost.requireSnapshotGateway(deps.gateway);
    this.command = deps.leaseHost.snapshotCommand();
    this.db = new Database(deps.leaseHost.snapshotDatabasePath());
    this.db.pragma('journal_mode=WAL');
    this.db.pragma('synchronous=FULL');
    this.db.pragma('busy_timeout=5000');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS symposium_physical_seal_jobs(fence_id TEXT PRIMARY KEY,request_json TEXT NOT NULL,custody_digest TEXT NOT NULL,phase TEXT NOT NULL,records_json TEXT NOT NULL,verifier_name TEXT NOT NULL,verifier_id TEXT,receipt_json TEXT);`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS symposium_seal_export_jobs(job_id TEXT PRIMARY KEY,fence_id TEXT NOT NULL,operation_id TEXT NOT NULL,kind TEXT NOT NULL,input_json TEXT NOT NULL,custody_digest TEXT NOT NULL,state TEXT NOT NULL,container_name TEXT NOT NULL,container_id TEXT,result_hash TEXT);`,
    );
    if (
      !(this.db.pragma('table_info(symposium_seal_export_jobs)') as { name: string }[]).some(
        (row) => row.name === 'receipt_json',
      )
    )
      this.db.exec('ALTER TABLE symposium_seal_export_jobs ADD COLUMN receipt_json TEXT');
  }
  close() {
    this.db.close();
  }
  private async custody() {
    await this.deps.gateway.verifyCustodyAsync();
  }
  private async census() {
    const started = Date.now();
    const rows: unknown = JSON.parse(
      await this.command(['ps', '--all', '--no-trunc', '--format', 'json']),
    );
    if (Date.now() - started > 20000) throw new Error('Artifact census exceeded time bound');
    if (!Array.isArray(rows) || rows.length > 128)
      throw new Error('Artifact volume census is unavailable');
    const ids = rows.map((row) => {
      const id = String(row?.Id ?? row?.ID ?? '');
      if (!containerId.test(id)) throw new Error('Artifact census identity is invalid');
      return id;
    });
    if (new Set(ids).size !== ids.length)
      throw new Error('Artifact census contains duplicate identities');
    if (!ids.length) return [];
    // One Podman round trip for the bounded census. Per-container CLI launches can
    // exhaust the physical seal deadline on a shared VM before any mount is checked.
    const inspected: unknown = JSON.parse(
      await this.command(['inspect', '--type', 'container', ...ids], 12 * 1024 * 1024),
    );
    if (Date.now() - started > 20000) throw new Error('Artifact census exceeded time bound');
    if (!Array.isArray(inspected) || inspected.length !== ids.length)
      throw new Error('Artifact census inspection changed');
    const expected = new Set(ids);
    const observed = new Map<string, Array<{ Type: string; Name?: string; RW: boolean }>>();
    for (const row of inspected) {
      if (
        !row ||
        typeof row !== 'object' ||
        !containerId.test(row.Id) ||
        !expected.has(row.Id) ||
        observed.has(row.Id) ||
        !Array.isArray(row.Mounts)
      )
        throw new Error('Artifact census inspection changed');
      for (const mount of row.Mounts)
        if (
          !mount ||
          typeof mount.Type !== 'string' ||
          typeof mount.RW !== 'boolean' ||
          (mount.Type === 'volume' && typeof mount.Name !== 'string')
        )
          throw new Error('Artifact mount census is incomplete');
      observed.set(row.Id, row.Mounts);
    }
    const result: Array<{
      id: string;
      mounts: Array<{ Type: string; Name?: string; RW: boolean }>;
    }> = [];
    for (const id of ids) {
      result.push({ id, mounts: observed.get(id)! });
    }
    return result;
  }
  private async noVolumeMounts(volume: string, allowedReadOnlyIds = new Set<string>()) {
    if (
      (await this.census()).some((row) =>
        row.mounts.some(
          (m) =>
            m.Type === 'volume' && m.Name === volume && (m.RW || !allowedReadOnlyIds.has(row.id)),
        ),
      )
    )
      throw new Error('Artifact volume still has unauthorized physical mounts');
  }
  private async noVerifierName(name: string) {
    const rows: unknown = JSON.parse(
      await this.command(['ps', '--all', '--no-trunc', '--format', 'json']),
    );
    if (!Array.isArray(rows) || rows.length > 128)
      throw new Error('Artifact verifier name census is unavailable');
    for (const row of rows) {
      const names = row?.Names;
      if (
        typeof names !== 'string' &&
        !(Array.isArray(names) && names.every((value) => typeof value === 'string'))
      )
        throw new Error('Artifact verifier name census is incomplete');
      if ((Array.isArray(names) ? names : [names]).includes(name))
        throw new Error('Artifact verifier name is already occupied');
    }
  }
  private async absent(records: SymposiumSeatSandboxRecord[], signal: AbortSignal) {
    for (const record of records) {
      const manager = new OpenShellRuntimeManager({
        ...this.deps.runtimeConfig,
        account: { kind: 'api', provider: record.providerName, model: record.model },
        accountProviderBindings: [
          { name: record.providerName, type: record.providerType, id: record.providerId },
        ],
        verifyAccountProviderUnion: () => undefined,
      });
      signal.throwIfAborted();
      if (await manager.inspectReserved(record.runtimeId, signal))
        throw new Error('Artifact writer gateway absence changed');
    }
  }
  private verifiedOtherGeneration(
    reference: ArtifactAdmissionReferenceV1 | ArtifactReaderReferenceV1 | undefined,
    parent: SymposiumArtifactSealIntent,
  ): boolean {
    if (
      !reference ||
      ArtifactReaderReferenceV1Schema.safeParse(reference).success ||
      reference.artifactGenerationId === parent.selection.artifact.volumeGeneration
    )
      return false;
    try {
      const binding = this.deps.store.assertSymposiumArtifactAdmissionCurrent(
        parent.selection.sessionId,
        reference as ArtifactAdmissionReferenceV1,
      );
      if (
        this.deps.assertSuccessorAdmissionCurrent?.(
          parent.selection.sessionId,
          reference as ArtifactAdmissionReferenceV1,
        ) !== true
      )
        return false;
      return (
        binding.kind !== 'initial' &&
        binding.parentFenceId === parent.fenceId &&
        binding.parentGenerationId === parent.selection.artifact.volumeGeneration
      );
    } catch {
      return false;
    }
  }
  private verifiedSealedReader(
    reference: ArtifactAdmissionReferenceV1 | ArtifactReaderReferenceV1 | undefined,
    parent: SymposiumArtifactSealIntent,
  ): boolean {
    if (!reference || !ArtifactReaderReferenceV1Schema.safeParse(reference).success) return false;
    try {
      const binding = this.deps.store.assertSymposiumSealedReaderAdmissionCurrent(
        parent.selection.sessionId,
        reference as ArtifactReaderReferenceV1,
      );
      const admission = this.deps.store.getSymposiumSealedReaderAdmission(
        binding.sessionId,
        binding.readerAdmissionId,
      );
      const lease = this.deps.leaseHost
        .sealLeaseIdentities('podman', binding.volumeName)
        .find((row) => row.request.readerAdmissionId === binding.readerAdmissionId);
      return Boolean(
        admission?.receipt &&
        lease &&
        binding.sealFenceId === parent.fenceId &&
        binding.artifactGenerationId === parent.selection.artifact.volumeGeneration &&
        admission.receipt.leaseTokenHash === lease.tokenHash &&
        admission.receipt.leaseRevision === lease.revision &&
        lease.request.access === 'reviewer',
      );
    } catch {
      return false;
    }
  }
  private allowedSealedReaderLeases(parent: SymposiumArtifactSealIntent): Set<string> {
    const allowed = new Set<string>();
    const leases = this.deps.leaseHost.sealLeaseIdentities(
      'podman',
      parent.selection.artifact.volumeName,
    );
    for (const lease of leases) {
      if (lease.request.access !== 'reviewer' || !lease.request.readerAdmissionId)
        throw new Error('Completed artifact has unauthorized lease');
      const admission = this.deps.store.getSymposiumSealedReaderAdmission(
        parent.selection.sessionId,
        lease.request.readerAdmissionId,
      );
      if (
        !admission ||
        admission.binding.sealFenceId !== parent.fenceId ||
        admission.binding.artifactGenerationId !== parent.selection.artifact.volumeGeneration ||
        admission.binding.volumeName !== parent.selection.artifact.volumeName ||
        lease.request.seatId !== admission.binding.seatId
      )
        throw new Error('Completed artifact reader lease changed');
      if (!admission.receipt) {
        if (lease.creationStarted || lease.sandboxId || lease.sandboxName)
          throw new Error('Unconfirmed reader lease cannot create a sandbox');
        continue;
      }
      if (
        admission.receipt.leaseTokenHash !== lease.tokenHash ||
        admission.receipt.leaseRevision !== lease.revision
      )
        throw new Error('Completed artifact reader lease receipt changed');
      this.deps.store.assertSymposiumSealedReaderAdmissionCurrent(
        parent.selection.sessionId,
        admission.reference,
      );
      if (lease.creationStarted && !lease.sandboxId)
        throw new Error('Reader sandbox creation unresolved');
      if (lease.sandboxId) {
        const current = this.deps.store.getSymposiumSeatSandbox(
          parent.selection.sessionId,
          admission.binding.seatId,
          admission.binding.readerMembershipGeneration,
        );
        if (
          !current ||
          current.state !== 'ready' ||
          current.physicalId !== lease.sandboxId ||
          current.artifact?.bindingDigest !== admission.reference.bindingDigest
        )
          throw new Error('Reader runtime identity changed');
        allowed.add(lease.sandboxId);
      }
    }
    return allowed;
  }
  async requireCompleted(fenceId: string, signal: AbortSignal): Promise<CompletedArtifactSeal> {
    if (!/^[a-f0-9-]{36}$/.test(fenceId)) throw new Error('Artifact seal identity is invalid');
    signal.throwIfAborted();
    await this.custody();
    const row = this.db
      .prepare("SELECT * FROM symposium_physical_seal_jobs WHERE fence_id=? AND phase='complete'")
      .get(fenceId) as
      { receipt_json: string; records_json: string; custody_digest: string } | undefined;
    if (!row || row.custody_digest !== hash(this.deps.gateway.stateDirectory))
      throw new Error('Completed artifact seal custody is unavailable');
    const receipt = JSON.parse(row.receipt_json) as CompletedArtifactSeal;
    const intent = this.deps.store.getSymposiumArtifactSealByFence(receipt.fenceId);
    if (
      !intent ||
      receipt.fenceId !== fenceId ||
      receipt.intentDigest !== hash(JSON.stringify(intent)) ||
      receipt.verifier.image !== TESTED_SYMPOSIUM_NATIVE_BUILD.image ||
      receipt.verifier.codeDigest !== hash(ARTIFACT_GIT_VERIFIER)
    )
      throw new Error('Completed artifact seal identity changed');
    assertSessionArtifactVolume(
      intent.selection.custody.workspaceId,
      {
        sessionId: receipt.sessionId,
        volumeName: intent.selection.artifact.volumeName,
        volumeGeneration: intent.selection.artifact.volumeGeneration,
      },
      await this.deps.leaseHost.inspectVolume(intent.selection.artifact.volumeName, 'podman'),
    );
    const retention = this.deps.leaseHost.pendingArtifactRetention(
      'podman',
      intent.selection.artifact.volumeName,
    );
    if (!retention || receipt.retentionDigest !== hash(JSON.stringify(retention)))
      throw new Error('Completed artifact retention changed');
    this.allowedSealedReaderLeases(intent);
    const records = JSON.parse(row.records_json) as SymposiumSeatSandboxRecord[];
    if (
      receipt.revocationDigest !== hash(JSON.stringify(records)) ||
      [
        ...this.deps.attemptRegistry.pending(),
        ...this.deps.attemptRegistry.pendingPreparations(),
      ].some(
        (row) =>
          row.sessionId === receipt.sessionId &&
          !this.verifiedOtherGeneration(row.artifact, intent) &&
          !this.verifiedSealedReader(row.artifact, intent),
      )
    )
      throw new Error('Completed artifact revocation changed');
    for (const record of records) {
      const current = this.deps.store.getSymposiumSeatSandbox(
        record.sessionId,
        record.seatId,
        record.generation,
      );
      if (
        current?.state !== 'stopped' ||
        current.physicalId !== record.physicalId ||
        this.deps.store
          .getUnsettledSymposiumSeatExecutions(record.sessionId, record.seatId)
          .some((attempt) => {
            const native = attempt.claimToken
              ? this.deps.attemptRegistry.get(attempt.claimToken)
              : undefined;
            return (
              !this.verifiedOtherGeneration(native?.artifact, intent) &&
              !this.verifiedSealedReader(native?.artifact, intent)
            );
          })
      )
        throw new Error('Completed artifact terminal cleanup changed');
    }
    await this.absent(records, signal);
    await this.noVolumeMounts(
      intent.selection.artifact.volumeName,
      this.allowedSealedReaderLeases(intent),
    );
    if ((await this.census()).some((row) => row.id === receipt.verifier.id))
      throw new Error('Completed artifact verifier remains');
    await this.custody();
    signal.throwIfAborted();
    this.deps.store.withSymposiumHistoricalArtifactSealSnapshot(intent, () => {});
    return structuredClone(receipt);
  }

  async inspectCompletedArtifact(
    input: { fenceId: string; operationId: string; baseBranch: string },
    signal: AbortSignal,
  ): Promise<GithubSandboxInspection> {
    const value = await this.exportOperation({ ...input, kind: 'inspect' }, signal);
    return sealedInspectionSchema.parse(value.inspection);
  }

  async exportCompletedReviewContext(
    input: { fenceId: string; operationId: string; baseBranch: string; page?: number },
    signal: AbortSignal,
  ): Promise<CompletedArtifactReviewContext> {
    const value = await this.exportOperation({ ...input, kind: 'review_context' }, signal);
    return {
      context: value.context as string,
      receipt: value.receipt as CompletedArtifactReviewContext['receipt'],
      ...(Array.isArray(value.pages)
        ? {
            pages: (value.pages as string[]).map((context, pageIndex) => ({
              context,
              receipt: {
                ...(value.receipt as CompletedArtifactReviewContext['receipt']),
                contextSha256: hash(context),
                pageIndex,
              },
            })),
          }
        : {}),
    };
  }

  /** A fresh credential-free helper recomputes the sealed committed manifest and
   * returns only one file digest. Its journal and terminal container identity are
   * retained with the execution receipt; absence is a failed check, not a guess. */
  async checkCompletedArtifactFile(
    input: { fenceId: string; operationId: string; path: string },
    signal: AbortSignal,
  ): Promise<{
    executionId: string;
    sealFenceId: string;
    sealDigest: string;
    artifactRevision: string;
    artifactHash: string;
    observedSha256: string | null;
    completedAt: number;
  }> {
    const value = await this.exportOperation(
      {
        fenceId: input.fenceId,
        operationId: input.operationId,
        kind: 'check',
        checkPath: input.path,
      },
      signal,
    );
    const checked = z
      .strictObject({
        executionId: z.string().uuid(),
        sealFenceId: z.string(),
        sealDigest: z.string().regex(/^[a-f0-9]{64}$/),
        artifactRevision: oid,
        artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
        observedSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
        completedAt: z.number().int().nonnegative(),
      })
      .parse(value.checkReceipt);
    return checked;
  }

  async exportCompletedArtifactBundle(
    input: {
      fenceId: string;
      operationId: string;
      sourceBranch: string;
      baseBranch: string;
      sourceOid: string;
      maxBytes: number;
    },
    signal: AbortSignal,
  ): Promise<Buffer> {
    const value = await this.exportOperation({ ...input, kind: 'bundle' }, signal);
    return parseSealedBundle(value, input.maxBytes);
  }

  async exportSuccessorArtifactBundle(
    input: {
      fenceId: string;
      operationId: string;
      sourceBranch: string;
      baseBranch: string;
      sourceOid: string;
      maxBytes: number;
    },
    signal: AbortSignal,
  ): Promise<{ bundle: Buffer; receipt: SuccessorArtifactExportReceipt }> {
    const value = await this.exportOperation({ ...input, kind: 'successor' }, signal);
    return {
      bundle: parseSealedBundle(value, input.maxBytes),
      receipt: value.receipt as SuccessorArtifactExportReceipt,
    };
  }

  /** Exact retained job authority, usable inside synchronous generation proof transactions. */
  assertRetainedSuccessorExport(receipt: SuccessorArtifactExportReceipt, bundle: Buffer): true {
    const row = this.db
      .prepare('SELECT state,kind,receipt_json FROM symposium_seal_export_jobs WHERE job_id=?')
      .get(receipt.jobId) as
      { state: string; kind: string; receipt_json: string | null } | undefined;
    if (
      !row ||
      row.state !== 'complete' ||
      row.kind !== 'successor' ||
      row.receipt_json !== canonicalReviewJson(receipt) ||
      receipt.mode !== 'successor' ||
      receipt.parentSealDigest !== reviewRecordHash(canonicalReviewJson(receipt.seal)) ||
      bundle.length !== receipt.bytes ||
      bundle.length > 8 * 1024 * 1024 ||
      createHash('sha256').update(bundle).digest('hex') !== receipt.bundleSha256
    )
      throw new Error('Retained successor export evidence changed');
    return true;
  }

  async requireSuccessorExport(
    receipt: SuccessorArtifactExportReceipt,
    bundle: Buffer,
    signal: AbortSignal,
  ): Promise<CompletedArtifactSeal> {
    this.assertRetainedSuccessorExport(receipt, bundle);
    const seal = await this.requireCompleted(receipt.seal.fenceId, signal);
    if (canonicalReviewJson(seal) !== canonicalReviewJson(receipt.seal))
      throw new Error('Successor parent seal changed');
    this.assertRetainedSuccessorExport(receipt, bundle);
    return seal;
  }

  private async exportOperation(
    raw: {
      fenceId: string;
      operationId: string;
      baseBranch?: string;
      kind: 'inspect' | 'bundle' | 'successor' | 'check' | 'review_context';
      sourceBranch?: string;
      sourceOid?: string;
      maxBytes?: number;
      checkPath?: string;
      page?: number;
    },
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const input = z
      .strictObject({
        fenceId: z.string(),
        operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
        baseBranch: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/)
          .optional(),
        kind: z.enum(['inspect', 'bundle', 'successor', 'check', 'review_context']),
        sourceBranch: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/)
          .optional(),
        sourceOid: oid.optional(),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(8 * 1024 * 1024)
          .optional(),
        checkPath: z
          .string()
          .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/)
          .max(512)
          .optional(),
        page: z.number().int().min(0).max(65535).optional(),
      })
      .parse(raw);
    if (
      input.kind === 'check' &&
      (!input.checkPath ||
        input.checkPath.split('/').some((part) => part === '.' || part === '..' || part === '.git'))
    )
      throw new Error('Criterion check path is invalid');
    if (
      input.kind !== 'inspect' &&
      input.kind !== 'check' &&
      input.kind !== 'review_context' &&
      (!input.sourceBranch || !input.sourceOid || !input.maxBytes)
    )
      throw new Error('Sealed bundle selection is incomplete');
    if (input.kind !== 'check' && !input.baseBranch)
      throw new Error('Sealed export base branch is unavailable');
    const receipt = await this.requireCompleted(input.fenceId, signal);
    if (input.sourceOid && input.sourceOid !== receipt.git.commit)
      throw new Error('Sealed bundle commit changed');
    const priorReviewJobs =
      input.kind === 'review_context'
        ? (this.db
            .prepare(
              'SELECT kind,state,input_json,receipt_json FROM symposium_seal_export_jobs WHERE fence_id=? AND operation_id=?',
            )
            .all(input.fenceId, input.operationId) as Array<{
            kind: string;
            state: string;
            input_json: string;
            receipt_json: string | null;
          }>)
        : [];
    if (
      priorReviewJobs.some(
        (job) =>
          job.kind !== 'review_context' ||
          job.input_json !== JSON.stringify(input) ||
          (job.state === 'complete' && !job.receipt_json),
      )
    )
      throw new Error('Sealed review context operation identity changed');
    const priorReviewReceipts = priorReviewJobs
      .filter((job) => job.state === 'complete')
      .map((job) => JSON.parse(job.receipt_json!) as CompletedArtifactReviewContext['receipt']);
    if (
      priorReviewReceipts.some(
        (prior) =>
          prior.contextSha256 !== priorReviewReceipts[0].contextSha256 ||
          prior.pagesSha256 !== priorReviewReceipts[0].pagesSha256 ||
          prior.sealDigest !== priorReviewReceipts[0].sealDigest ||
          prior.baseOid !== priorReviewReceipts[0].baseOid ||
          prior.sourceOid !== priorReviewReceipts[0].sourceOid,
      )
    )
      throw new Error('Sealed review context replay history changed');
    const priorReviewReceipt = priorReviewReceipts[0];
    const intent = this.deps.store.getSymposiumArtifactSealByFence(receipt.fenceId)!;
    const volume = intent.selection.artifact.volumeName;
    const jobId = randomUUID(),
      name = `mitzo-seal-export-${jobId}`;
    signal.throwIfAborted();
    await this.custody();
    signal.throwIfAborted();
    this.db
      .transaction(() => {
        if (
          this.db
            .prepare(
              "SELECT 1 FROM symposium_seal_export_jobs WHERE fence_id=? AND state NOT IN ('complete','failed_cleaned','not_dispatched')",
            )
            .get(input.fenceId)
        )
          throw new Error('Sealed export requires helper reconciliation');
        this.db
          .prepare(
            'INSERT INTO symposium_seal_export_jobs(job_id,fence_id,operation_id,kind,input_json,custody_digest,state,container_name) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            jobId,
            input.fenceId,
            input.operationId,
            input.kind,
            JSON.stringify(input),
            receipt.custodyDigest,
            'create_uncertain',
            name,
          );
      })
      .immediate();
    let id: string | undefined;
    let helperDeleted = false;
    let helperRemovalObserved = false;
    const outputLimit =
      input.kind === 'review_context'
        ? ARTIFACT_REVIEW_CONTEXT_MAX_OUTPUT_BYTES
        : input.kind !== 'inspect' && input.kind !== 'check'
          ? Math.ceil((input.maxBytes! * 4) / 3) + 16384
          : ARTIFACT_INSPECTION_MAX_OUTPUT_BYTES;
    const verify = async () => {
      const found: unknown = JSON.parse(await this.command(['inspect', id!]));
      if (!Array.isArray(found) || found.length !== 1)
        throw new Error('Sealed export helper identity changed');
      const c = found[0];
      if (
        c.Id !== id ||
        c.Config?.Labels?.['mitzo.artifact-export-job'] !== jobId ||
        c.ImageName !== TESTED_SYMPOSIUM_NATIVE_BUILD.image ||
        c.Config?.User !== 'sandbox' ||
        c.HostConfig?.NetworkMode !== 'none' ||
        c.HostConfig?.ReadonlyRootfs !== true ||
        c.HostConfig?.Privileged !== false ||
        !Array.isArray(c.Mounts) ||
        c.Mounts.length !== 1 ||
        c.Mounts[0].Type !== 'volume' ||
        c.Mounts[0].Name !== volume ||
        c.Mounts[0].Destination !== SYMPOSIUM_ARTIFACT_TARGET ||
        c.Mounts[0].RW !== false
      )
        throw new Error('Sealed export isolation changed');
      return c;
    };
    const cleanup = async () => {
      const c = await verify();
      if (c.State?.Running !== false) await this.command(['stop', '--time', '1', id!]);
      if ((await verify()).State?.Running !== false)
        throw new Error('Sealed export helper stop is uncertain');
      await this.command(['rm', id!]);
      helperRemovalObserved = true;
      this.db
        .prepare("UPDATE symposium_seal_export_jobs SET state='removed' WHERE job_id=?")
        .run(jobId);
      if ((await this.census()).some((row) => row.id === id))
        throw new Error('Sealed export helper deletion is uncertain');
    };
    try {
      const result = (
        await this.command([
          'create',
          '--pull=never',
          '--name',
          name,
          '--label',
          `mitzo.artifact-export-job=${jobId}`,
          '--network=none',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--user',
          'sandbox',
          '--pids-limit=32',
          '--memory=256m',
          '--cpus=1',
          '--mount',
          `type=volume,src=${volume},dst=${SYMPOSIUM_ARTIFACT_TARGET},readonly`,
          '--entrypoint=/usr/bin/python3',
          TESTED_SYMPOSIUM_NATIVE_BUILD.image,
          '-I',
          '-c',
          ARTIFACT_GIT_EXPORT,
          receipt.repositoryPath,
          JSON.stringify({ ...input, expected: receipt.git }),
        ])
      ).trim();
      if (!containerId.test(result)) throw new Error('Sealed export create outcome is uncertain');
      id = result;
      this.db
        .prepare(
          "UPDATE symposium_seal_export_jobs SET state='created',container_id=? WHERE job_id=?",
        )
        .run(id, jobId);
      await verify();
      signal.throwIfAborted();
      await this.custody();
      const output = await this.command(['start', '--attach', id], outputLimit);
      if (Buffer.byteLength(output) > outputLimit)
        throw new Error('Sealed export output exceeded bound');
      const terminal = await verify();
      if (terminal.State?.Running !== false || terminal.State?.ExitCode !== 0)
        throw new Error('Sealed export terminal success is unconfirmed');
      const value = JSON.parse(output) as Record<string, unknown>;
      if (
        canonicalReviewJson(gitProofSchema.parse(value.proof)) !== canonicalReviewJson(receipt.git)
      )
        throw new Error('Exported Git proof differs from seal');
      if (input.kind === 'inspect') sealedInspectionSchema.parse(value.inspection);
      else if (input.kind === 'check') {
        if (
          value.checkPath !== input.checkPath ||
          (value.observedSha256 !== null &&
            !z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .safeParse(value.observedSha256).success)
        )
          throw new Error('Criterion check output changed');
      } else if (input.kind === 'review_context') {
        if (
          typeof value.context !== 'string' ||
          Buffer.byteLength(value.context, 'utf8') > ARTIFACT_REVIEW_CONTEXT_MAX_BYTES ||
          value.contextSha256 !== hash(value.context)
        )
          throw new Error('Sealed review context integrity changed');
        if (input.page !== undefined) {
          if (
            input.page !== 0 ||
            !Array.isArray(value.pages) ||
            value.pages.length === 0 ||
            value.pages.length > 64 ||
            value.pages.some(
              (page) =>
                typeof page !== 'string' ||
                Buffer.byteLength(page, 'utf8') > ARTIFACT_REVIEW_CONTEXT_MAX_BYTES,
            ) ||
            value.pages[0] !== value.context ||
            value.pagesSha256 !== hash(canonicalReviewJson(value.pages))
          )
            throw new Error('Sealed review page bundle changed');
          const context = z
            .strictObject({
              version: z.literal(3),
              scope: z.literal('sealed-changed-path-pages'),
              sourceOid: oid,
              baseOid: oid,
              sourceBranch: z.string(),
              baseBranch: z.string(),
              committedTreeDigest: z.string().regex(/^[a-f0-9]{64}$/),
              manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
              trackedFileCount: z.number().int().nonnegative(),
              changedPathCount: z.number().int().positive().max(500),
              evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
              pageIndex: z.number().int().min(0).max(65535),
              pageCount: z.number().int().min(1).max(64),
              segments: z
                .array(
                  z.strictObject({
                    path: z.string(),
                    status: z.enum(['present', 'deleted']),
                    baseMode: z.enum(['100644', '100755']).nullable(),
                    mode: z.enum(['100644', '100755']).nullable(),
                    sha256: z
                      .string()
                      .regex(/^[a-f0-9]{64}$/)
                      .nullable(),
                    bytes: z.number().int().nonnegative().nullable(),
                    representation: z.enum(['diff', 'content', 'absent']),
                    diffSha256: z.string().regex(/^[a-f0-9]{64}$/),
                    diffBytes: z.number().int().nonnegative(),
                    selectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
                    selectedBytes: z.number().int().nonnegative(),
                    segmentIndex: z.number().int().nonnegative(),
                    segmentCount: z.number().int().positive(),
                    data: z.string(),
                    segmentSha256: z.string().regex(/^[a-f0-9]{64}$/),
                  }),
                )
                .min(1),
            })
            .parse(JSON.parse(value.context));
          if (
            canonicalReviewJson(context) !== value.context ||
            context.sourceOid !== receipt.git.commit ||
            context.baseBranch !== input.baseBranch ||
            context.committedTreeDigest !== receipt.git.committedTreeDigest ||
            context.manifestDigest !== receipt.git.manifestDigest ||
            context.trackedFileCount !== receipt.git.entries ||
            context.pageIndex !== input.page ||
            context.pageIndex >= context.pageCount ||
            context.pageCount !== value.pages.length ||
            context.segments.some(
              (segment) =>
                segment.segmentIndex >= segment.segmentCount ||
                segment.segmentSha256 !== hash(segment.data) ||
                (segment.status === 'present'
                  ? segment.sha256 === null || segment.mode === null || segment.bytes === null
                  : segment.sha256 !== null || segment.mode !== null || segment.bytes !== null) ||
                (segment.representation === 'absent' &&
                  (segment.status !== 'deleted' ||
                    segment.data !== '' ||
                    segment.selectedBytes !== 0)),
            )
          )
            throw new Error('Sealed review page selection changed');
        } else {
          const context = z
            .strictObject({
              version: z.literal(2),
              scope: z.literal('bounded-changed-path-evidence'),
              sourceOid: oid,
              baseOid: oid,
              sourceBranch: z.string(),
              baseBranch: z.string(),
              committedTreeDigest: z.string().regex(/^[a-f0-9]{64}$/),
              manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
              trackedFileCount: z.number().int().nonnegative(),
              changedPathCount: z.number().int().positive().max(500),
              omittedPathCount: z.number().int().nonnegative().max(500),
              files: z
                .array(
                  z.strictObject({
                    path: z.string(),
                    status: z.enum(['present', 'deleted']),
                    baseMode: z.enum(['100644', '100755']).nullable(),
                    mode: z.enum(['100644', '100755']).nullable(),
                    sha256: z
                      .string()
                      .regex(/^[a-f0-9]{64}$/)
                      .nullable(),
                    bytes: z.number().int().nonnegative().nullable(),
                    representation: z.enum(['diff', 'content', 'absent', 'partial']),
                    complete: z.boolean(),
                    content: z.string().nullable(),
                    contentTruncated: z.boolean(),
                    diff: z.string().nullable(),
                    diffSha256: z.string().regex(/^[a-f0-9]{64}$/),
                    diffBytes: z.number().int().nonnegative(),
                    diffTruncated: z.boolean(),
                  }),
                )
                .min(1)
                .max(500),
            })
            .parse(JSON.parse(value.context));
          if (
            canonicalReviewJson(context) !== value.context ||
            context.sourceOid !== receipt.git.commit ||
            context.baseBranch !== input.baseBranch ||
            context.committedTreeDigest !== receipt.git.committedTreeDigest ||
            context.manifestDigest !== receipt.git.manifestDigest ||
            context.trackedFileCount !== receipt.git.entries ||
            context.files.length + context.omittedPathCount !== context.changedPathCount ||
            new Set(context.files.map((file) => file.path)).size !== context.files.length ||
            context.files.some((file) =>
              file.status === 'present'
                ? file.sha256 === null || file.mode === null || file.bytes === null
                : file.sha256 !== null || file.mode !== null || file.bytes !== null,
            ) ||
            context.files.some((file) =>
              file.representation === 'content' && file.complete
                ? file.content === null ||
                  file.sha256 !== hash(file.content) ||
                  file.bytes !== Buffer.byteLength(file.content) ||
                  file.diff !== null ||
                  file.contentTruncated ||
                  file.diffTruncated
                : file.representation === 'diff' && file.complete
                  ? file.diff === null ||
                    file.content !== null ||
                    file.diffSha256 !== hash(file.diff) ||
                    file.diffBytes !== Buffer.byteLength(file.diff) ||
                    file.contentTruncated ||
                    file.diffTruncated
                  : file.representation === 'absent' && file.complete
                    ? file.status !== 'deleted' ||
                      file.content !== null ||
                      file.diff !== null ||
                      file.diffBytes !== 0 ||
                      file.contentTruncated ||
                      file.diffTruncated
                    : file.representation !== 'partial' ||
                      file.complete ||
                      (!file.contentTruncated && !file.diffTruncated),
            )
          )
            throw new Error('Sealed review context selection changed');
        }
      } else parseSealedBundle(value, input.maxBytes!);
      this.db
        .prepare("UPDATE symposium_seal_export_jobs SET state='terminal' WHERE job_id=?")
        .run(jobId);
      const terminalId = id;
      await cleanup();
      helperDeleted = true;
      id = undefined;
      const current = await this.requireCompleted(input.fenceId, signal);
      if (JSON.stringify(current) !== JSON.stringify(receipt))
        throw new Error('Sealed export custody changed');
      let successorReceipt: SuccessorArtifactExportReceipt | undefined;
      let reviewContextReceipt: CompletedArtifactReviewContext['receipt'] | undefined;
      if (input.kind === 'successor') {
        const selection = successorSelectionSchema.parse(value.selection);
        if (
          selection.sourceRef !== `refs/heads/${input.sourceBranch}` ||
          selection.sourceOid !== receipt.git.commit ||
          selection.baseRef !== `refs/remotes/origin/${input.baseBranch}`
        )
          throw new Error('Successor export selection changed');
        successorReceipt = {
          version: 1,
          mode: 'successor',
          jobId,
          operationId: input.operationId,
          parentGenerationId: intent.selection.artifact.volumeGeneration,
          parentVolumeName: volume,
          parentSealDigest: reviewRecordHash(canonicalReviewJson(receipt)),
          seal: receipt,
          selection,
          bundleSha256: value.bundleSha256 as string,
          bytes: value.bytes as number,
          helper: {
            id: terminalId!,
            name,
            image: TESTED_SYMPOSIUM_NATIVE_BUILD.image,
            codeDigest: hash(ARTIFACT_GIT_EXPORT),
            terminalExitCode: 0,
            removed: true,
          },
        };
      }
      if (input.kind === 'review_context') {
        const context = JSON.parse(value.context as string) as {
          baseOid: string;
          sourceOid: string;
          pageCount?: number;
          evidenceSha256?: string;
        };
        reviewContextReceipt = {
          version: 1,
          mode: 'review_context',
          jobId,
          operationId: input.operationId,
          sealFenceId: receipt.fenceId,
          sealDigest: reviewRecordHash(canonicalReviewJson(receipt)),
          intentDigest: receipt.intentDigest,
          artifactRevision: receipt.git.commit,
          artifactHash: receipt.git.committedTreeDigest,
          baseOid: context.baseOid,
          sourceOid: context.sourceOid,
          contextSha256: value.contextSha256 as string,
          ...(input.page !== undefined
            ? {
                pageIndex: input.page,
                pageCount: context.pageCount!,
                evidenceSha256: context.evidenceSha256!,
                pagesSha256: value.pagesSha256 as string,
              }
            : {}),
          completedAt: Date.now(),
          helper: {
            id: terminalId!,
            name,
            image: TESTED_SYMPOSIUM_NATIVE_BUILD.image,
            codeDigest: hash(ARTIFACT_GIT_EXPORT),
            terminalExitCode: 0,
            removed: true,
          },
        };
        if (
          priorReviewReceipt &&
          (priorReviewReceipt.contextSha256 !== reviewContextReceipt.contextSha256 ||
            priorReviewReceipt.pagesSha256 !== reviewContextReceipt.pagesSha256 ||
            priorReviewReceipt.sealDigest !== reviewContextReceipt.sealDigest ||
            priorReviewReceipt.baseOid !== reviewContextReceipt.baseOid ||
            priorReviewReceipt.sourceOid !== reviewContextReceipt.sourceOid)
        )
          throw new Error('Sealed review context replay changed');
      }
      this.deps.store.withSymposiumArtifactSealSnapshot(intent, () => {
        const updated = this.db
          .prepare(
            "UPDATE symposium_seal_export_jobs SET state='complete',result_hash=?,receipt_json=? WHERE job_id=? AND state='removed'",
          )
          .run(
            hash(output),
            successorReceipt
              ? canonicalReviewJson(successorReceipt)
              : reviewContextReceipt
                ? canonicalReviewJson(reviewContextReceipt)
                : null,
            jobId,
          );
        if (updated.changes !== 1) throw new Error('Sealed export journal changed');
      });
      return reviewContextReceipt
        ? { ...value, receipt: reviewContextReceipt }
        : successorReceipt
          ? { ...value, receipt: successorReceipt }
          : input.kind === 'check'
            ? {
                ...value,
                checkReceipt: {
                  executionId: jobId,
                  sealFenceId: receipt.fenceId,
                  sealDigest: reviewRecordHash(canonicalReviewJson(receipt)),
                  artifactRevision: receipt.git.commit,
                  artifactHash: receipt.git.committedTreeDigest,
                  observedSha256: value.observedSha256,
                  completedAt: Date.now(),
                },
              }
            : value;
    } catch (error) {
      if (!id && error instanceof ArtifactCommandNotDispatched) {
        this.db
          .prepare(
            "UPDATE symposium_seal_export_jobs SET state='not_dispatched' WHERE job_id=? AND state='create_uncertain' AND container_id IS NULL",
          )
          .run(jobId);
      }
      if (helperDeleted) {
        this.db
          .prepare(
            "UPDATE symposium_seal_export_jobs SET state='failed_cleaned' WHERE job_id=? AND state='removed'",
          )
          .run(jobId);
      }
      if (id && !helperRemovalObserved) {
        try {
          await cleanup();
          this.db
            .prepare("UPDATE symposium_seal_export_jobs SET state='failed_cleaned' WHERE job_id=?")
            .run(jobId);
        } catch {
          /* Exact helper remains journaled; never infer absence from an error. */
        }
      }
      // eslint-disable-next-line preserve-caught-error -- Parser/transport causes may contain private bundle bytes.
      throw new Error(
        'Sealed artifact export failed; retained helper state may require reconciliation',
      );
    }
  }

  async seal(
    raw: PhysicalArtifactSealInput,
    runtime: object,
    signal: AbortSignal,
  ): Promise<CompletedArtifactSeal> {
    const input = inputSchema.parse(raw);
    signal.throwIfAborted();
    await this.custody();
    const { store, leaseHost, gateway } = this.deps;
    assertSymposiumRuntimeForArtifactSeal(runtime, store, leaseHost, input.sessionId);
    const custodyDigest = hash(gateway.stateDirectory);
    const config = store.getActiveSymposiumConfig(input.sessionId);
    if (config.version !== 2 || config.revision !== input.expectedConfigRevision)
      throw new Error('Artifact seal configuration is stale');
    const allRecords = store.listSymposiumSessionSandboxes(input.sessionId);
    const requestJson = JSON.stringify(input);
    const retainedJobs = this.db
      .prepare('SELECT * FROM symposium_physical_seal_jobs WHERE request_json=?')
      .all(requestJson) as Array<{
      fence_id: string;
      custody_digest: string;
      phase: string;
      records_json: string;
      verifier_name: string;
      verifier_id: string | null;
      receipt_json: string | null;
    }>;
    if (retainedJobs.length > 1) throw new Error('Artifact seal retained identity is ambiguous');
    const retained = retainedJobs[0];
    let request: NonNullable<ReturnType<SqliteArtifactLeaseHost['retainedCleanupRequest']>>;
    let intent: SymposiumArtifactSealIntent;
    let retention: NonNullable<ReturnType<SqliteArtifactLeaseHost['pendingArtifactRetention']>>;
    let records: SymposiumSeatSandboxRecord[];
    let verifierName: string;
    if (retained) {
      intent = store.getSymposiumArtifactSealByFence(retained.fence_id)!;
      if (
        !intent ||
        retained.custody_digest !== custodyDigest ||
        intent.selection.sessionId !== input.sessionId ||
        intent.selection.expectedConfigRevision !== input.expectedConfigRevision ||
        intent.selection.idempotencyKey !== input.idempotencyKey ||
        intent.selection.custody.workspaceId !== gateway.workspace ||
        intent.selection.custody.gatewayLaunchDigest !== custodyDigest ||
        intent.selection.artifact.driver !== 'podman' ||
        !/^mitzo-seal-[a-f0-9-]{36}$/.test(retained.verifier_name)
      )
        throw new Error('Artifact seal retained identity changed');
      if (retained.phase === 'complete') return this.requireCompleted(retained.fence_id, signal);
      if (
        intent.status !== 'pending_unsealed' ||
        retained.phase !== 'draining' ||
        retained.verifier_id !== null ||
        retained.receipt_json !== null
      )
        throw new Error('Artifact seal retained phase requires explicit reconciliation');
      const parsed: unknown = JSON.parse(retained.records_json);
      if (!Array.isArray(parsed) || !parsed.length)
        throw new Error('Artifact seal retained writer records are invalid');
      records = parsed as SymposiumSeatSandboxRecord[];
      const writerRecords = records.filter(
        (row) =>
          config.seats.find((seat) => seat.id === row.seatId)?.authorityGrant?.filesystem ===
          'write',
      );
      if (writerRecords.length !== 1)
        throw new Error('Artifact seal retained writer identity changed');
      const writerRecord = writerRecords[0];
      request = leaseHost.retainedCleanupRequest(writerRecord)!;
      retention = leaseHost.pendingArtifactRetention(
        'podman',
        intent.selection.artifact.volumeName,
      )!;
      const released = this.db
        .prepare(
          'SELECT token,revision,request_json,sandbox_name,sandbox_id FROM symposium_artifact_release_receipts WHERE sandbox_name=? AND sandbox_id=?',
        )
        .all(writerRecord.sandboxName, writerRecord.physicalId) as Array<{
        token: string;
        revision: string;
        request_json: string;
        sandbox_name: string;
        sandbox_id: string;
      }>;
      const live = leaseHost
        .sealLeaseIdentities('podman', intent.selection.artifact.volumeName)
        .filter(
          (row) =>
            row.sandboxName === writerRecord.sandboxName &&
            row.sandboxId === writerRecord.physicalId,
        );
      const exactReleased =
        released.length === 1 &&
        released[0].revision === intent.selection.artifact.leaseRevision &&
        hash(released[0].token) === intent.selection.artifact.leaseTokenHash &&
        released[0].request_json === JSON.stringify(request);
      const exactLive =
        live.length === 1 &&
        live[0].revision === intent.selection.artifact.leaseRevision &&
        live[0].tokenHash === intent.selection.artifact.leaseTokenHash &&
        isDeepStrictEqual(live[0].request, request) &&
        live[0].creationStarted &&
        live[0].intendedSandboxName === writerRecord.sandboxName;
      if (
        !request ||
        request.access !== 'writer' ||
        request.driver !== 'podman' ||
        request.sessionId !== input.sessionId ||
        request.workspaceId !== gateway.workspace ||
        request.volumeName !== intent.selection.artifact.volumeName ||
        request.volumeGeneration !== intent.selection.artifact.volumeGeneration ||
        !retention ||
        retention.status !== 'pending_unsealed' ||
        retention.fenceId !== intent.fenceId ||
        !isDeepStrictEqual(retention.intent, intent) ||
        retention.writerSandboxId !== writerRecord.physicalId ||
        retention.writerSandboxName !== writerRecord.sandboxName ||
        exactReleased === exactLive ||
        allRecords.filter((row) => row.creationStarted).length !== records.length ||
        records.some((record) => {
          const current = allRecords.find(
            (row) => row.seatId === record.seatId && row.generation === record.generation,
          );
          return (
            !current ||
            !record.creationCompleted ||
            !record.physicalId ||
            !record.sandboxName ||
            !isDeepStrictEqual({ ...record, state: current.state }, current)
          );
        })
      )
        throw new Error('Artifact seal retained physical identity changed');
      verifierName = retained.verifier_name;
    } else {
      const activeRecords = allRecords.filter((row) => row.state !== 'stopped');
      const writerRecords = activeRecords.filter(
        (row) =>
          config.seats.find((s) => s.id === row.seatId)?.authorityGrant?.filesystem === 'write',
      );
      if (writerRecords.length !== 1)
        throw new Error('Artifact seal requires one exact retained writer');
      const writerRecord = writerRecords[0];
      const selected = leaseHost.retainedCleanupRequest(writerRecord);
      if (!selected || selected.access !== 'writer' || selected.driver !== 'podman')
        throw new Error('Artifact writer lease unavailable');
      request = selected;
      const leases = leaseHost.sealLeaseIdentities(request.driver, request.volumeName);
      const writer = leases.find(
        (row) => row.sandboxId === writerRecord.physicalId && row.request.access === 'writer',
      );
      if (!writer) throw new Error('Artifact seal writer lease identity changed');
      intent = store.beginSymposiumArtifactSeal({
        sessionId: input.sessionId,
        expectedConfigRevision: input.expectedConfigRevision,
        idempotencyKey: input.idempotencyKey,
        custody: { workspaceId: gateway.workspace, gatewayLaunchDigest: custodyDigest },
        artifact: {
          driver: 'podman',
          volumeName: request.volumeName,
          volumeGeneration: request.volumeGeneration,
          leaseRevision: writer.revision,
          leaseTokenHash: writer.tokenHash,
        },
      });
      if (intent.selection.custody.gatewayLaunchDigest !== custodyDigest)
        throw new Error('Artifact seal belongs to another gateway custody');
      retention = leaseHost.beginPendingArtifactRetention(
        store,
        input.sessionId,
        request.volumeGeneration,
      );
      // All leases, including old generations/readers, must match a completed physical create.
      const leasedRecords = leases.map((lease) => {
        const matches = allRecords.filter(
          (r) =>
            r.sandboxName === lease.sandboxName &&
            r.physicalId === lease.sandboxId &&
            r.seatId === lease.request.seatId &&
            r.workspace === lease.request.workspaceId,
        );
        if (
          lease.request.sessionId !== input.sessionId ||
          lease.request.volumeGeneration !== request.volumeGeneration ||
          !lease.creationStarted ||
          !lease.sandboxId ||
          lease.intendedSandboxName !== lease.sandboxName ||
          matches.length !== 1 ||
          !matches[0].creationCompleted
        )
          throw new Error('Artifact seal has orphan or uncertain lease identity');
        return matches[0];
      });
      if (
        activeRecords.some(
          (row) =>
            !leasedRecords.some((r) => r.seatId === row.seatId && r.generation === row.generation),
        )
      )
        throw new Error('Artifact seal has an unaccounted seat sandbox');
      records = allRecords.filter((row) => row.creationStarted);
      if (records.some((row) => !row.creationCompleted || !row.physicalId || !row.sandboxName))
        throw new Error('Artifact seal includes uncertain prior creation');
      verifierName = `mitzo-seal-${randomUUID()}`;
      this.db
        .transaction(() => {
          if (
            this.db
              .prepare('SELECT 1 FROM symposium_physical_seal_jobs WHERE fence_id=?')
              .get(intent.fenceId)
          )
            throw new Error('Artifact seal has retained work; explicit recovery is required');
          this.db
            .prepare('INSERT INTO symposium_physical_seal_jobs VALUES(?,?,?,?,?,?,NULL,NULL)')
            .run(
              intent.fenceId,
              requestJson,
              custodyDigest,
              'draining',
              JSON.stringify(records),
              verifierName,
            );
        })
        .immediate();
    }
    const membershipSnapshot = () =>
      [
        ...new Map(
          store
            .getSymposiumMembershipHistory(input.sessionId)
            .sort((a, b) => a.generation - b.generation)
            .map((member) => [member.seatId, member]),
        ).values(),
      ]
        .map((member) => ({
          seatId: member.seatId,
          generation: member.generation,
          state: member.state,
          reconciliation: member.reconciliation,
          bindingDigest: hash(JSON.stringify(member.bindingKey)),
        }))
        .sort((a, b) => a.seatId.localeCompare(b.seatId));
    const check = async () => {
      signal.throwIfAborted();
      await this.custody();
      assertSessionArtifactVolume(
        gateway.workspace,
        {
          sessionId: input.sessionId,
          volumeName: request.volumeName,
          volumeGeneration: request.volumeGeneration,
        },
        await leaseHost.inspectVolume(request.volumeName, 'podman'),
      );
      if (
        JSON.stringify(
          store.getSymposiumArtifactSealIntent(input.sessionId, request.volumeGeneration),
        ) !== JSON.stringify(intent) ||
        JSON.stringify(leaseHost.pendingArtifactRetention('podman', request.volumeName)) !==
          JSON.stringify(retention) ||
        hash(JSON.stringify(store.getActiveSymposiumConfig(input.sessionId))) !==
          intent.configDigest ||
        JSON.stringify(membershipSnapshot()) !== JSON.stringify(intent.memberships)
      )
        throw new Error('Artifact seal identity changed');
    };
    await check();
    // The durable phase may precede or follow physical cleanup. Replaying the
    // exact retained runtime drain reconciles only its original seat identities.
    await drainSymposiumRuntimeForArtifactSeal(runtime, store, leaseHost, input.sessionId, signal);
    const drained = () => {
      for (const seat of new Set([
        ...config.seats.map((s) => s.id),
        ...store.getSymposiumMembershipHistory(input.sessionId).map((m) => m.seatId),
      ]))
        if (store.getUnsettledSymposiumSeatExecutions(input.sessionId, seat).length)
          throw new Error('Artifact seal has unsettled attempts');
      if (
        leaseHost.sealLeaseIdentities('podman', request.volumeName).length ||
        this.deps.attemptRegistry.pending().some((row) => row.sessionId === input.sessionId) ||
        this.deps.attemptRegistry
          .pendingPreparations()
          .some((row) => row.sessionId === input.sessionId)
      )
        throw new Error('Artifact seal drain is incomplete');
      for (const record of records) {
        const current = store.getSymposiumSeatSandbox(
          record.sessionId,
          record.seatId,
          record.generation,
        );
        if (
          !current ||
          current.state !== 'stopped' ||
          current.physicalId !== record.physicalId ||
          store.getUnsettledSymposiumSeatExecutions(input.sessionId, record.seatId).length
        )
          throw new Error('Artifact seal terminal cleanup is incomplete');
      }
    };
    drained();
    await this.absent(records, signal);
    await this.noVolumeMounts(request.volumeName);
    await check();
    await this.noVerifierName(verifierName);
    // A resumed seal and an overlapping original handler compete for this one
    // durable transition. Only the winner may create the physical verifier.
    const claimed = this.db
      .prepare(
        "UPDATE symposium_physical_seal_jobs SET phase='verifier_create_uncertain' WHERE fence_id=? AND phase='draining' AND request_json=? AND custody_digest=? AND verifier_id IS NULL AND receipt_json IS NULL",
      )
      .run(intent.fenceId, requestJson, custodyDigest);
    if (claimed.changes !== 1)
      throw new Error('Artifact seal verifier creation is already claimed or uncertain');
    await this.noVerifierName(verifierName);
    const created = (
      await this.command([
        'create',
        '--pull=never',
        '--name',
        verifierName,
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user',
        'sandbox',
        '--pids-limit=32',
        '--memory=256m',
        '--cpus=1',
        '--mount',
        `type=volume,src=${request.volumeName},dst=${SYMPOSIUM_ARTIFACT_TARGET},readonly`,
        '--entrypoint=/usr/bin/python3',
        TESTED_SYMPOSIUM_NATIVE_BUILD.image,
        '-I',
        '-c',
        ARTIFACT_GIT_VERIFIER,
        input.repositoryPath,
      ])
    ).trim();
    if (!containerId.test(created))
      throw new Error('Artifact verifier create identity is uncertain');
    this.db
      .prepare(
        "UPDATE symposium_physical_seal_jobs SET verifier_id=?,phase='verifier_created' WHERE fence_id=?",
      )
      .run(created, intent.fenceId);
    await check();
    const verifyContainer = async () => {
      const value: unknown = JSON.parse(await this.command(['inspect', created]));
      if (!Array.isArray(value) || value.length !== 1)
        throw new Error('Artifact verifier identity changed');
      const c = value[0];
      if (
        c.Id !== created ||
        c.ImageName !== TESTED_SYMPOSIUM_NATIVE_BUILD.image ||
        c.HostConfig?.NetworkMode !== 'none' ||
        c.HostConfig?.ReadonlyRootfs !== true ||
        c.HostConfig?.Privileged !== false ||
        c.Config?.User !== 'sandbox' ||
        !Array.isArray(c.Mounts) ||
        c.Mounts.length !== 1 ||
        c.Mounts[0].Type !== 'volume' ||
        c.Mounts[0].Name !== request.volumeName ||
        c.Mounts[0].Destination !== SYMPOSIUM_ARTIFACT_TARGET ||
        c.Mounts[0].RW !== false
      )
        throw new Error('Artifact verifier isolation changed');
      return c;
    };
    await verifyContainer();
    const output = await this.command(['start', '--attach', created]);
    if (Buffer.byteLength(output) > 8192) throw new Error('Artifact Git proof exceeds bound');
    const proof = gitProofSchema.parse(JSON.parse(output));
    await verifyContainer();
    const inspected: unknown = JSON.parse(await this.command(['inspect', created]));
    if (
      !Array.isArray(inspected) ||
      inspected.length !== 1 ||
      inspected[0].Id !== created ||
      inspected[0].State?.Running !== false ||
      inspected[0].State?.ExitCode !== 0
    )
      throw new Error('Artifact verifier terminal exit is unconfirmed');
    const verifierMounts = inspected[0].Mounts;
    if (
      !Array.isArray(verifierMounts) ||
      verifierMounts.filter(
        (m) =>
          m.Type === 'volume' &&
          m.Name === request.volumeName &&
          m.Destination === SYMPOSIUM_ARTIFACT_TARGET &&
          m.RW === false,
      ).length !== 1
    )
      throw new Error('Artifact verifier physical mount changed');
    this.db
      .prepare("UPDATE symposium_physical_seal_jobs SET phase='verifier_terminal' WHERE fence_id=?")
      .run(intent.fenceId);
    await this.command(['rm', created]);
    this.db
      .prepare("UPDATE symposium_physical_seal_jobs SET phase='verifier_removed' WHERE fence_id=?")
      .run(intent.fenceId);
    if ((await this.census()).some((row) => row.id === created))
      throw new Error('Artifact verifier deletion is uncertain');
    await this.absent(records, signal);
    await this.noVolumeMounts(request.volumeName);
    drained();
    await check();
    const receipt: CompletedArtifactSeal = {
      kind: 'completed_artifact_seal',
      version: 1,
      fenceId: intent.fenceId,
      sessionId: input.sessionId,
      custodyDigest,
      intentDigest: hash(JSON.stringify(intent)),
      retentionDigest: hash(JSON.stringify(retention)),
      revocationDigest: hash(JSON.stringify(records)),
      repositoryPath: input.repositoryPath,
      git: proof,
      verifier: {
        id: created,
        image: TESTED_SYMPOSIUM_NATIVE_BUILD.image,
        codeDigest: hash(ARTIFACT_GIT_VERIFIER),
      },
      completedAt: Date.now(),
    };
    store.withSymposiumArtifactSealSnapshot(intent, () => {
      this.db
        .transaction(() => {
          const changed = this.db
            .prepare(
              "UPDATE symposium_physical_seal_jobs SET phase='complete',receipt_json=? WHERE fence_id=? AND phase='verifier_removed' AND verifier_id=? AND custody_digest=? AND receipt_json IS NULL",
            )
            .run(JSON.stringify(receipt), intent.fenceId, created, custodyDigest);
          if (changed.changes !== 1) throw new Error('Artifact seal completion identity changed');
        })
        .immediate();
    });
    return receipt;
  }
}
