import Database from 'better-sqlite3';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import {
  ContextPackDefinitionSchema,
  ContextPackDraftSchema,
  PublishedContextPackSchema,
  type ContextPackDefinition,
  type ContextPackDraft,
  type PublishedContextPack,
} from '@mitzo/protocol';

export class ContextPackConflict extends Error {}
export class ContextPackMissing extends Error {}
export function contextPackHash(definition: ContextPackDefinition) {
  // Schema parsing fixes property order and strips no unknown authority fields.
  return createHash('sha256')
    .update(JSON.stringify(ContextPackDefinitionSchema.parse(definition)))
    .digest('hex');
}
/** Shared tables in the private Knowledge draft DB. Published records are insert-only. */
export class ContextPackStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS context_pack_drafts (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS context_pack_revisions (id TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,revision));',
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS context_pack_requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, value TEXT NOT NULL); CREATE TRIGGER IF NOT EXISTS context_pack_no_update BEFORE UPDATE ON context_pack_revisions BEGIN SELECT RAISE(ABORT,'Published pack revisions are immutable'); END; CREATE TRIGGER IF NOT EXISTS context_pack_no_delete BEFORE DELETE ON context_pack_revisions BEGIN SELECT RAISE(ABORT,'Published pack revisions are immutable'); END;",
    );
  }
  close() {
    this.db.close();
  }
  list(): { packs: PublishedContextPack[]; drafts: ContextPackDraft[] } {
    const packs = (
      this.db
        .prepare(
          'SELECT r.value FROM context_pack_revisions r WHERE r.revision=(SELECT MAX(p.revision) FROM context_pack_revisions p WHERE p.id=r.id) ORDER BY r.id',
        )
        .all() as { value: string }[]
    ).map((row) => this.readPublished(row.value));
    const drafts = (
      this.db.prepare('SELECT value FROM context_pack_drafts ORDER BY rowid DESC').all() as {
        value: string;
      }[]
    ).map((row) => ContextPackDraftSchema.parse(JSON.parse(row.value)));
    return { packs, drafts };
  }
  revisions(id: string): PublishedContextPack[] {
    return (
      this.db
        .prepare('SELECT value FROM context_pack_revisions WHERE id=? ORDER BY revision DESC')
        .all(id) as { value: string }[]
    ).map((row) => this.readPublished(row.value));
  }
  getRevision(id: string, revision: number): PublishedContextPack {
    const row = this.db
      .prepare('SELECT value FROM context_pack_revisions WHERE id=? AND revision=?')
      .get(id, revision) as { value: string } | undefined;
    if (!row) throw new ContextPackMissing('Pack revision not found');
    return this.readPublished(row.value);
  }
  private readPublished(value: string) {
    const pack = PublishedContextPackSchema.parse(JSON.parse(value));
    if (contextPackHash(pack.definition) !== pack.hash)
      throw new ContextPackConflict('Published pack integrity check failed');
    return pack;
  }
  getDraft(id: string): ContextPackDraft {
    const row = this.db.prepare('SELECT value FROM context_pack_drafts WHERE id=?').get(id) as
      { value: string } | undefined;
    if (!row) throw new ContextPackMissing('Pack draft not found');
    return ContextPackDraftSchema.parse(JSON.parse(row.value));
  }
  private put(draft: ContextPackDraft) {
    const parsed = ContextPackDraftSchema.parse(draft);
    this.db
      .prepare(
        'INSERT INTO context_pack_drafts(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      )
      .run(parsed.id, JSON.stringify(parsed));
    return parsed;
  }
  private latest(id: string) {
    return (
      (
        this.db
          .prepare('SELECT MAX(revision) AS revision FROM context_pack_revisions WHERE id=?')
          .get(id) as { revision: number | null }
      ).revision ?? 0
    );
  }
  private request<T>(key: string | undefined, input: unknown, work: () => T): T {
    if (!key) return work();
    z.string().uuid().parse(key);
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const row = this.db
      .prepare('SELECT fingerprint,value FROM context_pack_requests WHERE id=?')
      .get(key) as { fingerprint: string; value: string } | undefined;
    if (row) {
      if (row.fingerprint !== fingerprint)
        throw new ContextPackConflict('Save request was used with different content');
      return JSON.parse(row.value) as T;
    }
    const value = work();
    this.db
      .prepare('INSERT INTO context_pack_requests(id,fingerprint,value) VALUES(?,?,?)')
      .run(key, fingerprint, JSON.stringify(value));
    return value;
  }
  create(definition: ContextPackDefinition, requestId?: string) {
    const parsed = ContextPackDefinitionSchema.parse(definition);
    return this.db.transaction(() =>
      this.request(requestId, { operation: 'create', definition: parsed }, () =>
        this.put({
          id: randomUUID(),
          version: 1,
          baseRevision: this.latest(parsed.id),
          definition: parsed,
          state: 'draft',
          updatedAt: new Date().toISOString(),
        }),
      ),
    )();
  }
  save(id: string, version: number, definition: ContextPackDefinition, requestId?: string) {
    const parsed = ContextPackDefinitionSchema.parse(definition);
    return this.db.transaction(() =>
      this.request(requestId, { operation: 'save', id, version, definition: parsed }, () => {
        const draft = this.getDraft(id);
        if (draft.version !== version)
          throw new ContextPackConflict('Draft changed. Reload before saving.');
        if (draft.state === 'published')
          throw new ContextPackConflict('Draft is published. Create a new draft.');
        if (draft.definition.id !== parsed.id)
          throw new ContextPackConflict('Pack identity cannot change in a draft');
        return this.put({
          ...draft,
          version: version + 1,
          definition: parsed,
          updatedAt: new Date().toISOString(),
        });
      }),
    )();
  }
  /** Call only after trusted source validation, then recheck the exact draft version atomically. */
  publish(id: string, version: number): PublishedContextPack {
    return this.db.transaction(() => {
      const draft = this.getDraft(id);
      if (draft.version !== version)
        throw new ContextPackConflict('Draft changed. Reload before publishing.');
      if (draft.state === 'published')
        return this.getRevision(draft.definition.id, draft.publishedRevision!);
      const latest = this.latest(draft.definition.id);
      if (latest !== draft.baseRevision)
        throw new ContextPackConflict(
          'A newer pack revision was published. Create a draft from the latest revision.',
        );
      const pack = PublishedContextPackSchema.parse({
        id: draft.definition.id,
        revision: latest + 1,
        hash: contextPackHash(draft.definition),
        definition: draft.definition,
        publishedAt: new Date().toISOString(),
      });
      this.db
        .prepare('INSERT INTO context_pack_revisions(id,revision,value) VALUES(?,?,?)')
        .run(pack.id, pack.revision, JSON.stringify(pack));
      this.put({ ...draft, state: 'published', publishedRevision: pack.revision });
      return pack;
    })();
  }
}
