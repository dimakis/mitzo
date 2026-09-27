import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import { z } from 'zod';
import { ARTIFACT_SCANNER } from './symposium-artifact-scanner.js';
import { SqliteArtifactLeaseHost } from './symposium-artifact-host.js';
import {
  artifactDriverConfigForLease,
  type ArtifactLeaseRequest,
} from './symposium-artifact-lease.js';
import { TESTED_SYMPOSIUM_NATIVE_BUILD } from './symposium-production-gate.js';

export const ARTIFACT_SNAPSHOT_LIMITS = {
  entries: 10_000,
  bytes: 64 * 1024 * 1024,
  seconds: 20,
  outputBytes: 8 * 1024 * 1024,
} as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const entrySchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (path) =>
          !path.startsWith('/') &&
          !path.includes('\\') &&
          ![...path].some(
            (c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff),
          ) &&
          path.split('/').every((p) => p !== '' && p !== '.' && p !== '..') &&
          path.split('/')[0] !== '.git',
      ),
    executable: z.boolean(),
    bytes: z.number().int().min(0).max(ARTIFACT_SNAPSHOT_LIMITS.bytes),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type ManifestEntry = z.infer<typeof entrySchema>;
export interface ArtifactSnapshotInput {
  request: ArtifactLeaseRequest;
  sandboxName: string;
  sandboxId: string;
}
export interface ArtifactSnapshotObservation {
  kind: 'artifact_snapshot_observation';
  version: 1;
  /** Never a claim of global quiescence, WorkResult, ReviewReceipt, or budget proof. */
  consistency: 'unfenced_observation';
  revision: string;
  digest: string;
  request: ArtifactLeaseRequest;
  sandboxName: string;
  sandboxId: string;
  leaseRevision: string;
  leaseTokenHash: string;
  image: string;
  scannerSha256: string;
  manifest: ManifestEntry[];
  observedAt: number;
  gateway: { name: string; workspace: string; endpoint: string; launchDirectoryHash: string };
}
export type ArtifactSnapshotCommand = (args: readonly string[]) => Promise<string>;

/** Host-only dormant prerequisite. No application route or execution hook installs
 * this observer. A later integration must supply a durable other-writer fence.
 */
