import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
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
export class KnowledgeDraftStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS knowledge_drafts (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS knowledge_draft_leases (id TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL)',
    );
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
  private validate(documents: KnowledgeDraftDocument[]) {
    if (
      !documents.length ||
      documents.length > 20 ||
      new Set(documents.map((d) => d.path)).size !== documents.length ||
      documents.some(
        (d) =>
          !safeKnowledgePath(d.path) ||
          Buffer.byteLength(d.content) > 5 * 1024 * 1024 ||
          Buffer.byteLength(d.base) > 5 * 1024 * 1024,
      ) ||
      Buffer.byteLength(JSON.stringify(documents)) > 12 * 1024 * 1024
    )
      throw new Error('Draft documents are invalid or too large');
  }
  private put(draft: KnowledgeDraft) {
    this.db
      .prepare('INSERT OR REPLACE INTO knowledge_drafts(id,value) VALUES(?,?)')
      .run(draft.id, JSON.stringify(draft));
    return draft;
  }
  create(title: string, baseRevision: string, documents: KnowledgeDraftDocument[]) {
    this.validate(documents);
    if (!title.trim() || title.length > 200 || !/^[a-f0-9]{40,64}$/.test(baseRevision))
      throw new Error('Draft metadata is invalid');
    return this.put({
      id: randomUUID(),
      title: title.trim(),
      baseRevision,
      version: 1,
      documents,
      state: 'draft',
      updatedAt: new Date().toISOString(),
    });
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
  receipt(id: string, version: number, review: { url: string; head: string }) {
    return this.db.transaction(() => {
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
  prepared(id: string, version: number, head: string) {
    return this.db.transaction(() => {
      const draft = this.get(id);
      if (version !== draft.version)
        throw new KnowledgeDraftConflict('Draft changed while preparing its review');
      return this.put({ ...draft, publication: { version, head } });
    })();
  }
  status(id: string, state: KnowledgeDraft['state'], error?: string) {
    return this.db.transaction(() => this.put({ ...this.get(id), state, error }))();
  }
}
