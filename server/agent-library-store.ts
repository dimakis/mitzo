import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { AgentLibraryCatalog, AgentLibraryDraft } from '@mitzo/protocol';
import { PortableProfileDefinitionSchema } from './symposium-profile-portability.js';
import {
  SymposiumProfileStore,
  SymposiumProfileVersionSchema,
  type SymposiumProfileVersion,
} from './symposium-profiles.js';

const Id = z.string().trim().min(1).max(128);
const SaveDraft = z.strictObject({
  profileId: Id,
  expectedVersion: z.number().int().nonnegative(),
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: Id,
  definition: PortableProfileDefinitionSchema,
});
const Publish = z.strictObject({
  profileId: Id,
  expectedVersion: z.number().int().positive(),
  idempotencyKey: Id,
});
const ImportDraft = z.strictObject({
  profileId: Id,
  artifact: z.union([
    SymposiumProfileVersionSchema,
    z.strictObject({ definition: PortableProfileDefinitionSchema }),
  ]),
  idempotencyKey: Id,
});
type DraftRow = {
  profile_id: string;
  version: number;
  base_revision: number;
  definition: string;
  state: string;
};
const fromRow = (row: DraftRow): AgentLibraryDraft => ({
  profileId: row.profile_id,
  version: row.version,
  baseRevision: row.base_revision,
  definition: PortableProfileDefinitionSchema.parse(JSON.parse(row.definition)),
});
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Draft lifecycle over the same published versions consumed by Symposium. */
export class AgentLibraryStore {
  private readonly db: Database.Database;
  private readonly profiles: SymposiumProfileStore;
  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.profiles = new SymposiumProfileStore(dbPath, this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_library_drafts (
        owner TEXT NOT NULL, profile_id TEXT NOT NULL, version INTEGER NOT NULL,
        base_revision INTEGER NOT NULL, definition TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('draft', 'published')),
        PRIMARY KEY(owner, profile_id)
      );
      CREATE TABLE IF NOT EXISTS agent_library_retries (
        owner TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        result TEXT NOT NULL, PRIMARY KEY(owner, idempotency_key)
      );
    `);
  }
  close() {
    this.db.close();
  }
  getDraft(owner: string, profileId: string): AgentLibraryDraft | null {
    Id.parse(owner);
    Id.parse(profileId);
    const row = this.db
      .prepare(
        `SELECT * FROM agent_library_drafts WHERE owner = ? AND profile_id = ? AND state = 'draft'`,
      )
      .get(owner, profileId) as DraftRow | undefined;
    return row ? fromRow(row) : null;
  }
  list(owner: string): AgentLibraryCatalog {
    Id.parse(owner);
    const drafts = (
      this.db
        .prepare(
          `SELECT * FROM agent_library_drafts WHERE owner = ? AND state = 'draft' ORDER BY profile_id`,
        )
        .all(owner) as DraftRow[]
    ).map(fromRow);
    return { drafts, versions: this.profiles.list(owner) };
  }
  version(owner: string, profileId: string, revision: number) {
    return this.profiles.get(owner, profileId, revision);
  }
  private retry<T>(owner: string, key: string, input: unknown, execute: () => T): T {
    Id.parse(owner);
    return this.db
      .transaction(() => {
        const requestHash = hash(input);
        const prior = this.db
          .prepare(
            'SELECT request_hash, result FROM agent_library_retries WHERE owner = ? AND idempotency_key = ?',
          )
          .get(owner, key) as { request_hash: string; result: string } | undefined;
        if (prior) {
          if (prior.request_hash !== requestHash)
            throw Error('Conflicting library idempotency key');
          return JSON.parse(prior.result) as T;
        }
        const result = execute();
        this.db
          .prepare('INSERT INTO agent_library_retries VALUES (?, ?, ?, ?)')
          .run(owner, key, requestHash, JSON.stringify(result));
        return result;
      })
      .immediate();
  }
  saveDraft(owner: string, input: unknown): AgentLibraryDraft {
    const request = SaveDraft.parse(input);
    return this.retry(owner, request.idempotencyKey, { operation: 'draft', ...request }, () => {
      const current = this.getDraft(owner, request.profileId);
      if ((current?.version ?? 0) !== request.expectedVersion)
        throw Error('Draft version conflict');
      if ((this.profiles.get(owner, request.profileId)?.revision ?? 0) !== request.expectedRevision)
        throw Error('Profile revision conflict');
      const prior = this.db
        .prepare('SELECT version FROM agent_library_drafts WHERE owner = ? AND profile_id = ?')
        .get(owner, request.profileId) as { version: number } | undefined;
      const saved = {
        profileId: request.profileId,
        version: (prior?.version ?? 0) + 1,
        baseRevision: request.expectedRevision,
        definition: request.definition,
      };
      this.db
        .prepare(
          `INSERT INTO agent_library_drafts VALUES (?, ?, ?, ?, ?, 'draft')
        ON CONFLICT(owner, profile_id) DO UPDATE SET version = excluded.version,
        base_revision = excluded.base_revision, definition = excluded.definition, state = 'draft'`,
        )
        .run(
          owner,
          saved.profileId,
          saved.version,
          saved.baseRevision,
          JSON.stringify(saved.definition),
        );
      return saved;
    });
  }
  publish(owner: string, input: unknown): SymposiumProfileVersion {
    const request = Publish.parse(input);
    return this.retry(owner, request.idempotencyKey, { operation: 'publish', ...request }, () => {
      const draft = this.getDraft(owner, request.profileId);
      if (!draft) throw Error('Profile draft not found');
      if (draft.version !== request.expectedVersion) throw Error('Draft version conflict');
      const published = this.profiles.save(owner, {
        profileId: draft.profileId,
        expectedRevision: draft.baseRevision,
        definition: draft.definition,
        idempotencyKey: `library:${hash(request.idempotencyKey)}`,
      });
      this.db
        .prepare(
          `UPDATE agent_library_drafts SET state = 'published' WHERE owner = ? AND profile_id = ?`,
        )
        .run(owner, draft.profileId);
      return published;
    });
  }
  importDraft(owner: string, input: unknown): AgentLibraryDraft {
    const request = ImportDraft.parse(input);
    if (
      'contentHash' in request.artifact &&
      hash(request.artifact.definition) !== request.artifact.contentHash
    )
      throw Error('Profile content hash mismatch');
    return this.retry(owner, request.idempotencyKey, { operation: 'import', ...request }, () => {
      if (this.getDraft(owner, request.profileId) || this.profiles.get(owner, request.profileId))
        throw Error('Imported profile identity conflict');
      return this.saveDraft(owner, {
        profileId: request.profileId,
        expectedVersion: 0,
        expectedRevision: 0,
        definition: request.artifact.definition,
        idempotencyKey: `import:${hash(request.idempotencyKey)}`,
      });
    });
  }
}
