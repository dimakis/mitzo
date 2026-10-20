import { databaseBackupWatermark, backupOwnedDatabase } from '@mitzo/protocol/database-backup';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { extname } from 'node:path';
import {
  findArtifactCapabilityByExtension,
  TelosSourceMaterialCursorSchema,
  type TelosSourceMaterialCursor,
} from '@mitzo/protocol';

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
  sourceKind:
    'user_upload' | 'user_edit' | 'session_artifact' | 'external_codex_report' | 'source_capture';
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
    sourceKind: row.session_id.startsWith('source-capture:')
      ? 'source_capture'
      : row.session_id.startsWith('user-upload:')
        ? 'user_upload'
        : row.session_id.startsWith('user-edit:')
          ? 'user_edit'
          : row.session_id.startsWith('external-codex:')
            ? 'external_codex_report'
            : 'session_artifact',
    sourcePath: row.source_path,
    createdAt: row.created_at,
    url: `/api/telos/artifacts/${row.id}?revision=${row.revision}`,
  };
}
/** Format already-read bytes using the existing preview policy. This helper
 * grants no read/access authority; response owners must validate retained custody.
 */
export function describeTelosArtifactDocument(
  artifact: TelosArtifactMetadata & { bytes: Buffer },
  editableAllowed: boolean,
) {
  const ext = extname(artifact.filename).toLowerCase();
  const content = artifact.bytes.toString('utf8');
  const text = !artifact.bytes.includes(0) && Buffer.from(content).equals(artifact.bytes);
  const preview =
    text &&
    [
      '.md',
      '.mdx',
      '.html',
      '.htm',
      '.txt',
      '.json',
      '.csv',
      '.yaml',
      '.yml',
      '.css',
      '.js',
      '.ts',
      '.tsx',
      '.jsx',
      '.py',
      '.sh',
      '.svg',
    ].includes(ext);
  return {
    path: artifact.url,
    name: artifact.filename,
    ext,
    revision: artifact.revision,
    editable:
      artifact.sourceKind !== 'source_capture' &&
      text &&
      editableAllowed &&
      (['.md', '.mdx'].includes(ext) ||
        findArtifactCapabilityByExtension(ext)?.artifact?.editable === true),
    previewUnavailable: !preview,
    content: preview
      ? content
      : 'This file has no in-app preview. Use the file options to share or save it.',
  };
}

