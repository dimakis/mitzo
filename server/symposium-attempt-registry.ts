import { createHash } from 'node:crypto';
import { artifactAdmissionDigest } from './event-store.js';
import {
  ArtifactAdmissionReferenceV1Schema,
  ArtifactReaderReferenceV1Schema,
  type ArtifactAdmissionReferenceV1,
  type ArtifactReaderReferenceV1,
} from '@mitzo/protocol';
import { SymposiumCompletionCheckpoints } from './symposium-completion-checkpoints.js';
import { SymposiumNativeObservations } from './symposium-native-observations.js';
import Database from 'better-sqlite3';
import { z } from 'zod';
const ArtifactWorkReferenceSchema = z.union([
  ArtifactAdmissionReferenceV1Schema,
  ArtifactReaderReferenceV1Schema,
]);
import { dirname } from 'node:path';
import { chmodSync, lstatSync, statSync } from 'node:fs';
import {
  confirmControlledAttemptStopped,
  controlledAttemptRoute,
  launchControlledAttempt,
  type ControlledAttemptProcess,
  type ControlledAttemptSandbox,
} from './symposium-attempt-transport.js';

type AttemptState = 'reserved' | 'uncertain' | 'confirmed';

interface AttemptRow extends ControlledAttemptSandbox {
  claimToken: string;
  sessionId: string;
  artifact?: ArtifactAdmissionReferenceV1 | ArtifactReaderReferenceV1;
  state: AttemptState;
}

export interface SymposiumAttemptTransport {
  launch: typeof launchControlledAttempt;
  confirm: typeof confirmControlledAttemptStopped;
}

/** Observation from this registry's original controlled launch and positive
 * controller acknowledgement. Durable rows, recovery, and restart cannot mint it. */
export interface SymposiumOriginalStopReceipt {
  readonly version: 1;
  readonly claimToken: string;
  readonly sessionId: string;
  readonly sandboxName: string;
  readonly workdir: string;
  readonly transportRouteSha256: string;
  readonly artifactBindingSha256: string;
  readonly confirmedAt: number;
}

/** Host-owned durable mapping; never populate it from client-supplied sandbox names. */
export class SymposiumAttemptRegistry {
  private readonly db: Database.Database;
  private readonly originalStopReceipts = new Map<string, SymposiumOriginalStopReceipt>();
  readonly observations: SymposiumNativeObservations;
  readonly checkpoints: SymposiumCompletionCheckpoints;

