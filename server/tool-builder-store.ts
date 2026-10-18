import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, openSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CustomToolReferenceSchema, type AgentToolCatalogEntry } from '@mitzo/protocol';
import { canonicalJson } from './connections/capabilities/input-validation.js';
import { CustomToolRegistry, type CustomToolBinding } from './custom-tool-registry.js';
import {
  CustomToolDraftInputSchema,
  toolBuilderContractDigest,
  toolBuilderSourceDigest,
  type ToolBuilderDraft,
} from './tool-builder.js';
import { validateToolBuilderExamples } from './tool-builder-schema.js';

const Id = z.string().trim().min(1).max(128);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Json = z.record(z.string(), z.json());
const DraftSchema = CustomToolDraftInputSchema.safeExtend({
  id: z.uuid(),
  version: z.number().int().positive(),
  status: z.literal('unpublished'),
  workspaceId: Id,
  sourceDigest: Digest,
  contractDigest: Digest,
  tests: z.strictObject({
    passed: z.literal(true),
    complete: z.literal(true),
    evidenceKind: z.enum(['candidate-report', 'trusted-executor']),
    summary: z.string().trim().min(1).max(500),
    sourceDigest: Digest,
    contractDigest: Digest,
    examples: z
      .array(z.strictObject({ input: Json, expected: Json, actual: Json }))
      .min(1)
      .max(20),
  }),
});
const ReviewSchema = z.strictObject({
  decision: z.enum(['accepted', 'rejected']),
  contractDigest: Digest,
  feedback: z.string().max(4000),
});
type Review = z.infer<typeof ReviewSchema> & { reviewer: string };
type Status = 'unpublished' | 'submitted' | 'accepted' | 'rejected' | 'cancelled';
export interface ToolBuilderRecord {
  draft: ToolBuilderDraft;
  sessionId: string;
  status: Status;
  review?: Review;
}
export interface CustomToolPublication {
  reference: z.infer<typeof CustomToolReferenceSchema>;
  entry: AgentToolCatalogEntry;
  binding: CustomToolBinding;
  qualification: Awaited<ReturnType<CustomToolRegistry['qualify']>>;
}
type Row = { data: string; session_id: string; status: Status; review: string | null };
function testedDraft(raw: unknown): ToolBuilderDraft {
  const draft = DraftSchema.parse(raw);
  const schema = validateToolBuilderExamples(draft);
  for (const example of draft.tests.examples) schema.output.validate(example.actual);
  if (
    draft.sourceDigest !== toolBuilderSourceDigest(draft.files) ||
    draft.contractDigest !== toolBuilderContractDigest(draft) ||
    draft.tests.sourceDigest !== draft.sourceDigest ||
    draft.tests.contractDigest !== draft.contractDigest ||
    draft.tests.examples.length !== draft.examples.length ||
    draft.tests.examples.some(
      (result, index) =>
        !isDeepStrictEqual(result.input, draft.examples[index].input) ||
        !isDeepStrictEqual(result.expected, draft.examples[index].expected) ||
        !isDeepStrictEqual(result.actual, result.expected),
    )
  )
    throw Error('Tool draft evidence does not match its exact contract');
  return draft;
}