export class ArtifactSnapshotObserver {
  private readonly db: Database.Database;
  private readonly command: ArtifactSnapshotCommand;
  constructor(
    private readonly options: {
      databasePath: string;
      leaseHost: SqliteArtifactLeaseHost;
      /** Real retained-host custody verification, not a caller-supplied assertion. */
      verifyCustody: () => Promise<void>;
      gateway: ArtifactSnapshotObservation['gateway'];
    },
  ) {
    this.command = options.leaseHost.snapshotCommand();
    this.db = new Database(options.databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS artifact_snapshot_verifiers (singleton INTEGER PRIMARY KEY CHECK(singleton=1), name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_snapshot_observations (revision TEXT PRIMARY KEY, receipt TEXT NOT NULL);`);
  }
  private async cleanup(name: string): Promise<void> {
    try {
      await this.command(['rm', '--force', '--ignore', name]);
    } catch {
      throw new Error('Artifact verifier cleanup is uncertain; reconciliation required');
    }
  }
  close(): void {
    this.db.close();
  }
  read(revision: string): ArtifactSnapshotObservation | null {
    const row = this.db
      .prepare('SELECT receipt FROM artifact_snapshot_observations WHERE revision=?')
      .get(revision) as { receipt: string } | undefined;
    return row ? JSON.parse(row.receipt) : null;
  }
  list(): ArtifactSnapshotObservation[] {
    return (
      this.db
        .prepare('SELECT receipt FROM artifact_snapshot_observations ORDER BY rowid')
        .all() as { receipt: string }[]
    ).map((row) => JSON.parse(row.receipt));
  }
  async observe(input: ArtifactSnapshotInput): Promise<ArtifactSnapshotObservation> {
    // Clone before yielding so even host callers cannot change identity mid-flight.
    const selection: ArtifactSnapshotInput = structuredClone(input);
    if (selection.request.workspaceId !== this.options.gateway.workspace)
      throw new Error('Artifact snapshot workspace differs from retained gateway');
    if (selection.request.driver !== 'podman')
      throw new Error('Snapshot requires retained Podman volume');
    const name = `mitzo-artifact-observer-${randomUUID()}`;
    this.db
      .transaction(() => {
        if (this.db.prepare('SELECT 1 FROM artifact_snapshot_verifiers').get())
          throw new Error('Artifact verifier requires reconciliation');
        this.db
          .prepare('INSERT INTO artifact_snapshot_verifiers(singleton,name) VALUES(1,?)')
          .run(name);
      })
      .immediate();
    let createAttempted = false;
    let manifest: ManifestEntry[];
    let initialLease: Awaited<ReturnType<SqliteArtifactLeaseHost['requireBoundSandboxLease']>>;
    const verify = async () => {
      await this.options.verifyCustody();
      const lease = await this.options.leaseHost.requireBoundSandboxLease(
        selection.request,
        selection.sandboxName,
        selection.sandboxId,
      );
      const config = await artifactDriverConfigForLease(this.options.leaseHost, lease);
      await this.options.leaseHost.verifyPhysicalMount(
        selection.sandboxName,
        selection.sandboxId,
        config,
      );
      if (
        initialLease &&
        (lease.revision !== initialLease.revision || lease.token !== initialLease.token)
      )
        throw new Error('Artifact snapshot lease changed');
      await this.options.verifyCustody();
      return lease;
    };
    try {
      initialLease = await verify();
      createAttempted = true;
      await this.command([
        'create',
        '--pull=never',
        '--name',
        name,
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--pids-limit=32',
        '--memory=256m',
        '--cpus=1',
        '--mount',
        `type=volume,src=${selection.request.volumeName},dst=/sandbox/symposium-artifacts,readonly`,
        '--entrypoint=/usr/bin/python3',
        TESTED_SYMPOSIUM_NATIVE_BUILD.image,
        '-I',
        '-c',
        ARTIFACT_SCANNER,
        '/sandbox/symposium-artifacts',
        String(ARTIFACT_SNAPSHOT_LIMITS.entries),
        String(ARTIFACT_SNAPSHOT_LIMITS.bytes),
        String(ARTIFACT_SNAPSHOT_LIMITS.seconds),
      ]);
      const output = await this.command(['start', '--attach', name]);
      const status = z
        .array(z.object({ State: z.object({ Running: z.literal(false), ExitCode: z.literal(0) }) }))
        .length(1)
        .safeParse(JSON.parse(await this.command(['inspect', name])));
      if (!status.success) throw new Error('Artifact verifier exit was not successful');
      if (Buffer.byteLength(output) > ARTIFACT_SNAPSHOT_LIMITS.outputBytes)
        throw new Error('Artifact verifier output limit');
      manifest = z
        .array(entrySchema)
        .max(ARTIFACT_SNAPSHOT_LIMITS.entries)
        .parse(JSON.parse(output));
      let bytes = 0;
      const paths = new Set<string>();
      for (const entry of manifest) {
        bytes += entry.bytes;
        if (paths.has(entry.path) || bytes > ARTIFACT_SNAPSHOT_LIMITS.bytes)
          throw new Error('Invalid artifact manifest');
        paths.add(entry.path);
      }
      manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      await verify();
    } finally {
      // Attempt exact cleanup even if create timed out after creating the resource.
      // Failure retains the durable reservation; a restart cannot silently retry.
      if (createAttempted) {
        await this.cleanup(name);
      }
      this.db
        .prepare('DELETE FROM artifact_snapshot_verifiers WHERE singleton=1 AND name=?')
        .run(name);
    }
    await verify();
    const receipt: ArtifactSnapshotObservation = {
      kind: 'artifact_snapshot_observation',
      version: 1,
      consistency: 'unfenced_observation',
      revision: randomUUID(),
      digest: hash(JSON.stringify(manifest)),
      ...selection,
      leaseRevision: initialLease.revision,
      leaseTokenHash: hash(initialLease.token),
      image: TESTED_SYMPOSIUM_NATIVE_BUILD.image,
      scannerSha256: hash(ARTIFACT_SCANNER),
      manifest,
      observedAt: Date.now(),
      gateway: structuredClone(this.options.gateway),
    };
    this.db
      .prepare('INSERT INTO artifact_snapshot_observations(revision,receipt) VALUES(?,?)')
      .run(receipt.revision, JSON.stringify(receipt));
    return receipt;
  }
}

/** Explicit host construction only; never invoked automatically by app bootstrap. */
export function createOwnedArtifactSnapshotObserver(options: {
  databasePath: string;
  gateway: OwnedSymposiumGateway;
  leaseHost: SqliteArtifactLeaseHost;
}): ArtifactSnapshotObserver {
  const gateway = options.gateway;
  return new ArtifactSnapshotObserver({
    databasePath: options.databasePath,
    leaseHost: options.leaseHost,
    verifyCustody: () => gateway.verifyCustodyAsync(),
    gateway: {
      name: gateway.gateway,
      workspace: gateway.workspace,
      endpoint: gateway.endpoint,
      launchDirectoryHash: hash(gateway.stateDirectory),
    },
  });
}
