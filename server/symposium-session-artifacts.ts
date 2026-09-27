import Database from 'better-sqlite3';
import type { ArtifactInitializerReceipt } from './symposium-artifact-initializer.js';
import { randomUUID } from 'node:crypto';
import type { ArtifactVolumeEvidence } from './symposium-artifact-lease.js';
export type SessionArtifactMapping = {
  sessionId: string;
  volumeName: string;
  volumeGeneration: string;
};
export type SessionArtifactPreparation = { state: 'ready' | 'pending' | 'recovery_required' };
const id = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export function artifactVolumeLabels(
  workspace: string,
  mapping: SessionArtifactMapping,
): Record<string, string> {
  return {
    'openshell.ai/sandbox-attachable': 'true',
    'openshell.ai/sandbox-attachable-workspace': workspace,
    'mitzo.symposium.purpose': 'artifacts',
    'mitzo.symposium.session': mapping.sessionId,
    'mitzo.symposium.workspace': workspace,
    'mitzo.symposium.generation': mapping.volumeGeneration,
  };
}
export function assertSessionArtifactVolume(
  workspace: string,
  mapping: SessionArtifactMapping,
  volume: ArtifactVolumeEvidence | null,
): void {
  const labels = artifactVolumeLabels(workspace, mapping);
  if (
    !volume ||
    volume.name !== mapping.volumeName ||
    volume.driver !== 'local' ||
    Object.keys(volume.options).length ||
    Object.keys(volume.labels).sort().join() !== Object.keys(labels).sort().join() ||
    Object.entries(labels).some(([key, value]) => volume.labels[key] !== value)
  )
    throw new Error('Session artifact volume evidence changed');
}
type Row = {
  session_id: string;
  workspace: string;
  custody: string;
  volume_name: string;
  generation: string;
  revision: number;
  initialization_contract: string | null;
  admission_issued: number;
  source_import_json: string | null;
  source_seal_json: string | null;
  initializer_name: string | null;
  initializer_id: string | null;
  initializer_removed: number;
  state: 'reserved' | 'creating' | 'ready' | 'uncertain' | 'quarantined';
};
/** A host-only lifecycle ledger. No deletion, lease release or caller-selected volume.
 * An uncertain command retains its name/generation and is only reconciled by inspection.
 * Reopening with different host custody cannot adopt an older gateway's resources. */
