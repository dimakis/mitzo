import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { databaseBackupWatermark, backupOwnedDatabase } from '@mitzo/protocol/database-backup';
import { safeKnowledgePath } from './knowledge-library-source.js';

export interface KnowledgeDraftDocument {
  path: string;
  base: string;
  content: string;
}
export interface KnowledgeDraft {
  id: string;
  title: string;
  baseRevision: string;
  version: number;
  documents: KnowledgeDraftDocument[];
  updatedAt: string;
  state: 'draft' | 'in-review' | 'accepted' | 'closed';
  review?: { url: string; head: string; version: number };
  publication?: { head: string; version: number };
  error?: string;
}
export class KnowledgeDraftConflict extends Error {}
export type KnowledgeDraftSummary = Omit<KnowledgeDraft, 'documents' | 'publication'> & {
  documents: { path: string }[];
};
export class KnowledgeDraftStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS knowledge_drafts (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS knowledge_draft_leases (id TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS knowledge_draft_requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)',
    );
    if (
      !(this.db.pragma('table_info(knowledge_drafts)') as { name: string }[]).some(
        (column) => column.name === 'summary',
      )
    ) {
      this.db.exec('ALTER TABLE knowledge_drafts ADD COLUMN summary TEXT');
      this.db.transaction(() => {
        for (const draft of this.list()) this.put(draft);
      })();
    }
  }
  close() {
    this.db.close();
  }
  backupWatermark() {
    return databaseBackupWatermark(this.db);
  }
  backupSnapshot(destination: string) {
    return backupOwnedDatabase(this.db, destination);
  }
  list(): KnowledgeDraft[] {
    return (
      this.db.prepare('SELECT value FROM knowledge_drafts ORDER BY rowid DESC').all() as {
        value: string;
      }[]
    ).map((row) => JSON.parse(row.value) as KnowledgeDraft);
  }
  get(id: string): KnowledgeDraft {
    const row = this.db.prepare('SELECT value FROM knowledge_drafts WHERE id=?').get(id) as
      { value: string } | undefined;
    if (!row) throw new Error('Draft not found');
    return JSON.parse(row.value) as KnowledgeDraft;
  }
  listSummaries(): KnowledgeDraftSummary[] {
    return (
      this.db.prepare('SELECT summary FROM knowledge_drafts ORDER BY rowid DESC').all() as {
        summary: string;
      }[]
    ).map((row) => JSON.parse(row.summary) as KnowledgeDraftSummary);
  }
  assertIdle(id: string) {
    const lease = this.db
      .prepare('SELECT expires FROM knowledge_draft_leases WHERE id=?')
      .get(id) as { expires: number } | undefined;
    if (lease && lease.expires > Date.now())
      throw new KnowledgeDraftConflict(
        'This draft is saving its review. Try again when it finishes.',
      );
  }
  acquire(id: string) {
    return this.db.transaction(() => {
      this.assertIdle(id);
      const token = randomUUID();
      this.db
        .prepare('INSERT OR REPLACE INTO knowledge_draft_leases(id,token,expires) VALUES(?,?,?)')
        .run(id, token, Date.now() + 180_000);
      return token;
    })();
  }
  release(id: string, token: string) {
    this.db.prepare('DELETE FROM knowledge_draft_leases WHERE id=? AND token=?').run(id, token);
  }
  assertLease(id: string, token: string) {
    const lease = this.db
      .prepare('SELECT token, expires FROM knowledge_draft_leases WHERE id=?')
      .get(id) as { token: string; expires: number } | undefined;
    if (!lease || lease.token !== token || lease.expires <= Date.now())
      throw new KnowledgeDraftConflict(
        'The review lease expired. Refresh this draft before continuing.',
      );
  }
  private writable(id: string, lease?: string) {
    if (lease) this.assertLease(id, lease);
    else this.assertIdle(id);
  }
  private validate(documents: KnowledgeDraftDocument[]) {
    if (
      !documents.length ||
      documents.length > 20 ||
      new Set(documents.map((d) => d.path)).size !== documents.length ||
      documents.some(
        (d) =>
          !safeKnowledgePath(d.path) ||
          [d.content, d.base].some(
            (value) =>
              value.includes('\0') || Buffer.from(value, 'utf8').toString('utf8') !== value,
          ) ||
          Buffer.byteLength(d.content) > 5 * 1024 * 1024 ||
          Buffer.byteLength(d.base) > 5 * 1024 * 1024,
      ) ||
      Buffer.byteLength(JSON.stringify(documents)) > 12 * 1024 * 1024
    )
      throw new Error('Draft documents are invalid or too large');
  }
  private put(draft: KnowledgeDraft) {
    const summary: KnowledgeDraftSummary = {
      id: draft.id,
      title: draft.title,
      baseRevision: draft.baseRevision,
      version: draft.version,
      documents: draft.documents.map((d) => ({ path: d.path })),
      state: draft.state,
      updatedAt: draft.updatedAt,
      review: draft.review,
      error: draft.error,
    };
    this.db
      .prepare(
        'INSERT INTO knowledge_drafts(id,value,summary) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,summary=excluded.summary',
      )
      .run(draft.id, JSON.stringify(draft), JSON.stringify(summary));
    return draft;
  }
  create(
    title: string,
    baseRevision: string,
    documents: KnowledgeDraftDocument[],
    requestId?: string,
  ) {
    this.validate(documents);
    if (!title.trim() || title.length > 200 || !/^[a-f0-9]{40,64}$/.test(baseRevision))
      throw new Error('Draft metadata is invalid');
    if (
      requestId &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)
    )
      throw new Error('Save request identity is invalid');
    const id = requestId ?? randomUUID();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ title: title.trim(), baseRevision, documents }))
      .digest('hex');
    return this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT fingerprint FROM knowledge_draft_requests WHERE id=?')
        .get(id) as { fingerprint: string } | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new KnowledgeDraftConflict(
            'This save request already created a draft with different content. Reload its saved draft before continuing.',
          );
        return this.get(id);
      }
      const draft = this.put({
        id,
        title: title.trim(),
        baseRevision,
        version: 1,
        documents,
        state: 'draft',
        updatedAt: new Date().toISOString(),
      });
      this.db
        .prepare('INSERT INTO knowledge_draft_requests(id,fingerprint) VALUES(?,?)')
        .run(id, fingerprint);
      return draft;
    })();
  }
  save(id: string, version: number, documents: KnowledgeDraftDocument[], baseRevision?: string) {
    this.validate(documents);
    return this.db.transaction(() => {
      this.assertIdle(id);
      const draft = this.get(id);
      if (draft.version !== version)
        throw new KnowledgeDraftConflict('Draft changed in another window. Reload before saving.');
      if (draft.state === 'accepted' || draft.state === 'closed')
        throw new KnowledgeDraftConflict('This change is finished. Start a new draft.');
      return this.put({
        ...draft,
        baseRevision: baseRevision ?? draft.baseRevision,
        documents,
        version: version + 1,
        state: 'draft',
        error: undefined,
        updatedAt: new Date().toISOString(),
      });
    })();
  }
  receipt(id: string, version: number, review: { url: string; head: string }, lease?: string) {
    return this.db.transaction(() => {
      this.writable(id, lease);
      const draft = this.get(id);
      if (version !== draft.version)
        throw new KnowledgeDraftConflict('Draft changed while saving its review');
      return this.put({
        ...draft,
        review: { ...review, version },
        state: 'in-review',
        error: undefined,
      });
    })();
  }
  prepared(id: string, version: number, head: string, lease?: string) {
    return this.db.transaction(() => {
      this.writable(id, lease);
      const draft = this.get(id);
      if (version !== draft.version)
        throw new KnowledgeDraftConflict('Draft changed while preparing its review');
      return this.put({ ...draft, publication: { version, head } });
    })();
  }
  status(
    id: string,
    state: KnowledgeDraft['state'],
    error?: string,
    lease?: string,
    version?: number,
  ) {
    return this.db.transaction(() => {
      this.writable(id, lease);
      const draft = this.get(id);
      if (version !== undefined && draft.version !== version)
        throw new KnowledgeDraftConflict('Draft changed while checking its review');
      return this.put({ ...draft, state, error });
    })();
  }
}
