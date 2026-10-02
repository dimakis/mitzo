import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MAX_TELOS_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const artifactFilename = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^/\\\x00-\x1f\x7f]+$/)
  .refine((name) => name !== '.' && name !== '..');
export interface TelosArtifactMetadata {
  id: string;
  itemId: string;
  filename: string;
  title: string;
  revision: number;
  sha256: string;
  size: number;
  sessionId: string;
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
        CREATE INDEX IF NOT EXISTS telos_artifacts_item ON telos_artifact_revisions(item_id);`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  save(input: {
    itemId: string;
    filename: string;
    title: string;
    bytes: Buffer;
    sessionId: string;
    sourcePath?: string;
  }): TelosArtifactMetadata {
    artifactFilename.parse(input.filename);
    z.string().trim().min(1).max(200).parse(input.title);
    if (input.bytes.length > MAX_TELOS_ARTIFACT_BYTES) throw new Error('Artifact exceeds 5 MB');
    const id = createHash('sha256')
      .update(JSON.stringify([input.itemId, input.filename]))
      .digest('hex')
      .slice(0, 32);
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    return this.db.transaction(() => {
      if (!this.db.prepare('SELECT id FROM items WHERE id=?').get(input.itemId))
        throw new Error('Telos item not found');
      const previous = this.db
        .prepare('SELECT * FROM telos_artifact_revisions WHERE id=? ORDER BY revision DESC LIMIT 1')
        .get(id) as ArtifactRow | undefined;
      if (previous?.sha256 === sha256 && previous.title === input.title) return metadata(previous);
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
      return metadata(this.row(id, revision));
    })();
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
        `SELECT a.* FROM telos_artifact_revisions a JOIN items i ON i.id=a.item_id
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