  constructor(
    path: string,
    private readonly transport: SymposiumAttemptTransport = {
      launch: launchControlledAttempt,
      confirm: confirmControlledAttemptStopped,
    },
  ) {
    if (path === ':memory:' || (statSync(dirname(path)).mode & 0o077) !== 0)
      throw new Error('Native attempt registry requires a private host directory');
    try {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0)
        throw new Error('Native attempt registry file is not private');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS symposium_native_attempts (
      claim_token TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sandbox_name TEXT NOT NULL,
      workdir TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved', 'uncertain', 'confirmed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS symposium_native_attempts_sandbox
      ON symposium_native_attempts(sandbox_name, state);
    CREATE TABLE IF NOT EXISTS symposium_native_preparations (
      claim_token TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0, 1))
    );`);
    const columns = this.db.pragma('table_info(symposium_native_attempts)') as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'transport_route'))
      this.db.exec('ALTER TABLE symposium_native_attempts ADD COLUMN transport_route TEXT');
    for (const table of ['symposium_native_attempts', 'symposium_native_preparations']) {
      if (
        !(this.db.pragma(`table_info(${table})`) as Array<{ name: string }>).some(
          (column) => column.name === 'artifact_json',
        )
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN artifact_json TEXT`);
    }
    this.observations = new SymposiumNativeObservations(this.db, (claim, session, provenance) => {
      const attempt = this.get(claim);
      if (
        !attempt ||
        attempt.sessionId !== session ||
        artifactAdmissionDigest(attempt.artifact ?? null) !==
          artifactAdmissionDigest(
            'version' in provenance && provenance.version === 3 ? provenance.artifact : null,
          )
      )
        throw new Error('Native observation requires the exact reserved session claim');
    });
    this.checkpoints = new SymposiumCompletionCheckpoints(this.db, this.observations, (token) =>
      this.get(token),
    );
  }

  /** Registered before asynchronous setup. Every native launch must pass reserve(). */
  prepare(input: {
    claimToken: string;
    sessionId: string;
    artifact?: ArtifactAdmissionReferenceV1 | ArtifactReaderReferenceV1;
  }) {
    if (!input.claimToken || !input.sessionId) throw new Error('Invalid native attempt identity');
    this.db.transaction(() => {
      if (this.get(input.claimToken)) throw new Error('Native attempt claim already exists');
      const existing = this.db
        .prepare(
          'SELECT session_id AS sessionId, closed, artifact_json AS artifactJson FROM symposium_native_preparations WHERE claim_token = ?',
        )
        .get(input.claimToken) as
        { sessionId: string; closed: number; artifactJson: string | null } | undefined;
      if (existing) {
        if (
          existing.closed ||
          existing.sessionId !== input.sessionId ||
          artifactAdmissionDigest(
            existing.artifactJson ? JSON.parse(existing.artifactJson) : null,
          ) !== artifactAdmissionDigest(input.artifact ?? null)
        )
          throw new Error('Native attempt preparation is closed or belongs to another session');
        return;
      }
      this.db
        .prepare(
          'INSERT INTO symposium_native_preparations (claim_token, session_id, artifact_json) VALUES (?, ?, ?)',
        )
        .run(
          input.claimToken,
          input.sessionId,
          input.artifact ? JSON.stringify(ArtifactWorkReferenceSchema.parse(input.artifact)) : null,
        );
    })();
  }

  reserve(input: {
    claimToken: string;
    sessionId: string;
    sandbox: ControlledAttemptSandbox;
    artifact?: ArtifactAdmissionReferenceV1 | ArtifactReaderReferenceV1;
  }) {
    if (!input.claimToken || !input.sessionId || !input.sandbox.sandboxName)
      throw new Error('Invalid native attempt identity');
    const route =
      input.sandbox.cli ||
      input.sandbox.gateway ||
      input.sandbox.workspace ||
      input.sandbox.gatewayEndpoint !== undefined ||
      input.sandbox.gatewayInsecure !== undefined ||
      input.sandbox.cliEnvironment !== undefined
        ? JSON.stringify(controlledAttemptRoute(input.sandbox))
        : null;
    this.db.transaction(() => {
      const preparation = this.db
        .prepare(
          'SELECT session_id AS sessionId, closed, artifact_json AS artifactJson FROM symposium_native_preparations WHERE claim_token = ?',
        )
        .get(input.claimToken) as
        { sessionId: string; closed: number; artifactJson: string | null } | undefined;
      if (
        preparation &&
        (preparation.closed ||
          preparation.sessionId !== input.sessionId ||
          artifactAdmissionDigest(
            preparation.artifactJson ? JSON.parse(preparation.artifactJson) : null,
          ) !== artifactAdmissionDigest(input.artifact ?? null))
      )
        throw new Error('Native attempt preparation is closed or belongs to another session');
      this.assertSandboxAvailable(input.sandbox.sandboxName);
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO symposium_native_attempts
           (claim_token, session_id, sandbox_name, workdir, state, created_at, updated_at, transport_route, artifact_json)
           VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`,
        )
        .run(
          input.claimToken,
          input.sessionId,
          input.sandbox.sandboxName,
          input.sandbox.workdir,
          now,
          now,
          route,
          input.artifact ? JSON.stringify(ArtifactWorkReferenceSchema.parse(input.artifact)) : null,
        );
      // Commit the unknown process state before any transport side effect.
      this.db
        .prepare('DELETE FROM symposium_native_preparations WHERE claim_token = ?')
        .run(input.claimToken);
    })();
  }

  launch(input: {
    claimToken: string;
    sessionId: string;
    sandbox: ControlledAttemptSandbox;
    artifact?: ArtifactAdmissionReferenceV1 | ArtifactReaderReferenceV1;
    access: 'read' | 'write';
    command: readonly string[];
    /** Actual source-only staging queue/lifetime fence; never serialized. */
    assertOriginalEffectCurrent?: () => void;
    /** Same original queue/source/owner fence, omitting only new resource admission. */
    assertOriginalCleanupCurrent?: () => void;
  }): ControlledAttemptProcess {
    input.assertOriginalEffectCurrent?.();
    controlledAttemptRoute(input.sandbox);
    this.reserve(input);
    try {
      const process = this.transport.launch(
        input.sandbox,
        input.claimToken,
        input.access,
        input.command,
      );
      const row = this.get(input.claimToken)!;
      const transportRouteSha256 = createHash('sha256')
        .update(JSON.stringify(controlledAttemptRoute(row)))
        .digest('hex');
      const artifactBindingSha256 = artifactAdmissionDigest(row.artifact ?? null);
      let confirmation: Promise<void> | undefined;
      return {
        child: process.child,
        confirmStopped: () => {
          confirmation ??= (async () => {
            try {
              // Retain this exact controlled target. A reconstructed durable route
              // may support ordinary recovery but cannot issue this live receipt.
              (input.assertOriginalCleanupCurrent ?? input.assertOriginalEffectCurrent)?.();
              await process.confirmStopped();
              (input.assertOriginalCleanupCurrent ?? input.assertOriginalEffectCurrent)?.();
              const current = this.get(input.claimToken);
              if (
                !current ||
                current.sessionId !== row.sessionId ||
                current.sandboxName !== row.sandboxName ||
                current.workdir !== row.workdir ||
                createHash('sha256')
                  .update(JSON.stringify(controlledAttemptRoute(current)))
                  .digest('hex') !== transportRouteSha256 ||
                artifactAdmissionDigest(current.artifact ?? null) !== artifactBindingSha256
              )
                throw Error('Original native attempt identity changed');
              this.markConfirmed(input.claimToken);
              this.originalStopReceipts.set(
                input.claimToken,
                Object.freeze({
                  version: 1,
                  claimToken: input.claimToken,
                  sessionId: row.sessionId,
                  sandboxName: row.sandboxName,
                  workdir: row.workdir,
                  transportRouteSha256,
                  artifactBindingSha256,
                  confirmedAt: Date.now(),
                }),
              );
            } catch {
              if (this.get(input.claimToken)?.state !== 'confirmed')
                this.markUncertain(input.claimToken);
              throw Error(
                'Original native attempt cleanup is unconfirmed; sandbox remains quarantined',
              );
            }
          })();
          return confirmation;
        },
      };
    } catch {
      this.markUncertain(input.claimToken);
      throw new Error('Native attempt launch is unconfirmed; sandbox remains quarantined');
    }
  }

  readOriginalStopReceipt(claimToken: string): SymposiumOriginalStopReceipt {
    const receipt = this.originalStopReceipts.get(claimToken);
    const row = this.get(claimToken);
    if (
      !receipt ||
      !row ||
      row.state !== 'confirmed' ||
      row.sessionId !== receipt.sessionId ||
      row.sandboxName !== receipt.sandboxName ||
      row.workdir !== receipt.workdir ||
      createHash('sha256')
        .update(JSON.stringify(controlledAttemptRoute(row)))
        .digest('hex') !== receipt.transportRouteSha256 ||
      artifactAdmissionDigest(row.artifact ?? null) !== receipt.artifactBindingSha256
    )
      throw Error('Positive original controlled process stop receipt unavailable');
    return receipt;
  }

  assertSandboxAvailable(sandboxName: string) {
    const row = this.db
      .prepare(
        "SELECT 1 FROM symposium_native_attempts WHERE sandbox_name = ? AND state != 'confirmed' LIMIT 1",
      )
      .get(sandboxName);
    if (row) throw new Error('Native sandbox is quarantined pending exact cleanup proof');
  }

  get(claimToken: string): AttemptRow | undefined {
    const row = this.db
      .prepare(
        `SELECT claim_token AS claimToken, session_id AS sessionId,
                sandbox_name AS sandboxName, workdir, state, transport_route AS transportRoute, artifact_json AS artifactJson
         FROM symposium_native_attempts WHERE claim_token = ?`,
      )
      .get(claimToken);
    return row ? this.decodeRow(row) : undefined;
  }

  markUncertain(claimToken: string) {
    const result = this.db
      .prepare(
        "UPDATE symposium_native_attempts SET state = 'uncertain', updated_at = ? WHERE claim_token = ? AND state != 'confirmed'",
      )
      .run(Date.now(), claimToken);
    if (result.changes !== 1) throw new Error('Native attempt claim is unavailable');
  }

  markConfirmed(claimToken: string) {
    const result = this.db
      .prepare(
        "UPDATE symposium_native_attempts SET state = 'confirmed', updated_at = ? WHERE claim_token = ? AND state != 'confirmed'",
      )
      .run(Date.now(), claimToken);
    if (result.changes !== 1 && this.get(claimToken)?.state !== 'confirmed')
      throw new Error('Native attempt claim is unavailable');
  }

  private decodeRow(value: unknown): AttemptRow {
    const { transportRoute, artifactJson, ...raw } = value as AttemptRow & {
      transportRoute: string | null;
      artifactJson: string | null;
    };
    const row = {
      ...raw,
      ...(artifactJson
        ? { artifact: ArtifactWorkReferenceSchema.parse(JSON.parse(artifactJson)) }
        : {}),
    };
    if (!transportRoute) return row;
    const route = JSON.parse(transportRoute);
    return {
      ...row,
      ...controlledAttemptRoute({ ...route, sandboxName: row.sandboxName, workdir: row.workdir }),
    };
  }

  pendingPreparations(): Array<{
    claimToken: string;
    sessionId: string;
    artifact?: ArtifactAdmissionReferenceV1 | ArtifactReaderReferenceV1;
  }> {
    const rows = this.db
      .prepare(
        'SELECT claim_token AS claimToken,session_id AS sessionId,artifact_json AS artifactJson FROM symposium_native_preparations WHERE closed=0',
      )
      .all() as Array<{ claimToken: string; sessionId: string; artifactJson: string | null }>;
    return rows.map(({ artifactJson, ...row }) => ({
      ...row,
      ...(artifactJson
        ? { artifact: ArtifactWorkReferenceSchema.parse(JSON.parse(artifactJson)) }
        : {}),
    }));
  }
  pending(): AttemptRow[] {
    return this.db
      .prepare(
        `SELECT claim_token AS claimToken, session_id AS sessionId,
                sandbox_name AS sandboxName, workdir, state, transport_route AS transportRoute, artifact_json AS artifactJson
         FROM symposium_native_attempts WHERE state != 'confirmed'`,
      )
      .all()
      .map((row) => this.decodeRow(row));
  }

  /** Historical absence proof for sealing a source before any native work. */
  hasSessionClaims(sessionId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM symposium_native_attempts WHERE session_id=?
      UNION SELECT 1 FROM symposium_native_preparations WHERE session_id=? LIMIT 1`,
      )
      .get(sessionId, sessionId);
  }

  /** A failed probe retains the quarantine; callers must not infer sandbox safety. */
  async recover(
    claimToken: string,
    confirm: typeof confirmControlledAttemptStopped = this.transport.confirm,
  ): Promise<void> {
    const row = this.db.transaction(() => {
      const launched = this.get(claimToken);
      if (launched) return launched;
      // Closing and launch reservation serialize in the same database. A late
      // setup continuation can never launch after this proof is issued.
      const result = this.db
        .prepare('UPDATE symposium_native_preparations SET closed = 1 WHERE claim_token = ?')
        .run(claimToken);
      if (result.changes !== 1) throw new Error('Native attempt claim is unavailable');
      return undefined;
    })();
    if (!row) return;
    if (row.state === 'confirmed') return;
    try {
      const route = controlledAttemptRoute(row);
      await confirm({ sandboxName: row.sandboxName, workdir: row.workdir, ...route }, claimToken);
      this.markConfirmed(claimToken);
    } catch {
      this.markUncertain(claimToken);
      throw new Error('Native attempt cleanup is unconfirmed; sandbox remains quarantined');
    }
  }

  close() {
    this.originalStopReceipts.clear();
    this.db.close();
  }
}
