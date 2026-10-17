import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, openSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CustomToolDraftInputSchema, toolBuilderSourceDigest } from './tool-builder.js';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().trim().min(1).max(128);
const TestEvidence = z.strictObject({
  passed: z.literal(true),
  complete: z.literal(true),
  sourceDigest: Digest,
  summary: z.string().trim().min(1).max(500),
  examples: z
    .array(
      z.strictObject({
        input: z.record(z.string(), z.unknown()),
        expected: z.record(z.string(), z.unknown()),
        actual: z.record(z.string(), z.unknown()),
      }),
    )
    .max(20),
});
const DraftContent = CustomToolDraftInputSchema.extend({
  toolId: z.string().regex(/^custom:[a-z][a-z0-9-]{1,62}$/),
  sourceDigest: Digest,
  testEvidence: TestEvidence,
}).superRefine((content, ctx) => {
  if (content.testEvidence.sourceDigest !== content.sourceDigest)
    ctx.addIssue({
      code: 'custom',
      path: ['testEvidence', 'sourceDigest'],
      message: 'Test evidence is stale',
    });
  if (toolBuilderSourceDigest(content.files) !== content.sourceDigest)
    ctx.addIssue({
      code: 'custom',
      path: ['sourceDigest'],
      message: 'Draft files do not match the source digest',
    });
  if (
    content.testEvidence.examples.length !== content.examples.length ||
    content.testEvidence.examples.some(
      (result, index) => !isDeepStrictEqual(result.actual, content.examples[index].expected),
    )
  )
    ctx.addIssue({
      code: 'custom',
      path: ['testEvidence', 'examples'],
      message: 'Example evidence does not match the declared results',
    });
});

export type InstalledToolImplementation = {
  toolId: string;
  version: number;
  sourceDigest: string;
  executorId: string;
  routes: readonly string[];
};
export type ToolBuilderDraftRecord = {
  id: string;
  version: number;
  authorId: string;
  content: z.infer<typeof DraftContent>;
  status: 'unpublished' | 'submitted' | 'accepted' | 'rejected';
  review?: {
    reviewId: string;
    reviewerId: string;
    decision: 'accepted' | 'rejected';
    sourceDigest: string;
    feedback: string;
  };
};
export type ToolBuilderReview = {
  draftId: string;
  version: number;
  reviewId: string;
  reviewerId: string;
  decision: 'accepted' | 'rejected';
  sourceDigest: string;
  feedback?: string;
};
export type ToolPublication = {
  toolId: string;
  version: number;
  revision: string;
  sourceDigest: string;
  executorId: string;
  route: string;
  reviewId: string;
};

const decodeDraft = (row: {
  id: string;
  version: number;
  author_id: string;
  content: string;
  status: string;
}) => ({
  id: row.id,
  version: row.version,
  authorId: row.author_id,
  content: DraftContent.parse(JSON.parse(row.content)),
  status: row.status as ToolBuilderDraftRecord['status'],
});
const publicationSchema = z.strictObject({
  toolId: z.string(),
  version: z.number().int().positive(),
  revision: z.uuid(),
  sourceDigest: Digest,
  executorId: Id,
  route: z.string().trim().min(1).max(64),
  reviewId: Id,
});

