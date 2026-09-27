import { assertSessionArtifactVolume } from './symposium-session-artifacts.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from './symposium-artifact-lease.js';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EventStore } from './event-store.js';
import type { SymposiumSeatSandboxRecord } from '@mitzo/protocol/event-store';
import { SqliteArtifactLeaseHost } from './symposium-artifact-host.js';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import type { SymposiumAttemptRegistry } from './symposium-attempt-registry.js';
import { drainSymposiumRuntimeForArtifactSeal } from './symposium-session-runtime.js';
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

/** Concrete host-only operation. No request route installs it and no model runs here.
 * Stable pending locks never imply reconstructed custody on a new gateway lifetime.
 */
export class PhysicalArtifactSealer {
  private readonly db: Database.Database;
  private readonly command: (args: readonly string[]) => Promise<string>;
  constructor(
    private readonly deps: {
      store: EventStore;
      leaseHost: SqliteArtifactLeaseHost;
      gateway: OwnedSymposiumGateway;
      attemptRegistry: SymposiumAttemptRegistry;
      runtimeConfig: OpenShellRuntimeConfig;
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
    if (!Array.isArray(rows) || rows.length > 128)
      throw new Error('Artifact volume census is unavailable');
    const ids = rows.map((row) => {
      const id = String(row?.Id ?? row?.ID ?? '');
      if (!containerId.test(id)) throw new Error('Artifact census identity is invalid');
      return id;
    });
    if (new Set(ids).size !== ids.length)
      throw new Error('Artifact census contains duplicate identities');
    const result: Array<{
      id: string;
      mounts: Array<{ Type: string; Name?: string; RW: boolean }>;
    }> = [];
    for (const id of ids) {
      if (Date.now() - started > 20000) throw new Error('Artifact census exceeded time bound');
      const inspected: unknown = JSON.parse(await this.command(['inspect', id]));
      if (
        !Array.isArray(inspected) ||
        inspected.length !== 1 ||
        inspected[0].Id !== id ||
        !Array.isArray(inspected[0].Mounts)
      )
        throw new Error('Artifact census inspection changed');
      const mounts = inspected[0].Mounts;
      for (const mount of mounts)
        if (
          typeof mount.Type !== 'string' ||
          typeof mount.RW !== 'boolean' ||
          (mount.Type === 'volume' && typeof mount.Name !== 'string')
        )
          throw new Error('Artifact mount census is incomplete');
      result.push({ id, mounts });
    }
    return result;
  }
  private async noVolumeMounts(volume: string) {
    if (
      (await this.census()).some((row) =>
        row.mounts.some((m) => m.Type === 'volume' && m.Name === volume),
      )
    )
      throw new Error('Artifact volume still has physical mounts');
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
    const intent = this.deps.store.getSymposiumArtifactSealIntent(receipt.sessionId);
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
    if (
      !retention ||
      receipt.retentionDigest !== hash(JSON.stringify(retention)) ||
      this.deps.leaseHost.sealLeaseIdentities('podman', intent.selection.artifact.volumeName).length
    )
      throw new Error('Completed artifact retention changed');
    const records = JSON.parse(row.records_json) as SymposiumSeatSandboxRecord[];
    if (
      receipt.revocationDigest !== hash(JSON.stringify(records)) ||
      this.deps.attemptRegistry.pending().some((row) => row.sessionId === receipt.sessionId)
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
        this.deps.store.getUnsettledSymposiumSeatExecutions(record.sessionId, record.seatId).length
      )
        throw new Error('Completed artifact terminal cleanup changed');
    }
    await this.absent(records, signal);
    await this.noVolumeMounts(intent.selection.artifact.volumeName);
    if ((await this.census()).some((row) => row.id === receipt.verifier.id))
      throw new Error('Completed artifact verifier remains');
    await this.custody();
    signal.throwIfAborted();
    this.deps.store.withSymposiumArtifactSealSnapshot(intent, () => {});
    return structuredClone(receipt);
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
    const custodyDigest = hash(gateway.stateDirectory);
    const config = store.getActiveSymposiumConfig(input.sessionId);
    if (config.version !== 2 || config.revision !== input.expectedConfigRevision)
      throw new Error('Artifact seal configuration is stale');
    const allRecords = store.listSymposiumSessionSandboxes(input.sessionId);
    const activeRecords = allRecords.filter((row) => row.state !== 'stopped');
    const writerRecords = activeRecords.filter(
      (row) =>
        config.seats.find((s) => s.id === row.seatId)?.authorityGrant?.filesystem === 'write',
    );
    if (writerRecords.length !== 1)
      throw new Error('Artifact seal requires one exact retained writer');
    const writerRecord = writerRecords[0];
    const request = leaseHost.retainedCleanupRequest(writerRecord);
    if (!request || request.access !== 'writer' || request.driver !== 'podman')
      throw new Error('Artifact writer lease unavailable');
    const leases = leaseHost.sealLeaseIdentities(request.driver, request.volumeName);
    const writer = leases.find(
      (row) => row.sandboxId === writerRecord.physicalId && row.request.access === 'writer',
    );
    if (!writer) throw new Error('Artifact seal writer lease identity changed');
    const intent = store.beginSymposiumArtifactSeal({
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
    const retention = leaseHost.beginPendingArtifactRetention(store, input.sessionId);
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
    const records = allRecords.filter((row) => row.creationStarted);
    if (records.some((row) => !row.creationCompleted || !row.physicalId || !row.sandboxName))
      throw new Error('Artifact seal includes uncertain prior creation');
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
    const requestJson = JSON.stringify(input);
    const verifierName = `mitzo-seal-${randomUUID()}`;
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
        JSON.stringify(store.getSymposiumArtifactSealIntent(input.sessionId)) !==
          JSON.stringify(intent) ||
        JSON.stringify(leaseHost.pendingArtifactRetention('podman', request.volumeName)) !==
          JSON.stringify(retention) ||
        hash(JSON.stringify(store.getActiveSymposiumConfig(input.sessionId))) !==
          intent.configDigest ||
        JSON.stringify(membershipSnapshot()) !== JSON.stringify(intent.memberships)
      )
        throw new Error('Artifact seal identity changed');
    };
    await check();
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
        this.deps.attemptRegistry.pending().some((row) => row.sessionId === input.sessionId)
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
    this.db
      .prepare(
        "UPDATE symposium_physical_seal_jobs SET phase='verifier_create_uncertain' WHERE fence_id=?",
      )
      .run(intent.fenceId);
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
              "UPDATE symposium_physical_seal_jobs SET phase='complete',receipt_json=? WHERE fence_id=? AND phase='verifier_terminal' AND verifier_id=? AND custody_digest=? AND receipt_json IS NULL",
            )
            .run(JSON.stringify(receipt), intent.fenceId, created, custodyDigest);
          if (changed.changes !== 1) throw new Error('Artifact seal completion identity changed');
        })
        .immediate();
    });
    return receipt;
  }
}