export class SymposiumSessionArtifacts {
  private readonly db: Database.Database;
  private readonly inFlight = new Map<string, Promise<SessionArtifactPreparation>>();
  constructor(
    path: string,
    private readonly workspace: string,
    private readonly custody: string,
    private readonly verifyCustody: () => void,
    private readonly host: {
      initializationContract: string;
      initializerRequired?: boolean;
      inspect(name: string): Promise<ArtifactVolumeEvidence | null>;
      create(
        name: string,
        labels: Record<string, string>,
        receipt: ArtifactInitializerReceipt,
      ): Promise<void>;
    },
  ) {
    if (!id.test(workspace) || !custody || !host.initializationContract)
      throw new Error('Invalid session artifact host');
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS symposium_session_artifacts (
   session_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, custody TEXT NOT NULL,
   volume_name TEXT NOT NULL UNIQUE, generation TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL
   CHECK(state IN ('reserved','creating','ready','uncertain','quarantined')))`);
    const columns = this.db.pragma('table_info(symposium_session_artifacts)') as { name: string }[];
    if (!columns.some((column) => column.name === 'initialization_contract'))
      this.db.exec(
        'ALTER TABLE symposium_session_artifacts ADD COLUMN initialization_contract TEXT',
      );
    for (const [name, definition] of [
      ['initializer_name', 'TEXT'],
      ['initializer_id', 'TEXT'],
      ['initializer_removed', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (!columns.some((column) => column.name === name))
        this.db.exec(`ALTER TABLE symposium_session_artifacts ADD COLUMN ${name} ${definition}`);
    }
    // Existing rows may already have issued descriptors: migration cannot infer pristine use.
    for (const [name, definition] of [
      ['admission_issued', 'INTEGER NOT NULL DEFAULT 1'],
      ['source_import_json', 'TEXT'],
      ['source_seal_json', 'TEXT'],
    ]) {
      if (!columns.some((column) => column.name === name))
        this.db.exec(`ALTER TABLE symposium_session_artifacts ADD COLUMN ${name} ${definition}`);
    }
    if (!columns.some((column) => column.name === 'revision'))
      this.db.exec(
        'ALTER TABLE symposium_session_artifacts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0',
      );
  }
  close() {
    this.db.close();
  }
  private read(sessionId: string) {
    return this.db
      .prepare('SELECT * FROM symposium_session_artifacts WHERE session_id=?')
      .get(sessionId) as Row | undefined;
  }
  private mapping(row: Row): SessionArtifactMapping {
    return {
      sessionId: row.session_id,
      volumeName: row.volume_name,
      volumeGeneration: row.generation,
    };
  }
  private assertOwner(row: Row) {
    this.verifyCustody();
    if (row.workspace !== this.workspace || row.custody !== this.custody)
      throw new Error('Session artifact belongs to different host custody');
  }
  /** Identity only for retiring an existing sandbox/lease, never new admission. */
  getRetained(sessionId: string): SessionArtifactMapping | null {
    const row = this.read(sessionId);
    if (!row) return null;
    this.assertOwner(row);
    return this.mapping(row);
  }
  getReady(sessionId: string): SessionArtifactMapping | null {
    const row = this.read(sessionId);
    if (!row) return null;
    this.assertOwner(row);
    return row.state === 'ready' &&
      (!row.source_import_json || JSON.parse(row.source_import_json).receipt) &&
      row.initialization_contract === this.host.initializationContract
      ? this.mapping(row)
      : null;
  }
  sourceImportStatus(sessionId: string) {
    const row = this.read(sessionId);
    if (!row) return { available: false, state: 'unprepared' };
    this.assertOwner(row);
    const source = row.source_import_json ? JSON.parse(row.source_import_json) : null;
    return {
      available: !!this.getReady(sessionId) && !row.admission_issued && !source,
      state: source
        ? source.receipt
          ? 'imported'
          : (source.failure?.outcome ?? 'recovery_required')
        : 'empty',
      admissionIssued: !!row.admission_issued,
      volumeGeneration: row.generation,
      receipt: source?.receipt ?? null,
      sourceSeal: row.source_seal_json ? JSON.parse(row.source_seal_json) : null,
    };
  }
  /** Persist a permanent pre-admission fence before physical source verification.
   * A pending attempt is never reconstructed from a later clean volume inspection. */
  beginSourceSeal(sessionId: string, operationId: string) {
    if (!id.test(operationId)) throw new Error('Invalid source seal operation');
    return this.db
      .transaction(() => {
        const row = this.read(sessionId);
        if (!row) throw new Error('Source seal mapping unavailable');
        this.assertOwner(row);
        const existing = row.source_seal_json ? JSON.parse(row.source_seal_json) : null;
        if (existing) {
          if (existing.operationId !== operationId)
            throw new Error('source seal operation changed');
          return existing;
        }
        const source = row.source_import_json ? JSON.parse(row.source_import_json) : null;
        const receipt = source?.receipt;
        if (
          row.admission_issued ||
          !this.getReady(sessionId) ||
          !receipt ||
          receipt.git?.version !== 1 ||
          receipt.git.commit !== receipt.commit ||
          receipt.git.tree !== receipt.tree ||
          receipt.git.entries !== receipt.files ||
          receipt.git.bytes !== receipt.bytes ||
          !/^[a-f0-9]{64}$/.test(receipt.git.manifestDigest) ||
          !/^[a-f0-9]{64}$/.test(receipt.git.committedTreeDigest) ||
          receipt.terminal?.exitCode !== 0 ||
          !/^[a-f0-9]{64}$/.test(receipt.terminal.helperId)
        )
          throw new Error('Source seal requires exact imported, unadmitted Git proof');
        const pending = {
          version: 1 as const,
          state: 'pending' as const,
          sessionId,
          operationId,
          workspace: row.workspace,
          custody: row.custody,
          volumeName: row.volume_name,
          volumeGeneration: row.generation,
          sourceReceipt: receipt,
        };
        this.db
          .prepare(
            'UPDATE symposium_session_artifacts SET source_seal_json=?,revision=revision+1 WHERE session_id=?',
          )
          .run(JSON.stringify(pending), sessionId);
        return pending;
      })
      .immediate();
  }
  sourceSealStatus(sessionId: string) {
    const row = this.read(sessionId);
    if (!row) return null;
    this.assertOwner(row);
    return row.source_seal_json ? JSON.parse(row.source_seal_json) : null;
  }
  private updateSourceSeal(
    sessionId: string,
    operationId: string,
    update: (value: Record<string, unknown>) => void,
  ) {
    this.db
      .transaction(() => {
        const row = this.read(sessionId);
        if (!row) throw new Error('source seal mapping unavailable');
        this.assertOwner(row);
        const value = row.source_seal_json ? JSON.parse(row.source_seal_json) : null;
        if (!value || value.operationId !== operationId || value.state !== 'pending')
          throw new Error('source seal helper claim changed');
        update(value);
        this.db
          .prepare('UPDATE symposium_session_artifacts SET source_seal_json=? WHERE session_id=?')
          .run(JSON.stringify(value), sessionId);
      })
      .immediate();
  }
  sourceSealHelperReceipt(sessionId: string, operationId: string) {
    return {
      verifier: (image: string, codeDigest: string) =>
        this.updateSourceSeal(sessionId, operationId, (value) => {
          if (!image || !/^[a-f0-9]{64}$/.test(codeDigest) || value.verifier || value.helperName)
            throw new Error('source seal verifier identity changed');
          value.verifier = { image, codeDigest };
        }),
      intent: (name: string) =>
        this.updateSourceSeal(sessionId, operationId, (value) => {
          if (name !== `${value.volumeName}-source-seal` || value.helperName || !value.verifier)
            throw new Error('source seal helper intent changed');
          value.helperName = name;
        }),
      created: (helperId: string) =>
        this.updateSourceSeal(sessionId, operationId, (value) => {
          if (!value.helperName || value.helperId || !/^[a-f0-9]{64}$/.test(helperId))
            throw new Error('source seal helper identity changed');
          value.helperId = helperId;
        }),
      observed: (git: unknown) =>
        this.updateSourceSeal(sessionId, operationId, (value) => {
          if (!value.helperId || value.git) throw new Error('source seal proof changed');
          const imported = (value.sourceReceipt as { git?: unknown }).git;
          if (JSON.stringify(git) !== JSON.stringify(imported))
            throw new Error('source seal Git proof differs from import');
          value.git = git;
        }),
      terminal: (helperId: string, exitCode: number) =>
        this.updateSourceSeal(sessionId, operationId, (value) => {
          if (value.helperId !== helperId || exitCode !== 0 || !value.git || value.terminal)
            throw new Error('source seal terminal proof changed');
          value.terminal = { helperId, exitCode: 0 };
        }),
      removed: () =>
        this.updateSourceSeal(sessionId, operationId, (value) => {
          if (!value.terminal || value.helperRemoved)
            throw new Error('source seal cleanup changed');
          value.helperRemoved = true;
        }),
    };
  }
  completeSourceSeal(sessionId: string, operationId: string) {
    return this.db
      .transaction(() => {
        const row = this.read(sessionId);
        if (!row) throw new Error('source seal mapping unavailable');
        this.assertOwner(row);
        const value = row.source_seal_json ? JSON.parse(row.source_seal_json) : null;
        if (
          !value ||
          value.operationId !== operationId ||
          value.state !== 'pending' ||
          !value.helperId ||
          !value.helperRemoved ||
          !value.git ||
          !value.verifier ||
          value.terminal?.helperId !== value.helperId ||
          value.terminal?.exitCode !== 0 ||
          row.admission_issued
        )
          throw new Error('source seal physical completion unavailable');
        value.state = 'complete';
        this.db
          .prepare('UPDATE symposium_session_artifacts SET source_seal_json=? WHERE session_id=?')
          .run(JSON.stringify(value), sessionId);
        return value;
      })
      .immediate();
  }
  /** Permanent issuance marker: an already returned descriptor can never race a later import. */
  claimAdmission(sessionId: string): SessionArtifactMapping {
    return this.db
      .transaction(() => {
        const mapping = this.getReady(sessionId);
        if (!mapping)
          throw new Error('Artifact source import or preparation mapping is incomplete');
        if (this.read(sessionId)?.source_seal_json)
          throw new Error('Original source seal fences direct artifact admission');
        this.db
          .prepare('UPDATE symposium_session_artifacts SET admission_issued=1 WHERE session_id=?')
          .run(sessionId);
        return mapping;
      })
      .immediate();
  }
  beginSourceImport(
    sessionId: string,
    request: { operationId: string; expectedGeneration: string; source: unknown },
  ) {
    return this.db
      .transaction(() => {
        const row = this.read(sessionId);
        if (!row) throw new Error('Artifact preparation unavailable');
        this.assertOwner(row);
        if (row.generation !== request.expectedGeneration)
          throw new Error('Artifact generation changed');
        if (row.admission_issued) throw new Error('Artifact admission was already issued');
        if (!this.getReady(sessionId) || row.source_import_json)
          throw new Error('Artifact source import unavailable');
        const claim = { ...this.mapping(row), token: randomUUID() };
        this.db
          .prepare(
            'UPDATE symposium_session_artifacts SET source_import_json=?,revision=revision+1 WHERE session_id=?',
          )
          .run(JSON.stringify({ request, token: claim.token }), sessionId);
        return claim;
      })
      .immediate();
  }
  private updateSourceImport(
    claim: SessionArtifactMapping & { token: string },
    update: (value: Record<string, unknown>) => void,
  ) {
    this.db
      .transaction(() => {
        const row = this.read(claim.sessionId);
        const source = row?.source_import_json ? JSON.parse(row.source_import_json) : null;
        if (
          !row ||
          row.generation !== claim.volumeGeneration ||
          row.volume_name !== claim.volumeName ||
          source?.token !== claim.token ||
          source.receipt
        )
          throw new Error('Source import claim changed');
        update(source);
        this.db
          .prepare('UPDATE symposium_session_artifacts SET source_import_json=? WHERE session_id=?')
          .run(JSON.stringify(source), claim.sessionId);
      })
      .immediate();
  }
  sourceImportHelperReceipt(
    claim: SessionArtifactMapping & { token: string },
  ): ArtifactInitializerReceipt {
    return {
      intent: (name) =>
        this.updateSourceImport(claim, (value) => {
          if (name !== `${claim.volumeName}-import` || value.helperName)
            throw new Error('Source helper intent changed');
          value.helperName = name;
        }),
      created: (id) =>
        this.updateSourceImport(claim, (value) => {
          if (!value.helperName || value.helperId || !/^[a-f0-9]{64}$/.test(id))
            throw new Error('Source helper identity changed');
          value.helperId = id;
        }),
      removed: () =>
        this.updateSourceImport(claim, (value) => {
          if (!value.helperId || value.helperRemoved)
            throw new Error('Source helper removal changed');
          value.helperRemoved = true;
        }),
    };
  }
  observeSourceImport(claim: SessionArtifactMapping & { token: string }, proof: unknown): void {
    this.updateSourceImport(claim, (value) => {
      value.observed = proof;
    });
  }
  failSourceImport(
    claim: SessionArtifactMapping & { token: string },
    failure: { outcome: 'failed' | 'uncertain'; exitCode?: number },
  ): void {
    this.updateSourceImport(claim, (value) => {
      value.failure = failure;
    });
  }
  completeSourceImport(claim: SessionArtifactMapping & { token: string }, receipt: unknown): void {
    this.updateSourceImport(claim, (value) => {
      if (!value.helperRemoved) throw new Error('Source helper cleanup receipt required');
      value.receipt = receipt;
    });
  }
  initializationReceipt(sessionId: string) {
    const mapping = this.getReady(sessionId);
    const row = this.read(sessionId);
    if (
      !mapping ||
      !row ||
      row.initializer_name !== `${mapping.volumeName}-init` ||
      !row.initializer_id ||
      !/^[a-f0-9]{64}$/.test(row.initializer_id) ||
      row.initializer_removed !== 1
    )
      return null;
    return {
      mapping,
      workspace: row.workspace,
      custody: row.custody,
      contract: row.initialization_contract!,
      helper: { name: row.initializer_name, id: row.initializer_id, removed: true as const },
    };
  }
  ensure(sessionId: string): Promise<SessionArtifactPreparation> {
    if (!id.test(sessionId)) return Promise.reject(new Error('Invalid Symposium session identity'));
    const pending = this.inFlight.get(sessionId);
    if (pending) return pending;
    const operation = this.prepare(sessionId).finally(() => this.inFlight.delete(sessionId));
    this.inFlight.set(sessionId, operation);
    return operation;
  }
  private async prepare(sessionId: string): Promise<SessionArtifactPreparation> {
    this.verifyCustody();
    const row = this.db
      .transaction(() => {
        const prior = this.read(sessionId);
        if (prior) {
          this.assertOwner(prior);
          return prior;
        }
        this.db
          .prepare(
            'INSERT INTO symposium_session_artifacts (session_id,workspace,custody,volume_name,generation,state,admission_issued) VALUES (?,?,?,?,?,?,0)',
          )
          .run(
            sessionId,
            this.workspace,
            this.custody,
            `mitzo-artifacts-${randomUUID()}`,
            randomUUID(),
            'reserved',
          );
        return this.read(sessionId)!;
      })
      .immediate();
    this.assertOwner(row);
    const mapping = this.mapping(row);
    if (row.source_import_json && !JSON.parse(row.source_import_json).receipt)
      return { state: 'recovery_required' };
    if (row.state === 'quarantined') return { state: 'recovery_required' };
    let revision = row.revision;
    let creationStarted = false;
    const ready = () => {
      this.assertOwner(row);
      const initialized = this.read(sessionId);
      if (initialized?.initialization_contract !== this.host.initializationContract)
        return { state: 'recovery_required' } as SessionArtifactPreparation;
      const updated = this.db
        .prepare(
          "UPDATE symposium_session_artifacts SET state='ready', revision=revision+1 WHERE session_id=? AND revision=? AND state IN ('creating','uncertain','ready')",
        )
        .run(sessionId, revision);
      if (updated.changes === 1) return { state: 'ready' } as SessionArtifactPreparation;
      // A newer successful inspection is compatible with ours. Read its result
      // without rewriting it; newer contradictory evidence must remain blocked.
      const current = this.read(sessionId);
      if (current) this.assertOwner(current);
      return {
        state:
          current?.state === 'ready' &&
          current.volume_name === row.volume_name &&
          current.generation === row.generation
            ? 'ready'
            : 'recovery_required',
      } as SessionArtifactPreparation;
    };
    try {
      const volume = await this.host.inspect(mapping.volumeName);
      this.assertOwner(row);
      if (row.state !== 'reserved') {
        try {
          assertSessionArtifactVolume(this.workspace, mapping, volume);
        } catch (error) {
          // A completed inspection contradicting the recorded identity differs
          // from a transport outage: only actual evidence invalidates readiness.
          // Evidence collected while creation was unsettled cannot revoke a
          // newer ready transition made by another ledger instance.
          if (row.state === 'ready' || row.state === 'uncertain')
            this.db
              .prepare(
                "UPDATE symposium_session_artifacts SET state='uncertain', revision=revision+1 WHERE session_id=? AND revision=? AND state IN ('ready','uncertain')",
              )
              .run(sessionId, revision);
          throw error;
        }
        return ready();
      }
      // A name collision before our first create is never adopted, even if labels match.
      if (volume) {
        this.db
          .prepare(
            "UPDATE symposium_session_artifacts SET state='quarantined', revision=revision+1 WHERE session_id=? AND revision=? AND state='reserved'",
          )
          .run(sessionId, revision);
        return { state: 'recovery_required' };
      }
      const claimed = this.db
        .prepare(
          "UPDATE symposium_session_artifacts SET state='creating', revision=revision+1 WHERE session_id=? AND revision=? AND state='reserved'",
        )
        .run(sessionId, revision);
      if (claimed.changes !== 1) return { state: 'pending' };
      revision += 1;
      creationStarted = true;
      this.assertOwner(row);
      const updateReceipt = (sql: string, ...values: unknown[]) => {
        const result = this.db.prepare(sql).run(...values, sessionId, revision);
        if (result.changes !== 1) throw new Error('Artifact initializer receipt changed');
      };
      const receipt: ArtifactInitializerReceipt = {
        intent: (name) => {
          if (name !== `${mapping.volumeName}-init`) throw new Error('Invalid initializer intent');
          this.assertOwner(row);
          updateReceipt(
            "UPDATE symposium_session_artifacts SET initializer_name=? WHERE session_id=? AND revision=? AND state='creating' AND initializer_name IS NULL",
            name,
          );
        },
        created: (helperId) => {
          if (!/^[a-f0-9]{64}$/.test(helperId)) throw new Error('Invalid initializer identity');
          updateReceipt(
            "UPDATE symposium_session_artifacts SET initializer_id=? WHERE session_id=? AND revision=? AND state='creating' AND initializer_name IS NOT NULL AND initializer_id IS NULL",
            helperId,
          );
        },
        removed: () =>
          updateReceipt(
            "UPDATE symposium_session_artifacts SET initializer_removed=1 WHERE session_id=? AND revision=? AND state='creating' AND initializer_id IS NOT NULL AND initializer_removed=0",
          ),
      };
      await this.host.create(
        mapping.volumeName,
        artifactVolumeLabels(this.workspace, mapping),
        receipt,
      );
      if (this.host.initializerRequired) {
        const proof = this.db
          .prepare('SELECT initializer_removed FROM symposium_session_artifacts WHERE session_id=?')
          .get(sessionId) as { initializer_removed: number };
        if (proof.initializer_removed !== 1)
          throw new Error('Artifact initializer cleanup receipt required');
      }
      // Record successful terminal creation before a later custody check can fail.
      // A timeout/unknown exit never reaches this durable initialization receipt.
      const initialized = this.db
        .prepare(
          "UPDATE symposium_session_artifacts SET initialization_contract=? WHERE session_id=? AND revision=? AND state='creating' AND initialization_contract IS NULL",
        )
        .run(this.host.initializationContract, sessionId, revision);
      if (initialized.changes !== 1) throw new Error('Artifact initialization receipt changed');
      this.assertOwner(row);
      assertSessionArtifactVolume(
        this.workspace,
        mapping,
        await this.host.inspect(mapping.volumeName),
      );
      this.assertOwner(row);
      return ready();
    } catch {
      if (creationStarted)
        this.db
          .prepare(
            "UPDATE symposium_session_artifacts SET state='uncertain', revision=revision+1 WHERE session_id=? AND revision=? AND state='creating'",
          )
          .run(sessionId, revision);
      return { state: 'recovery_required' };
    }
  }
}
