import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  ArtifactDriver,
  ArtifactDriverConfig,
  ArtifactLease,
  ArtifactLeaseHost,
  ArtifactLeaseRequest,
  ArtifactVolumeEvidence,
} from './symposium-artifact-lease.js';

interface LeaseRow {
  token: string;
  revision: string;
  request_json: string;
  sandbox_id: string | null;
  sandbox_name: string | null;
  intended_sandbox_name: string | null;
  creation_started: number;
}

export interface ArtifactHostEvidence {
  /** Must attest the selected gateway and workspace, including allow_driver_config=true. */
  verifyGateway(request: ArtifactLeaseRequest, config: ArtifactDriverConfig): Promise<void>;
  /** Must inspect the selected compute driver's physical mount, not just CLI labels. */
  verifyMount(sandboxName: string, sandboxId: string, config: ArtifactDriverConfig): Promise<void>;
  /** Must prove the exact physical sandbox was deleted and cannot restart. */
  verifyDeleted?(sandboxName: string, sandboxId: string): Promise<void>;
}

export type VolumeRunner = (driver: ArtifactDriver, name: string) => Promise<unknown>;
const safeName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Uses argv rather than a shell and never accepts an arbitrary engine name. */
export const inspectLocalArtifactVolume: VolumeRunner = (driver, name) => {
  if ((driver !== 'podman' && driver !== 'docker') || !safeName.test(name))
    throw new Error('Invalid artifact volume inspection request');
  return new Promise((resolve, reject) => {
    execFile(driver, ['volume', 'inspect', '--format', 'json', name], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
    });
  });
};

