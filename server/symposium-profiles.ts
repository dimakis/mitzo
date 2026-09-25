import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SymposiumProfileDefinitionSchema, type SymposiumProfileDefinition } from '@mitzo/protocol';

const Id = z.string().trim().min(1).max(128);
const VersionSchema = z.strictObject({
  profileId: Id,
  revision: z.number().int().positive(),
  definition: SymposiumProfileDefinitionSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const SaveSchema = z.strictObject({
  profileId: Id,
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: Id,
  definition: SymposiumProfileDefinitionSchema,
});

export type SymposiumProfileVersion = z.infer<typeof VersionSchema>;
export type SaveSymposiumProfile = z.infer<typeof SaveSchema>;

type VersionRow = {
  profile_id: string;
  revision: number;
  definition: string;
  content_hash: string;
};
type RetryRow = { request_hash: string; profile_id: string; revision: number };

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const contentHash = (definition: SymposiumProfileDefinition): string =>
  sha256(JSON.stringify(definition));
const fromRow = (row: VersionRow): SymposiumProfileVersion => ({
  profileId: row.profile_id,
  revision: row.revision,
  definition: SymposiumProfileDefinitionSchema.parse(JSON.parse(row.definition)),
  contentHash: row.content_hash,
});

/** Immutable owner-scoped versions stored beside the durable session ledger. */
export class SymposiumProfileStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS symposium_profile_versions (
        owner TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        definition TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        PRIMARY KEY (owner, profile_id, revision)
      );
      CREATE TABLE IF NOT EXISTS symposium_profile_retries (
        owner TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        PRIMARY KEY (owner, idempotency_key)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  get(owner: string, profileId: string, revision?: number): SymposiumProfileVersion | null {
    Id.parse(owner);
    Id.parse(profileId);
    if (revision !== undefined) z.number().int().positive().parse(revision);
    const row = (
      revision === undefined
        ? this.db
            .prepare(
              `SELECT profile_id, revision, definition, content_hash
          FROM symposium_profile_versions WHERE owner = ? AND profile_id = ?
          ORDER BY revision DESC LIMIT 1`,
            )
            .get(owner, profileId)
        : this.db
            .prepare(
              `SELECT profile_id, revision, definition, content_hash
          FROM symposium_profile_versions WHERE owner = ? AND profile_id = ? AND revision = ?`,
            )
            .get(owner, profileId, revision)
    ) as VersionRow | undefined;
    return row ? fromRow(row) : null;
  }

  list(owner: string): SymposiumProfileVersion[] {
    Id.parse(owner);
    const rows = this.db
      .prepare(
        `SELECT profile_id, revision, definition, content_hash
      FROM symposium_profile_versions AS version
      WHERE owner = ? AND revision = (
        SELECT MAX(revision) FROM symposium_profile_versions AS latest
        WHERE latest.owner = version.owner AND latest.profile_id = version.profile_id
      ) ORDER BY profile_id`,
      )
      .all(owner) as VersionRow[];
    return rows.map(fromRow);
  }

  save(owner: string, input: SaveSymposiumProfile): SymposiumProfileVersion {
    Id.parse(owner);
    const request = SaveSchema.parse(input);
    const hash = contentHash(request.definition);
    const requestHash = sha256(
      JSON.stringify({
        profileId: request.profileId,
        expectedRevision: request.expectedRevision,
        contentHash: hash,
      }),
    );
    return this.db.transaction(() => {
      const retry = this.db
        .prepare(
          `SELECT request_hash, profile_id, revision
        FROM symposium_profile_retries WHERE owner = ? AND idempotency_key = ?`,
        )
        .get(owner, request.idempotencyKey) as RetryRow | undefined;
      if (retry) {
        if (retry.request_hash !== requestHash)
          throw new Error('Conflicting profile idempotency key');
        const saved = this.get(owner, retry.profile_id, retry.revision);
        if (!saved) throw new Error('Profile retry references a missing revision');
        return saved;
      }
      const current = this.get(owner, request.profileId);
      if ((current?.revision ?? 0) !== request.expectedRevision)
        throw new Error('Profile revision conflict');
      const revision = request.expectedRevision + 1;
      this.db
        .prepare(
          `INSERT INTO symposium_profile_versions
        (owner, profile_id, revision, definition, content_hash) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(owner, request.profileId, revision, JSON.stringify(request.definition), hash);
      this.db
        .prepare(
          `INSERT INTO symposium_profile_retries
        (owner, idempotency_key, request_hash, profile_id, revision) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(owner, request.idempotencyKey, requestHash, request.profileId, revision);
      return {
        profileId: request.profileId,
        revision,
        definition: request.definition,
        contentHash: hash,
      };
    })();
  }

  export(owner: string, profileId: string, revision: number): SymposiumProfileVersion {
    const version = this.get(owner, profileId, revision);
    if (!version) throw new Error('Profile revision not found');
    return version;
  }

  import(
    owner: string,
    artifact: SymposiumProfileVersion,
    idempotencyKey: string,
  ): SymposiumProfileVersion {
    Id.parse(owner);
    Id.parse(idempotencyKey);
    const version = VersionSchema.parse(artifact);
    if (contentHash(version.definition) !== version.contentHash)
      throw new Error('Profile content hash mismatch');
    const requestHash = sha256(
      JSON.stringify({
        profileId: version.profileId,
        revision: version.revision,
        contentHash: version.contentHash,
      }),
    );
    return this.db.transaction(() => {
      const retry = this.db
        .prepare(
          `SELECT request_hash, profile_id, revision
        FROM symposium_profile_retries WHERE owner = ? AND idempotency_key = ?`,
        )
        .get(owner, idempotencyKey) as RetryRow | undefined;
      if (retry) {
        if (retry.request_hash !== requestHash)
          throw new Error('Conflicting profile idempotency key');
        const saved = this.get(owner, retry.profile_id, retry.revision);
        if (!saved) throw new Error('Profile retry references a missing revision');
        return saved;
      }
      const existing = this.get(owner, version.profileId, version.revision);
      if (existing && existing.contentHash !== version.contentHash)
        throw new Error('Profile revision conflict');
      const current = this.get(owner, version.profileId);
      if (!existing && current && current.revision !== version.revision - 1)
        throw new Error('Profile revision conflict');
      if (!existing)
        this.db
          .prepare(
            `INSERT INTO symposium_profile_versions
        (owner, profile_id, revision, definition, content_hash) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            owner,
            version.profileId,
            version.revision,
            JSON.stringify(version.definition),
            version.contentHash,
          );
      this.db
        .prepare(
          `INSERT INTO symposium_profile_retries
        (owner, idempotency_key, request_hash, profile_id, revision) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(owner, idempotencyKey, requestHash, version.profileId, version.revision);
      return existing ?? version;
    })();
  }
}
