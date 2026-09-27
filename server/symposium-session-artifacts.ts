import Database from 'better-sqlite3';
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
      inspect(name: string): Promise<ArtifactVolumeEvidence | null>;
      create(name: string, labels: Record<string, string>): Promise<void>;
    },
  ) {
    if (!id.test(workspace) || !custody) throw new Error('Invalid session artifact host');
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS symposium_session_artifacts (
   session_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, custody TEXT NOT NULL,
   volume_name TEXT NOT NULL UNIQUE, generation TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL
   CHECK(state IN ('reserved','creating','ready','uncertain','quarantined')))`);
    const columns = this.db.pragma('table_info(symposium_session_artifacts)') as { name: string }[];
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
    return row.state === 'ready' ? this.mapping(row) : null;
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
            'INSERT INTO symposium_session_artifacts (session_id,workspace,custody,volume_name,generation,state) VALUES (?,?,?,?,?,?)',
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
    if (row.state === 'quarantined') return { state: 'recovery_required' };
    let revision = row.revision;
    let creationStarted = false;
    const ready = () => {
      this.assertOwner(row);
      const updated = this.db
        .prepare(
          "UPDATE symposium_session_artifacts SET state='ready', revision=revision+1 WHERE session_id=? AND revision=? AND state IN ('creating','uncertain','ready')",
        )
        .run(sessionId, revision);
      return {
        state: updated.changes === 1 ? 'ready' : 'recovery_required',
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
      await this.host.create(mapping.volumeName, artifactVolumeLabels(this.workspace, mapping));
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