function volumeEvidence(raw: unknown, name: string): ArtifactVolumeEvidence {
  const item = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw;
  if (!item || typeof item !== 'object' || Array.isArray(item))
    throw new Error('Invalid artifact volume inspection result');
  const value = item as Record<string, unknown>;
  const labels = value.Labels ?? value.labels;
  const options = value.Options ?? value.options;
  if (value.Name !== name && value.name !== name) throw new Error('Artifact volume name changed');
  if (value.Driver !== 'local' && value.driver !== 'local')
    throw new Error('Artifact volume is not a local named volume');
  if (!labels || typeof labels !== 'object' || Array.isArray(labels) ||
      !options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('Artifact volume labels or options are unavailable');
  if (Object.values(labels).some((v) => typeof v !== 'string') ||
      Object.values(options).some((v) => typeof v !== 'string'))
    throw new Error('Invalid artifact volume labels or options');
  return { name, driver: 'local', labels: labels as Record<string, string>,
    options: options as Record<string, string> };
}

/** SQLite is the serialization point across workers and process restarts.
 * Leases never expire automatically. A crash leaves a closed reservation until
 * the exact sandbox stop is attested or an operator reconciles it.
 */
export class SqliteArtifactLeaseHost implements ArtifactLeaseHost {
  private readonly db: Database.Database;

  constructor(
    dbPath: string,
    private readonly evidence: ArtifactHostEvidence,
    private readonly volumeRunner: VolumeRunner = inspectLocalArtifactVolume,
  ) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS symposium_artifact_leases (
      token TEXT PRIMARY KEY,
      revision TEXT NOT NULL,
      driver TEXT NOT NULL,
      volume_name TEXT NOT NULL,
      access TEXT NOT NULL,
      request_json TEXT NOT NULL,
      sandbox_name TEXT,
      sandbox_id TEXT,
      intended_sandbox_name TEXT,
      creation_started INTEGER NOT NULL DEFAULT 1 CHECK (creation_started IN (0, 1)),
      created_at INTEGER NOT NULL,
      CHECK ((sandbox_name IS NULL) = (sandbox_id IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS symposium_artifact_one_writer
      ON symposium_artifact_leases(driver, volume_name) WHERE access = 'writer';`);
    // Existing unbound rows may already have an in-flight create. A migrated row
    // therefore defaults to "started" and cannot be released as a fresh lease.
    const columns = this.db.pragma('table_info(symposium_artifact_leases)') as { name: string }[];
    if (!columns.some((column) => column.name === 'creation_started'))
      this.db.exec('ALTER TABLE symposium_artifact_leases ADD COLUMN creation_started INTEGER NOT NULL DEFAULT 1');
    if (!columns.some((column) => column.name === 'intended_sandbox_name'))
      this.db.exec('ALTER TABLE symposium_artifact_leases ADD COLUMN intended_sandbox_name TEXT');
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS symposium_artifact_sandbox_identity
      ON symposium_artifact_leases(COALESCE(intended_sandbox_name, sandbox_name))
      WHERE creation_started = 1 AND COALESCE(intended_sandbox_name, sandbox_name) IS NOT NULL;`);
  }

  close(): void { this.db.close(); }

  async inspectVolume(name: string, driver: ArtifactDriver): Promise<ArtifactVolumeEvidence> {
    if (!safeName.test(name)) throw new Error('Invalid artifact volume name');
    return volumeEvidence(await this.volumeRunner(driver, name), name);
  }

  async verifyDriverConfig(request: ArtifactLeaseRequest, config: ArtifactDriverConfig): Promise<void> {
    const keys = Object.keys(config);
    const mount = config[request.driver]?.mounts;
    if (keys.length !== 1 || keys[0] !== request.driver || mount?.length !== 1 ||
        mount[0].type !== 'volume' || mount[0].source !== request.volumeName ||
        mount[0].target !== '/sandbox/symposium-artifacts' ||
        mount[0].read_only !== (request.access === 'reviewer'))
      throw new Error('Artifact driver config differs from lease');
    await this.evidence.verifyGateway(request, config);
  }

  async verifyPhysicalMount(sandboxName: string, sandboxId: string, config: ArtifactDriverConfig): Promise<void> {
    if (!safeName.test(sandboxName) || !sandboxId) throw new Error('Invalid artifact sandbox identity');
    await this.evidence.verifyMount(sandboxName, sandboxId, config);
  }

  async reserve(request: ArtifactLeaseRequest): Promise<ArtifactLease> {
    const id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
    if (![request.sessionId, request.workspaceId, request.seatId, request.volumeGeneration]
      .every((value) => id.test(value)) || !safeName.test(request.volumeName) ||
      !['docker', 'podman'].includes(request.driver) ||
      !['writer', 'reviewer'].includes(request.access))
      throw new Error('Invalid artifact lease request');
    const requestJson = JSON.stringify(request);
    try {
      return this.db.transaction(() => {
        const existing = this.db.prepare(`SELECT * FROM symposium_artifact_leases
          WHERE driver=? AND volume_name=? AND request_json=?`).all(
            request.driver, request.volumeName, requestJson) as LeaseRow[];
        if (existing.length > 1) throw new Error('Duplicate artifact lease identity');
        if (existing.length === 1) return { token: existing[0].token,
          revision: existing[0].revision, request };
        const token = randomUUID();
        const revision = randomUUID();
        this.db.prepare(`INSERT INTO symposium_artifact_leases
          (token, revision, driver, volume_name, access, request_json, creation_started, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, ?)`).run(token, revision, request.driver,
            request.volumeName, request.access, requestJson, Date.now());
        return { token, revision, request };
      })();
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed'))
        throw new Error('Artifact volume already has a writer', { cause: error });
      throw error;
    }
  }

  async inspectLease(token: string): Promise<ArtifactLease | null> {
    const row = this.row(token);
    return row ? { token: row.token, revision: row.revision,
      request: JSON.parse(row.request_json) as ArtifactLeaseRequest } : null;
  }

  /** Persist the exact create target before issuing a sandbox create/ensure call.
   * A started, unbound lease intentionally cannot be released automatically: an
   * in-flight create could finish after an absence check or process restart.
   */
  markCreationStarted(token: string, revision: string, sandboxName: string): void {
    if (!token || !revision || !safeName.test(sandboxName))
      throw new Error('Invalid artifact sandbox creation intent');
    const row = this.row(token);
    if (row?.revision === revision && row.creation_started === 1 &&
        row.intended_sandbox_name === sandboxName && row.sandbox_name === sandboxName && row.sandbox_id)
      return;
    const updated = this.db.prepare(`UPDATE symposium_artifact_leases
      SET creation_started=1, intended_sandbox_name=?
      WHERE token=? AND revision=? AND creation_started=0 AND sandbox_id IS NULL`)
      .run(sandboxName, token, revision);
    if (updated.changes !== 1) throw new Error('Artifact sandbox creation intent cannot be changed');
  }

  /** Bind the reservation to the immutable physical identity before admitting work. */
  bindSandbox(token: string, revision: string, sandboxName: string, sandboxId: string): void {
    if (!token || !revision || !safeName.test(sandboxName) || !sandboxId)
      throw new Error('Invalid artifact sandbox binding');
    const row = this.row(token);
    if (row?.revision === revision && row.creation_started === 1 &&
        row.intended_sandbox_name === sandboxName && row.sandbox_name === sandboxName &&
        row.sandbox_id === sandboxId) return;
    const updated = this.db.prepare(`UPDATE symposium_artifact_leases SET sandbox_name=?, sandbox_id=?
      WHERE token=? AND revision=? AND creation_started=1 AND intended_sandbox_name=?
        AND sandbox_id IS NULL`).run(sandboxName, sandboxId, token, revision, sandboxName);
    if (updated.changes !== 1) throw new Error('Artifact lease cannot be rebound');
  }

  async release(token: string): Promise<void> {
    const row = this.row(token);
    if (!row) return;
    if (row.creation_started === 1 && !row.sandbox_id)
      throw new Error('Artifact sandbox creation may be in flight; lease requires reconciliation');
    if (row.sandbox_name && row.sandbox_id)
      throw new Error('Bound artifact lease requires gateway and physical deletion attestation');
    // Recheck the exact revision/identity after the asynchronous stop attestation.
    const deleted = this.db.prepare(`DELETE FROM symposium_artifact_leases
      WHERE token=? AND revision=? AND creation_started=?
        AND intended_sandbox_name IS ? AND sandbox_name IS ? AND sandbox_id IS ?`)
      .run(token, row.revision, row.creation_started, row.intended_sandbox_name,
        row.sandbox_name, row.sandbox_id);
    if (deleted.changes !== 1) throw new Error('Artifact lease changed during release');
  }

  /** Reconcile a crash before the durable create intent. The seat lifecycle
   * fence must be held by the caller. A started lease is never releasable by
   * absence alone, since an in-flight create could complete later. */
  async releaseUnstartedForAbsentSeat(
    request: ArtifactLeaseRequest,
    verifyGatewayAbsent: () => Promise<void>,
  ): Promise<void> {
    const rows = this.db.prepare(`SELECT * FROM symposium_artifact_leases
      WHERE json_extract(request_json, '$.sessionId')=?
        AND json_extract(request_json, '$.seatId')=?`).all(
          request.sessionId, request.seatId) as LeaseRow[];
    if (rows.length === 0) {
      await verifyGatewayAbsent();
      return;
    }
    if (rows.length !== 1 || rows[0].request_json !== JSON.stringify(request))
      throw new Error('Artifact lease request changed before pre-create reconciliation');
    const row = rows[0];
    if (row.creation_started !== 0 || row.intended_sandbox_name || row.sandbox_name || row.sandbox_id)
      throw new Error('Artifact sandbox creation may be in flight; lease requires reconciliation');
    await verifyGatewayAbsent();
    await verifyGatewayAbsent();
    const deleted = this.db.prepare(`DELETE FROM symposium_artifact_leases
      WHERE token=? AND revision=? AND request_json=? AND creation_started=0
        AND intended_sandbox_name IS NULL AND sandbox_name IS NULL AND sandbox_id IS NULL`)
      .run(row.token, row.revision, row.request_json);
    if (deleted.changes !== 1) throw new Error('Artifact lease changed during pre-create reconciliation');
  }

  /** Rotate a bound lease only after the gateway and compute host independently
   * agree that the exact sandbox is absent. The callback must be a fresh,
   * host-owned gateway read, never a sandbox or model assertion. */
  async releaseBoundSandbox(
    request: ArtifactLeaseRequest,
    sandboxName: string,
    sandboxId: string,
    verifyGatewayAbsent: () => Promise<void>,
  ): Promise<void> {
    if (!safeName.test(sandboxName) || !sandboxId || !this.evidence.verifyDeleted)
      throw new Error('Artifact deletion evidence is unavailable');
    const rows = this.db.prepare(`SELECT * FROM symposium_artifact_leases
      WHERE sandbox_name=? AND sandbox_id=?`).all(sandboxName, sandboxId) as LeaseRow[];
    if (rows.length !== 1 || rows[0].request_json !== JSON.stringify(request) ||
        rows[0].creation_started !== 1)
      throw new Error('Bound artifact lease identity is unavailable');
    const row = rows[0];
    await verifyGatewayAbsent();
    await this.evidence.verifyDeleted(sandboxName, sandboxId);
    await verifyGatewayAbsent();
    const deleted = this.db.prepare(`DELETE FROM symposium_artifact_leases
      WHERE token=? AND revision=? AND request_json=? AND creation_started=1
        AND intended_sandbox_name=? AND sandbox_name=? AND sandbox_id=?`)
      .run(row.token, row.revision, row.request_json, sandboxName, sandboxName, sandboxId);
    if (deleted.changes !== 1) throw new Error('Artifact lease changed during deletion proof');
  }

  private row(token: string): LeaseRow | undefined {
    return this.db.prepare('SELECT * FROM symposium_artifact_leases WHERE token=?').get(token) as LeaseRow | undefined;
  }
}