/** Private draft/review ledger. Published source is never loaded from this store. */
export class ToolBuilderStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') {
      closeSync(openSync(path, 'a', 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new Database(path);
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_builder_drafts (
        id TEXT NOT NULL, version INTEGER NOT NULL, author_id TEXT NOT NULL,
        content TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('unpublished','submitted','accepted','rejected')),
        created_at INTEGER NOT NULL, PRIMARY KEY(id,version)
      );
      CREATE TABLE IF NOT EXISTS tool_builder_reviews (
        review_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, version INTEGER NOT NULL,
        reviewer_id TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),
        source_digest TEXT NOT NULL, feedback TEXT NOT NULL,
        UNIQUE(draft_id,version)
      );
      CREATE TABLE IF NOT EXISTS tool_builder_publications (
        tool_id TEXT NOT NULL, version INTEGER NOT NULL, revision TEXT NOT NULL UNIQUE,
        source_digest TEXT NOT NULL, executor_id TEXT NOT NULL, route TEXT NOT NULL,
        review_id TEXT NOT NULL UNIQUE, PRIMARY KEY(tool_id,version)
      );
      CREATE TRIGGER IF NOT EXISTS immutable_accepted_tool_draft
        BEFORE UPDATE ON tool_builder_drafts WHEN OLD.status='accepted'
        BEGIN SELECT RAISE(ABORT, 'Accepted tool implementation versions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_tool_publication_update
        BEFORE UPDATE ON tool_builder_publications
        BEGIN SELECT RAISE(ABORT, 'Tool publications are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_tool_publication_delete
        BEFORE DELETE ON tool_builder_publications
        BEGIN SELECT RAISE(ABORT, 'Tool publications are immutable'); END;
    `);
  }
  close() {
    this.db.close();
  }

  createDraft(input: { id: string; authorId: string; content: unknown }): ToolBuilderDraftRecord {
    const id = Id.parse(input.id);
    const authorId = Id.parse(input.authorId);
    const content = DraftContent.parse(input.content);
    this.db
      .prepare(
        `INSERT INTO tool_builder_drafts(id,version,author_id,content,status,created_at)
         VALUES(?,1,?,?, 'unpublished',?)`,
      )
      .run(id, authorId, JSON.stringify(content), Date.now());
    return this.getDraft(id, 1)!;
  }

  getDraft(id: string, version?: number): ToolBuilderDraftRecord | null {
    Id.parse(id);
    const row = (
      version === undefined
        ? this.db
            .prepare('SELECT * FROM tool_builder_drafts WHERE id=? ORDER BY version DESC LIMIT 1')
            .get(id)
        : this.db
            .prepare('SELECT * FROM tool_builder_drafts WHERE id=? AND version=?')
            .get(id, version)
    ) as
      | { id: string; version: number; author_id: string; content: string; status: string }
      | undefined;
    if (!row) return null;
    const draft = decodeDraft(row);
    const review = this.db
      .prepare(
        'SELECT review_id, reviewer_id, decision, source_digest, feedback FROM tool_builder_reviews WHERE draft_id=? AND version=?',
      )
      .get(draft.id, draft.version) as
      | {
          review_id: string;
          reviewer_id: string;
          decision: 'accepted' | 'rejected';
          source_digest: string;
          feedback: string;
        }
      | undefined;
    return review
      ? {
          ...draft,
          review: {
            reviewId: review.review_id,
            reviewerId: review.reviewer_id,
            decision: review.decision,
            sourceDigest: review.source_digest,
            feedback: review.feedback,
          },
        }
      : draft;
  }

  reviseDraft(input: {
    id: string;
    expectedVersion: number;
    content: unknown;
  }): ToolBuilderDraftRecord {
    const id = Id.parse(input.id);
    const content = DraftContent.parse(input.content);
    return this.db
      .transaction(() => {
        const latest = this.getDraft(id);
        if (!latest || latest.version !== input.expectedVersion)
          throw Error('Tool draft version conflict');
        const next = {
          id,
          version: latest.version + 1,
          authorId: latest.authorId,
          content,
          status: 'unpublished' as const,
        };
        this.db
          .prepare('INSERT INTO tool_builder_drafts VALUES(?,?,?,?,?,?)')
          .run(
            next.id,
            next.version,
            next.authorId,
            JSON.stringify(content),
            next.status,
            Date.now(),
          );
        return next;
      })
      .immediate();
  }

  submitForReview(id: string, version: number, sourceDigest: string): ToolBuilderDraftRecord {
    Digest.parse(sourceDigest);
    return this.db
      .transaction(() => {
        const draft = this.getDraft(id, version);
        if (!draft) throw Error('Tool draft not found');
        if (draft.status !== 'unpublished') throw Error('Tool draft is not reviewable');
        if (
          draft.content.sourceDigest !== sourceDigest ||
          !draft.content.testEvidence.passed ||
          !draft.content.testEvidence.complete ||
          draft.content.testEvidence.sourceDigest !== sourceDigest
        )
          throw Error('Tool draft tests or source digest are stale');
        this.db
          .prepare(
            "UPDATE tool_builder_drafts SET status='submitted' WHERE id=? AND version=? AND status='unpublished'",
          )
          .run(id, version);
        return this.getDraft(id, version)!;
      })
      .immediate();
  }

  resolveReview(review: ToolBuilderReview): ToolBuilderDraftRecord {
    const request = z
      .strictObject({
        draftId: Id,
        version: z.number().int().positive(),
        reviewId: Id,
        reviewerId: Id,
        decision: z.enum(['accepted', 'rejected']),
        sourceDigest: Digest,
        feedback: z.string().max(4_000).optional(),
      })
      .parse(review);
    return this.db
      .transaction(() => {
        const draft = this.getDraft(request.draftId, request.version);
        if (!draft || draft.status !== 'submitted') throw Error('Submitted tool draft not found');
        if (draft.authorId === request.reviewerId)
          throw Error('Tool builders cannot approve their own draft');
        if (draft.content.sourceDigest !== request.sourceDigest)
          throw Error('Tool review source digest does not match the submitted draft');
        this.db
          .prepare('INSERT INTO tool_builder_reviews VALUES(?,?,?,?,?,?,?)')
          .run(
            request.reviewId,
            request.draftId,
            request.version,
            request.reviewerId,
            request.decision,
            request.sourceDigest,
            request.feedback ?? '',
          );
        this.db
          .prepare('UPDATE tool_builder_drafts SET status=? WHERE id=? AND version=? AND status=?')
          .run(request.decision, request.draftId, request.version, 'submitted');
        return this.getDraft(request.draftId, request.version)!;
      })
      .immediate();
  }

  publish(
    input: { draftId: string; version: number; route: string },
    installed: readonly InstalledToolImplementation[],
  ): ToolPublication {
    const request = z
      .strictObject({
        draftId: Id,
        version: z.number().int().positive(),
        route: z.string().trim().min(1).max(64),
      })
      .parse(input);
    return this.db
      .transaction(() => {
        const draft = this.getDraft(request.draftId, request.version);
        if (!draft || draft.status !== 'accepted') throw Error('Tool draft has not been accepted');
        const review = this.db
          .prepare('SELECT * FROM tool_builder_reviews WHERE draft_id=? AND version=?')
          .get(request.draftId, request.version) as
          { review_id: string; decision: string; source_digest: string } | undefined;
        if (
          !review ||
          review.decision !== 'accepted' ||
          review.source_digest !== draft.content.sourceDigest
        )
          throw Error('Accepted independent review is missing for this source version');
        const implementation = installed.find(
          (entry) =>
            entry.toolId === draft.content.toolId &&
            entry.version > 0 &&
            entry.sourceDigest === draft.content.sourceDigest &&
            entry.routes.includes(request.route),
        );
        if (!implementation)
          throw Error('Accepted implementation is not installed for this runtime');
        const receipt = publicationSchema.parse({
          toolId: implementation.toolId,
          version: implementation.version,
          revision: randomUUID(),
          sourceDigest: implementation.sourceDigest,
          executorId: implementation.executorId,
          route: request.route,
          reviewId: review.review_id,
        });
        this.db
          .prepare('INSERT INTO tool_builder_publications VALUES(?,?,?,?,?,?,?)')
          .run(
            receipt.toolId,
            receipt.version,
            receipt.revision,
            receipt.sourceDigest,
            receipt.executorId,
            receipt.route,
            receipt.reviewId,
          );
        return receipt;
      })
      .immediate();
  }

  publication(toolId: string, version: number): ToolPublication | null {
    const row = this.db
      .prepare('SELECT * FROM tool_builder_publications WHERE tool_id=? AND version=?')
      .get(toolId, version) as
      | {
          tool_id: string;
          version: number;
          revision: string;
          source_digest: string;
          executor_id: string;
          route: string;
          review_id: string;
        }
      | undefined;
    return row
      ? publicationSchema.parse({
          toolId: row.tool_id,
          version: row.version,
          revision: row.revision,
          sourceDigest: row.source_digest,
          executorId: row.executor_id,
          route: row.route,
          reviewId: row.review_id,
        })
      : null;
  }

  select(
    toolId: string,
    version: number,
    route: string,
    installed: readonly InstalledToolImplementation[],
  ): ToolPublication {
    const publication = this.publication(toolId, version);
    const implementation = installed.find(
      (entry) =>
        entry.toolId === toolId &&
        entry.version === version &&
        entry.sourceDigest === publication?.sourceDigest &&
        entry.executorId === publication?.executorId &&
        entry.routes.includes(route),
    );
    if (!publication || publication.route !== route || !implementation)
      throw Error('Published tool version is unavailable on this runtime');
    return publication;
  }
}
