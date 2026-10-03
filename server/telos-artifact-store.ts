import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MAX_TELOS_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const artifactFilename = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^/\\]+$/)
  .refine(
    (name) =>
      name !== '.' &&
      name !== '..' &&
      [...name].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
  );
export interface TelosArtifactMetadata {
  id: string;
  itemId: string;
  filename: string;
  title: string;
  revision: number;
  sha256: string;
  size: number;
  sessionId: string;
  sourceKind: 'user_upload' | 'session_artifact' | 'external_codex_report';
  sourcePath: string | null;
  createdAt: string;
  url: string;
}
interface ArtifactRow {
  id: string;
  item_id: string;
  filename: string;
  title: string;
  revision: number;
  sha256: string;
  size: number;
  session_id: string;
  source_path: string | null;
  created_at: string;
  bytes: Buffer;
}
function metadata(row: ArtifactRow): TelosArtifactMetadata {
  return {
    id: row.id,
    itemId: row.item_id,
    filename: row.filename,
    title: row.title,
    revision: row.revision,
    sha256: row.sha256,
    size: row.size,
    sessionId: row.session_id,
    sourceKind: row.session_id.startsWith('user-upload:')
      ? 'user_upload'
      : row.session_id.startsWith('external-codex:')
        ? 'external_codex_report'
        : 'session_artifact',
    sourcePath: row.source_path,
    createdAt: row.created_at,
    url: `/api/telos/artifacts/${row.id}?revision=${row.revision}`,
  };
}
/** Content and item links commit together in the canonical Telos database, outside sandboxes. */
export class TelosArtifactStore {
  private db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path, { fileMustExist: true });
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    try {
      this.db.prepare('SELECT id FROM items LIMIT 1').get();
      this.db.prepare('SELECT id FROM links LIMIT 1').get();
      this.db.exec(`CREATE TABLE IF NOT EXISTS telos_artifact_revisions (
        id TEXT NOT NULL, revision INTEGER NOT NULL, item_id TEXT NOT NULL REFERENCES items(id),
        filename TEXT NOT NULL, title TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
        bytes BLOB NOT NULL, session_id TEXT NOT NULL, source_path TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY(id, revision));
        CREATE TABLE IF NOT EXISTS telos_artifact_save_requests (
          session_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
          artifact_id TEXT NOT NULL, revision INTEGER NOT NULL,
          PRIMARY KEY(session_id, request_id),
          FOREIGN KEY(artifact_id, revision) REFERENCES telos_artifact_revisions(id, revision));
        CREATE TABLE IF NOT EXISTS telos_artifact_request_inputs (
          session_id TEXT NOT NULL, request_id TEXT NOT NULL, input_sha256 TEXT NOT NULL,
          PRIMARY KEY(session_id, request_id),
          FOREIGN KEY(session_id, request_id) REFERENCES telos_artifact_save_requests(session_id, request_id));
        CREATE INDEX IF NOT EXISTS telos_artifacts_item ON telos_artifact_revisions(item_id);`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  /** Match the submitted request, not mutable workspace bytes, before reading a path. */
  retryReceipt(
    sessionId: string,
    requestId: string,
    inputHash: string,
  ): TelosArtifactMetadata | undefined {
    const saved = this.db
      .prepare(
        `SELECT i.input_sha256, r.artifact_id, r.revision
      FROM telos_artifact_request_inputs i JOIN telos_artifact_save_requests r
      ON r.session_id=i.session_id AND r.request_id=i.request_id
      WHERE i.session_id=? AND i.request_id=?`,
      )
      .get(sessionId, requestId) as
      { input_sha256: string; artifact_id: string; revision: number } | undefined;
    if (!saved) return undefined;
    if (saved.input_sha256 !== inputHash)
      throw new Error('Save request identity reused with different input');
    return metadata(this.row(saved.artifact_id, saved.revision));
  }
  save(input: {
    itemId: string;
    filename: string;
    title: string;
    bytes: Buffer;
    sessionId: string;
    sourcePath?: string;
    requestId?: string;
    requestInputHash?: string;
  }): TelosArtifactMetadata {
    artifactFilename.parse(input.filename);
    z.string().trim().min(1).max(200).parse(input.title);
    if (input.bytes.length > MAX_TELOS_ARTIFACT_BYTES) throw new Error('Artifact exceeds 5 MB');
    const id = createHash('sha256')
      .update(JSON.stringify([input.itemId, input.filename]))
      .digest('hex')
      .slice(0, 32);
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          input.itemId,
          input.filename,
          input.title,
          sha256,
          input.sourcePath ?? null,
        ]),
      )
      .digest('hex');
    return this.db
      .transaction(() => {
        if (input.requestId && input.requestInputHash) {
          const receipt = this.retryReceipt(
            input.sessionId,
            input.requestId,
            input.requestInputHash,
          );
          if (receipt) return receipt;
        }
        if (input.requestId) {
          const saved = this.db
            .prepare(
              'SELECT fingerprint, artifact_id, revision FROM telos_artifact_save_requests WHERE session_id=? AND request_id=?',
            )
            .get(input.sessionId, input.requestId) as
            { fingerprint: string; artifact_id: string; revision: number } | undefined;
          if (saved) {
            if (saved.fingerprint !== fingerprint)
              throw new Error('Save request identity reused with different input');
            return metadata(this.row(saved.artifact_id, saved.revision));
          }
        }
        const remember = (receipt: TelosArtifactMetadata) => {
          if (input.requestId)
            this.db
              .prepare('INSERT INTO telos_artifact_save_requests VALUES (?,?,?,?,?)')
              .run(input.sessionId, input.requestId, fingerprint, receipt.id, receipt.revision);
          if (input.requestId && input.requestInputHash)
            this.db
              .prepare('INSERT INTO telos_artifact_request_inputs VALUES (?,?,?)')
              .run(input.sessionId, input.requestId, input.requestInputHash);
          return receipt;
        };
        if (!this.db.prepare('SELECT id FROM items WHERE id=?').get(input.itemId))
          throw new Error('Telos item not found');
        const previous = this.db
          .prepare(
            'SELECT * FROM telos_artifact_revisions WHERE id=? ORDER BY revision DESC LIMIT 1',
          )
          .get(id) as ArtifactRow | undefined;
        if (
          previous?.sha256 === sha256 &&
          previous.title === input.title &&
          previous.session_id === input.sessionId &&
          previous.source_path === (input.sourcePath ?? null)
        )
          return remember(metadata(previous));
        const revision = (previous?.revision ?? 0) + 1;
        const now = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO telos_artifact_revisions
        (id, revision, item_id, filename, title, sha256, size, bytes, session_id, source_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            revision,
            input.itemId,
            input.filename,
            input.title,
            sha256,
            input.bytes.length,
            input.bytes,
            input.sessionId,
            input.sourcePath ?? null,
            now,
          );
        this.db
          .prepare(
            `INSERT OR REPLACE INTO links (id,item_id,type,url,title,description,created_at)
        VALUES (?,?,?,?,?,?,?)`,
          )
          .run(
            `artifact-${id}`,
            input.itemId,
            'artifact',
            `/api/telos/artifacts/${id}`,
            input.title,
            `Versioned Telos document: ${input.filename}`,
            now,
          );
        return remember(metadata(this.row(id, revision)));
      })
      .immediate();
  }
  private row(id: string, revision?: number): ArtifactRow {
    const row =
      revision === undefined
        ? this.db
            .prepare(
              'SELECT * FROM telos_artifact_revisions WHERE id=? ORDER BY revision DESC LIMIT 1',
            )
            .get(id)
        : this.db
            .prepare('SELECT * FROM telos_artifact_revisions WHERE id=? AND revision=?')
            .get(id, revision);
    if (!row) throw new Error('Artifact not found');
    return row as ArtifactRow;
  }
  read(id: string, revision?: number) {
    const row = this.row(id, revision);
    return { ...metadata(row), bytes: row.bytes };
  }
  list(filter: { itemId?: string; query?: string; limit?: number }): TelosArtifactMetadata[] {
    const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
    // instr treats the search text literally, including SQL wildcard characters.
    const rows = this.db
      .prepare(
        `SELECT a.id,a.item_id,a.filename,a.title,a.revision,a.sha256,a.size,a.session_id,a.source_path,a.created_at FROM telos_artifact_revisions a JOIN items i ON i.id=a.item_id
      WHERE a.revision=(SELECT MAX(b.revision) FROM telos_artifact_revisions b WHERE b.id=a.id)
      AND (? IS NULL OR a.item_id=?)
      AND (?='' OR instr(lower(a.title || ' ' || a.filename || ' ' || i.summary),lower(?))>0)
      ORDER BY a.created_at DESC,a.id LIMIT ?`,
      )
      .all(
        filter.itemId ?? null,
        filter.itemId ?? null,
        filter.query ?? '',
        filter.query ?? '',
        limit,
      ) as ArtifactRow[];
    return rows.map(metadata);
  }
}