/** Content and item links commit together in the canonical Telos database, outside sandboxes. */
export class TelosArtifactStore {
  private db: Database.Database;
  private readonly ownsConnection: boolean;
  /** Internal host composition only. The work owner retains transaction/close
   * authority for a borrowed connection; save/read retain their existing checks. */
  static borrowConnection(database: Database.Database): TelosArtifactStore {
    return new TelosArtifactStore('', database);
  }
  /** Observe an already initialized canonical owner without migration or writes. */
  static openReadOnly(path: string): TelosArtifactStore {
    return new TelosArtifactStore(path, undefined, true);
  }
  constructor(path: string, borrowedDatabase?: Database.Database, readOnly = false) {
    this.ownsConnection = borrowedDatabase === undefined;
    this.db = borrowedDatabase ?? new Database(path, { fileMustExist: true, readonly: readOnly });
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    try {
      this.db.prepare('SELECT id FROM items LIMIT 1').get();
      this.db.prepare('SELECT id FROM links LIMIT 1').get();
      if (readOnly) {
        this.db.prepare('SELECT id FROM telos_artifact_revisions LIMIT 0').all();
        return;
      }
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
        CREATE INDEX IF NOT EXISTS telos_artifacts_item ON telos_artifact_revisions(item_id);
        CREATE INDEX IF NOT EXISTS telos_artifacts_source_page ON telos_artifact_revisions(session_id,created_at,id,revision);
        CREATE INDEX IF NOT EXISTS telos_artifacts_origin ON telos_artifact_revisions(id,item_id,session_id);`);
    } catch (error) {
      if (this.ownsConnection) this.db.close();
      throw error;
    }
  }
  /** Captured only through the existing owner connection; source files remain live. */
  backupWatermark(): string {
    return databaseBackupWatermark(this.db);
  }
  backupSnapshot(destination: string): Promise<void> {
    return backupOwnedDatabase(this.db, destination);
  }

  close() {
    if (this.ownsConnection) this.db.close();
  }
  /** Match the submitted request, not mutable workspace bytes, before reading a path. */
  /** Shared task outputs are not a private LifeOps evidence vault. */
  userUploadAllowed(itemId: string): boolean {
    const item = this.db.prepare('SELECT * FROM items WHERE id=?').get(itemId) as
      { profile?: string } | undefined;
    if (!item) throw new Error('Telos item not found');
    return !/^life[-_ ]?ops$/i.test(item.profile ?? '');
  }

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
        // New authenticated operator requests represent explicit revision intent.
        // Their retries were resolved above; agent saves retain content deduplication.
        const explicitUpload = input.sessionId.startsWith('user-upload:') && !!input.requestId;
        if (
          !explicitUpload &&
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
        // Reviewed source packets are retained evidence. Their pinned source
        // relationship is owned by TelosWorkStore, not a produced file/link.
        if (!input.sessionId.startsWith('source-capture:'))
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
  /** Resolve legacy human "latest" reads to one exact metadata revision before
   * authorization awaits or byte hydration. Explicit selectors never use this.
   */
  latestMetadata(id: string): TelosArtifactMetadata {
    const row = this.db
      .prepare(
        'SELECT revision FROM telos_artifact_revisions WHERE id=? ORDER BY revision DESC LIMIT 1',
      )
      .get(id) as { revision: number } | undefined;
    if (!row) throw new Error('Artifact not found');
    return this.metadataForRevision(id, row.revision);
  }
  /** Exact metadata only: length/typeof inspect custody without transferring a BLOB.
   * This is not authorization; the caller must renew current item/access policy.
   */
  metadataForRevision(id: string, revision: number): TelosArtifactMetadata {
    z.number().int().positive().safe().parse(revision);
    const row = this.db
      .prepare(
        `SELECT id,item_id,filename,title,revision,sha256,size,
      session_id,source_path,created_at,length(bytes) AS actual_size,typeof(bytes) AS byte_type
      FROM telos_artifact_revisions WHERE id=? AND revision=?`,
      )
      .get(id, revision) as (ArtifactRow & { actual_size: number; byte_type: string }) | undefined;
    this.assertByteCustody(row);
    return metadata(row!);
  }
  /** Refuse before BLOB transfer when either metadata or actual custody exceeds the
   * caller's bound. The SQL projection also guards a concurrent size/custody change.
   */
  readBoundedRevision(id: string, revision: number, maxBytes: number) {
    z.number().int().positive().safe().parse(revision);
    z.number().int().positive().safe().parse(maxBytes);
    const row = this.db
      .prepare(
        `SELECT id,item_id,filename,title,revision,sha256,size,
      session_id,source_path,created_at,length(bytes) AS actual_size,typeof(bytes) AS byte_type,
      CASE WHEN typeof(bytes)='blob' AND typeof(size)='integer' AND size>=0
        AND size=length(bytes) AND size<=? AND length(bytes)<=? THEN bytes END AS bytes
      FROM telos_artifact_revisions WHERE id=? AND revision=?`,
      )
      .get(maxBytes, maxBytes, id, revision) as
      (ArtifactRow & { actual_size: number; byte_type: string }) | undefined;
    this.assertByteCustody(row);
    if (row!.size > maxBytes || !Buffer.isBuffer(row!.bytes))
      throw new Error('Artifact exceeds read bound');
    return { ...metadata(row!), bytes: row!.bytes };
  }
  private assertByteCustody(
    row: (ArtifactRow & { actual_size: number; byte_type: string }) | undefined,
  ) {
    if (!row) throw new Error('Artifact not found');
    if (
      row.byte_type !== 'blob' ||
      !Number.isSafeInteger(row.size) ||
      row.size < 0 ||
      row.size !== row.actual_size
    )
      throw new Error('Artifact byte custody unavailable');
  }
  /** Metadata-only history for an existing public artifact. Exact revision keyset
   * paging does not hydrate bytes or turn origin identity into an access grant.
   */
  revisionPage(id: string, options: { beforeRevision?: number; limit?: number } = {}) {
    z.string()
      .regex(/^[a-f0-9]{32}$/)
      .parse(id);
    const before =
      options.beforeRevision === undefined
        ? null
        : z.number().int().positive().safe().parse(options.beforeRevision);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(50)
      .parse(options.limit ?? 50);
    return this.db.transaction(() => {
      const owner = this.db
        .prepare(
          'SELECT item_id,session_id FROM telos_artifact_revisions WHERE id=? ORDER BY revision DESC LIMIT 1',
        )
        .get(id) as { item_id: string; session_id: string } | undefined;
      if (!owner) throw new Error('Artifact not found');
      const assertPublic = () => {
        if (
          owner.session_id.startsWith('source-capture:') ||
          !this.userUploadAllowed(owner.item_id)
        )
          throw Object.assign(new Error('Saved artifact history unavailable'), { status: 403 });
      };
      assertPublic();
      const rows = this.db
        .prepare(
          `SELECT id,item_id,filename,title,revision,sha256,size,
        session_id,source_path,created_at FROM telos_artifact_revisions
        WHERE id=? AND item_id=? AND (? IS NULL OR revision<?)
        AND instr(session_id,'source-capture:')<>1
        ORDER BY revision DESC LIMIT ?`,
        )
        .all(id, owner.item_id, before, before, limit + 1) as ArtifactRow[];
      const artifacts = rows.slice(0, limit).map(metadata);
      assertPublic();
      const hasMore = rows.length > limit;
      return { artifacts, cursor: hasMore ? artifacts.at(-1)!.revision : null, hasMore };
    })();
  }
  /** Exact retained revision metadata, with current access filtering before
   * the bounded page. Never loads content bytes or substitutes latest revisions. */
  sourceMaterialPage(sessionId: string, after?: TelosSourceMaterialCursor) {
    const cursor = after === undefined ? undefined : TelosSourceMaterialCursorSchema.parse(after);
    // Older canonical fixtures may omit profile; userUploadAllowed treats that
    // shape as public too. Keep its exact optional-separator/case policy.
    const hasProfile = (
      this.db.prepare('PRAGMA table_info(items)').all() as Array<{ name: string }>
    ).some((column) => column.name === 'profile');
    const policy = hasProfile
      ? "lower(coalesce(i.profile,'')) NOT IN ('lifeops','life-ops','life_ops','life ops')"
      : '1=1';
    const rows = this.db
      .prepare(
        `SELECT a.id,a.item_id,a.filename,a.title,a.revision,a.sha256,a.size,a.session_id,a.source_path,a.created_at
      FROM telos_artifact_revisions a JOIN items i ON i.id=a.item_id
      WHERE a.session_id=? AND ${policy}
      ${cursor ? 'AND (a.created_at,a.id,a.revision) > (?,?,?)' : ''}
      ORDER BY a.created_at,a.id,a.revision LIMIT 101`,
      )
      .all(
        sessionId,
        ...(cursor ? [cursor.createdAt, cursor.artifactId, cursor.revision] : []),
      ) as ArtifactRow[];
    const page = rows.slice(0, 100);
    const last = page.at(-1);
    return {
      artifacts: page.map(metadata),
      cursor: last
        ? { createdAt: last.created_at, artifactId: last.id, revision: last.revision }
        : null,
      hasMore: rows.length > 100,
    };
  }
  /** Metadata relation only, never live access or admission authority. An exact
   * selected revision may follow an earlier revision created in this source.
   * The item must match across revisions; another artifact or Work membership
   * cannot supply association. No transcript, latest substitution or BLOB read.
   */
  hasConversationOrigin(id: string, revision: number, sessionId: string): boolean {
    z.string()
      .regex(/^[a-f0-9]{32}$/)
      .parse(id);
    z.number().int().positive().safe().parse(revision);
    z.string().min(1).max(200).parse(sessionId);
    return this.db.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT selected.item_id FROM telos_artifact_revisions selected
        WHERE selected.id=? AND selected.revision=? AND EXISTS (
          SELECT 1 FROM telos_artifact_revisions origin
          WHERE origin.id=selected.id AND origin.item_id=selected.item_id
            AND origin.session_id=? AND instr(origin.session_id,'source-capture:')<>1)`,
        )
        .get(id, revision, sessionId) as { item_id: string } | undefined;
      return row !== undefined && this.userUploadAllowed(row.item_id);
    })();
  }
  document(id: string, revision?: number) {
    const artifact = this.read(id, revision);
    return describeTelosArtifactDocument(
      artifact,
      artifact.sourceKind !== 'source_capture' && this.userUploadAllowed(artifact.itemId),
    );
  }
  /** Compare and append under one writer lock; successful retries precede the revision fence. */
  editDocument(input: {
    id: string;
    expectedRevision: number;
    content: string;
    requestId: string;
    operatorId: string;
  }): TelosArtifactMetadata {
    const sessionId = `user-edit:${input.operatorId}`;
    const requestInputHash = createHash('sha256')
      .update(JSON.stringify([input.id, input.expectedRevision, input.content]))
      .digest('hex');
    return this.db
      .transaction(() => {
        const receipt = this.retryReceipt(sessionId, input.requestId, requestInputHash);
        if (receipt) return receipt;
        const latest = this.read(input.id);
        if (!this.userUploadAllowed(latest.itemId))
          throw Object.assign(new Error('LifeOps documents require private case storage.'), {
            status: 403,
          });
        if (
          !this.document(input.id).editable ||
          input.content.includes('\u0000') ||
          Buffer.from(input.content).toString('utf8') !== input.content
        )
          throw Object.assign(new Error('This document cannot be edited in Mitzo.'), {
            status: 400,
          });
        if (latest.revision !== input.expectedRevision)
          throw Object.assign(
            new Error(
              'A newer revision is available. Review the latest version before saving; your draft is preserved.',
            ),
            { status: 409 },
          );
        return this.save({
          itemId: latest.itemId,
          filename: latest.filename,
          title: latest.title,
          bytes: Buffer.from(input.content),
          sessionId,
          requestId: input.requestId,
          requestInputHash,
        });
      })
      .immediate();
  }
  list(filter: {
    itemId?: string;
    query?: string;
    limit?: number;
    excludeSourceCaptures?: boolean;
  }): TelosArtifactMetadata[] {
    const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
    // instr treats the search text literally, including SQL wildcard characters.
    const rows = this.db
      .prepare(
        `SELECT a.id,a.item_id,a.filename,a.title,a.revision,a.sha256,a.size,a.session_id,a.source_path,a.created_at FROM telos_artifact_revisions a JOIN items i ON i.id=a.item_id
      WHERE a.revision=(SELECT MAX(b.revision) FROM telos_artifact_revisions b WHERE b.id=a.id)
      AND (? IS NULL OR a.item_id=?)
      AND (?='' OR instr(lower(a.title || ' ' || a.filename || ' ' || i.summary),lower(?))>0)
      AND (?=0 OR instr(a.session_id,'source-capture:')<>1)
      ORDER BY a.created_at DESC,a.id LIMIT ?`,
      )
      .all(
        filter.itemId ?? null,
        filter.itemId ?? null,
        filter.query ?? '',
        filter.query ?? '',
        filter.excludeSourceCaptures ? 1 : 0,
        limit,
      ) as ArtifactRow[];
    return rows.map(metadata);
  }
}