/** Owner-scoped private drafts. Only the operator route exposes review/publication. */
export class ToolBuilderStore {
  private readonly db: Database.Database;
  private readonly lifetime = new AbortController();
  private readonly publishing = new Map<string, string>();
  constructor(
    path: string,
    readonly registry: CustomToolRegistry,
  ) {
    if (path !== ':memory:') {
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new Database(path);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_builder_versions (
        owner TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, session_id TEXT NOT NULL,
        request_key TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, review TEXT,
        PRIMARY KEY(owner,id,version), UNIQUE(owner,session_id,request_key));
      CREATE TABLE IF NOT EXISTS custom_tool_publications (
        owner TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, revision TEXT NOT NULL UNIQUE,
        receipt TEXT NOT NULL, PRIMARY KEY(owner,id,version));
      CREATE TRIGGER IF NOT EXISTS immutable_tool_builder_source BEFORE UPDATE OF data ON tool_builder_versions
        BEGIN SELECT RAISE(ABORT,'Tool draft versions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_custom_publication_update BEFORE UPDATE ON custom_tool_publications
        BEGIN SELECT RAISE(ABORT,'Tool publications are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_custom_publication_delete BEFORE DELETE ON custom_tool_publications
        BEGIN SELECT RAISE(ABORT,'Tool publications are immutable'); END;`);
  }
  close() {
    this.lifetime.abort();
    this.db.close();
  }
  private decode(row: Row): ToolBuilderRecord {
    return {
      draft: testedDraft(JSON.parse(row.data)),
      sessionId: row.session_id,
      status: row.status,
      ...(row.review ? { review: JSON.parse(row.review) as Review } : {}),
    };
  }
  read(owner: string, id: string, version?: number): ToolBuilderRecord | null {
    Id.parse(owner);
    z.uuid().parse(id);
    if (version !== undefined) z.number().int().positive().parse(version);
    const row = (
      version === undefined
        ? this.db
            .prepare(
              'SELECT * FROM tool_builder_versions WHERE owner=? AND id=? ORDER BY version DESC LIMIT 1',
            )
            .get(owner, id)
        : this.db
            .prepare('SELECT * FROM tool_builder_versions WHERE owner=? AND id=? AND version=?')
            .get(owner, id, version)
    ) as Row | undefined;
    return row ? this.decode(row) : null;
  }
  list(owner: string, sessionId?: string, offset = 0): ToolBuilderRecord[] {
    Id.parse(owner);
    if (sessionId !== undefined) Id.parse(sessionId);
    z.number().int().nonnegative().parse(offset);
    return (
      this.db
        .prepare(
          `SELECT v.* FROM tool_builder_versions v WHERE owner=?
      AND (? IS NULL OR session_id=?) AND NOT EXISTS
      (SELECT 1 FROM tool_builder_versions newer WHERE newer.owner=v.owner AND newer.id=v.id AND newer.version>v.version)
      ORDER BY rowid DESC LIMIT 20 OFFSET ?`,
        )
        .all(owner, sessionId ?? null, sessionId ?? null, offset) as Row[]
    ).map((row) => this.decode(row));
  }
  save(
    owner: string,
    sessionId: string,
    requestKey: string,
    raw: unknown,
    expectedVersion: number,
  ): ToolBuilderRecord {
    Id.parse(owner);
    Id.parse(sessionId);
    Id.parse(requestKey);
    z.number().int().nonnegative().parse(expectedVersion);
    const draft = testedDraft(raw);
    return this.db
      .transaction(() => {
        const retry = this.db
          .prepare(
            'SELECT * FROM tool_builder_versions WHERE owner=? AND session_id=? AND request_key=?',
          )
          .get(owner, sessionId, requestKey) as Row | undefined;
        if (retry) {
          if (canonicalJson(JSON.parse(retry.data)) !== canonicalJson(draft))
            throw Error('Conflicting draft request identity');
          return this.decode(retry);
        }
        const latest = this.read(owner, draft.id);
        if (
          (latest?.draft.version ?? 0) !== expectedVersion ||
          draft.version !== expectedVersion + 1
        )
          throw Error('Tool draft version conflict');
        if (
          latest &&
          (latest.sessionId !== sessionId ||
            latest.status === 'submitted' ||
            latest.status === 'cancelled')
        )
          throw Error('Tool draft session or review authority is unavailable');
        this.db
          .prepare('INSERT INTO tool_builder_versions VALUES(?,?,?,?,?,?,?,NULL)')
          .run(
            owner,
            draft.id,
            draft.version,
            sessionId,
            requestKey,
            JSON.stringify(draft),
            'unpublished',
          );
        return this.read(owner, draft.id, draft.version)!;
      })
      .immediate();
  }
  submit(owner: string, sessionId: string, id: string, version: number, contractDigest: string) {
    Id.parse(sessionId);
    Digest.parse(contractDigest);
    return this.db
      .transaction(() => {
        const record = this.read(owner, id);
        if (!record || record.draft.version !== version) throw Error('Tool draft version conflict');
        if (
          record.sessionId !== sessionId ||
          record.draft.contractDigest !== contractDigest ||
          !['unpublished', 'submitted'].includes(record.status)
        )
          throw Error('Tool draft cannot be submitted');
        this.db
          .prepare(
            "UPDATE tool_builder_versions SET status='submitted' WHERE owner=? AND id=? AND version=?",
          )
          .run(owner, id, version);
        return this.read(owner, id, version)!;
      })
      .immediate();
  }
  review(owner: string, id: string, version: number, raw: unknown, reviewer: string) {
    const review = { ...ReviewSchema.parse(raw), reviewer: Id.parse(reviewer) };
    return this.db
      .transaction(() => {
        const record = this.read(owner, id, version);
        if (record?.review && canonicalJson(record.review) === canonicalJson(review)) return record;
        if (
          !record ||
          record.status !== 'submitted' ||
          record.draft.contractDigest !== review.contractDigest
        )
          throw Error('Submitted tool draft or exact review contract is unavailable');
        this.db
          .prepare(
            'UPDATE tool_builder_versions SET status=?,review=? WHERE owner=? AND id=? AND version=?',
          )
          .run(review.decision, JSON.stringify(review), owner, id, version);
        return this.read(owner, id, version)!;
      })
      .immediate();
  }
  cancel(owner: string, id: string, version: number) {
    return this.db
      .transaction(() => {
        const record = this.read(owner, id, version);
        if (
          !record ||
          this.db
            .prepare('SELECT 1 FROM custom_tool_publications WHERE owner=? AND id=? AND version=?')
            .get(owner, `custom:${id}`, version)
        )
          throw Error('Published or missing tool draft cannot be cancelled');
        this.db
          .prepare(
            "UPDATE tool_builder_versions SET status='cancelled' WHERE owner=? AND id=? AND version=?",
          )
          .run(owner, id, version);
        return this.read(owner, id, version)!;
      })
      .immediate();
  }
  async publish(
    owner: string,
    id: string,
    version: number,
    contractDigest: string,
    options: { signal: AbortSignal; assertCurrent(): void } = {
      signal: new AbortController().signal,
      assertCurrent() {},
    },
  ): Promise<CustomToolPublication> {
    Digest.parse(contractDigest);
    const signal = AbortSignal.any([
      options.signal,
      this.lifetime.signal,
      AbortSignal.timeout(30000),
    ]);
    const authority = () => {
      signal.throwIfAborted();
      options.assertCurrent();
    };
    const accepted = () => {
      authority();
      const record = this.read(owner, id, version);
      if (
        !record ||
        record.status !== 'accepted' ||
        record.review?.decision !== 'accepted' ||
        record.draft.contractDigest !== contractDigest
      )
        throw Error('Exact operator-accepted tool draft is required for publication');
      return record;
    };
    const record = accepted();
    const binding = this.registry.bind(record.draft);
    const old = this.db
      .prepare('SELECT receipt FROM custom_tool_publications WHERE owner=? AND id=? AND version=?')
      .get(owner, binding.id, version) as { receipt: string } | undefined;
    if (old)
      return this.resolve(owner, (JSON.parse(old.receipt) as CustomToolPublication).reference);
    const key = canonicalJson([owner, id, version]);
    const generation = randomUUID();
    this.publishing.set(key, generation);
    const check = () => {
      accepted();
      if (this.publishing.get(key) !== generation)
        throw Error('Custom qualification was superseded');
      this.registry.implementation(record.draft, binding);
    };
    try {
      const qualification = await this.registry.qualify(record.draft, binding, {
        signal,
        assertCurrent: check,
      });
      return this.db
        .transaction(() => {
          check();
          const reference = CustomToolReferenceSchema.parse({
            id: binding.id,
            version,
            revision: randomUUID(),
          });
          const entry: AgentToolCatalogEntry = {
            ...reference,
            name: record.draft.name,
            description: record.draft.description,
            source: 'Reviewed custom implementation',
            required: false,
            behavior: 'read',
            routes: ['local-api'],
            requirement:
              'Accepted and independently qualified installed implementation. Assignment is separate; start a new session for changes.',
            implementation: {
              template: binding.id,
              source: 'Reviewed application source',
              fingerprint: binding.registryDigest,
            },
          };
          const receipt = { reference, entry, binding, qualification };
          this.db
            .prepare('INSERT INTO custom_tool_publications VALUES(?,?,?,?,?)')
            .run(owner, binding.id, version, reference.revision, JSON.stringify(receipt));
          return receipt;
        })
        .immediate();
    } finally {
      if (this.publishing.get(key) === generation) this.publishing.delete(key);
    }
  }
  listTools(owner: string): AgentToolCatalogEntry[] {
    Id.parse(owner);
    const receipts = (
      this.db
        .prepare('SELECT receipt FROM custom_tool_publications WHERE owner=? ORDER BY rowid')
        .all(owner) as { receipt: string }[]
    ).map((row) => JSON.parse(row.receipt) as CustomToolPublication);
    return [
      ...new Map(
        receipts.map((receipt) => {
          let entry = receipt.entry;
          try {
            this.resolve(owner, receipt.reference);
          } catch {
            entry = {
              ...entry,
              routes: [],
              requirement:
                'Installed source changed or is unavailable. Review, install and publish a new version, then explicitly select it in a new session.',
            };
          }
          return [entry.id, entry] as const;
        }),
      ).values(),
    ];
  }
  resolve(owner: string, raw: unknown): CustomToolPublication {
    Id.parse(owner);
    const reference = CustomToolReferenceSchema.parse(raw);
    const row = this.db
      .prepare(
        'SELECT receipt FROM custom_tool_publications WHERE owner=? AND id=? AND version=? AND revision=?',
      )
      .get(owner, reference.id, reference.version, reference.revision) as
      { receipt: string } | undefined;
    if (!row) throw Error('Custom tool reference is unresolved on this installation');
    const receipt = JSON.parse(row.receipt) as CustomToolPublication;
    const record = this.read(owner, reference.id.slice(7), reference.version);
    if (!record || record.status !== 'accepted')
      throw Error('Accepted custom version is unavailable');
    if (
      receipt.qualification?.kind !== 'installed-source' ||
      receipt.qualification.registryDigest !== receipt.binding.registryDigest ||
      receipt.qualification.contractDigest !== record.draft.contractDigest
    )
      throw Error('Independent installed-source qualification is unavailable');
    this.registry.implementation(record.draft, receipt.binding);
    return receipt;
  }
}
