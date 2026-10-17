import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ToolBuilderStore, type InstalledToolImplementation } from '../tool-builder-store.js';
import { toolBuilderSourceDigest } from '../tool-builder.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-tool-builder-store-'));
  roots.push(root);
  return new ToolBuilderStore(join(root, 'builder.db'));
}

const files = [
  {
    path: 'src/index.mjs',
    content: 'export function runTool(input) { return { count: 2 }; }\n',
  },
  { path: 'test/index.test.mjs', content: 'test source\n' },
];
const sourceDigest = toolBuilderSourceDigest(files);
const draftContent = {
  toolId: 'custom:csv-row-count',
  name: 'CSV row count',
  description: 'Count CSV rows without the header.',
  inputSchema: { type: 'object' },
  examples: [{ input: { csv: 'name\nAda\nLin' }, expected: { count: 2 } }],
  permissions: { behavior: 'read' as const, requiredConnections: [] },
  compatibility: { routes: ['local-api'] },
  files,
  testProfile: 'unit' as const,
  sourceDigest,
  testEvidence: {
    passed: true,
    complete: true,
    sourceDigest,
    summary: '4 tests passed',
    examples: [{ input: { csv: 'name\nAda\nLin' }, expected: { count: 2 }, actual: { count: 2 } }],
  },
};
const installed: InstalledToolImplementation = {
  toolId: draftContent.toolId,
  version: 1,
  sourceDigest,
  executorId: 'csv-row-count-v1',
  routes: ['local-api'],
};

it('publishes an immutable exact version only after an independent accepted review and installed executor match', async () => {
  const db = await store();
  const draft = db.createDraft({ id: 'draft-1', authorId: 'session-owner', content: draftContent });
  const submitted = db.submitForReview(draft.id, draft.version, sourceDigest);
  db.resolveReview({
    draftId: draft.id,
    version: draft.version,
    reviewId: 'review-1',
    reviewerId: 'independent-reviewer',
    decision: 'accepted',
    sourceDigest,
  });

  const publication = db.publish(
    { draftId: draft.id, version: draft.version, route: 'local-api' },
    [installed],
  );

  expect(submitted.status).toBe('submitted');
  expect(publication).toMatchObject({
    toolId: 'custom:csv-row-count',
    version: 1,
    sourceDigest,
    executorId: 'csv-row-count-v1',
    route: 'local-api',
  });
  expect(db.select(publication.toolId, publication.version, 'local-api', [installed])).toEqual(
    publication,
  );
  expect(() =>
    db.select(publication.toolId, publication.version + 1, 'local-api', [installed]),
  ).toThrow();
  db.close();
});

it.each([
  ['rejected review', 'rejected', 'independent-reviewer'],
  ['self review', 'accepted', 'session-owner'],
])('does not publish after %s', async (_label, decision, reviewerId) => {
  const db = await store();
  const draft = db.createDraft({ id: 'draft-2', authorId: 'session-owner', content: draftContent });
  db.submitForReview(draft.id, draft.version, sourceDigest);
  const resolution = () =>
    db.resolveReview({
      draftId: draft.id,
      version: draft.version,
      reviewId: 'review-2',
      reviewerId,
      decision,
      sourceDigest,
      feedback: decision === 'rejected' ? 'Add a malformed-input example.' : undefined,
    });
  if (reviewerId === 'session-owner') expect(resolution).toThrow('cannot approve their own draft');
  else {
    resolution();
    if (decision === 'rejected') {
      const reviewed = db.getDraft(draft.id, draft.version)!;
      expect(reviewed.review?.feedback).toBe('Add a malformed-input example.');
      const revision = db.reviseDraft({
        id: draft.id,
        expectedVersion: draft.version,
        content: { ...draftContent, description: 'Count CSV rows and reject malformed input.' },
      });
      expect(revision.version).toBe(draft.version + 1);
      expect(revision.status).toBe('unpublished');
      expect(db.getDraft(draft.id, draft.version)?.review?.decision).toBe('rejected');
    }
  }

  expect(() =>
    db.publish({ draftId: draft.id, version: draft.version, route: 'local-api' }, [installed]),
  ).toThrow();
  db.close();
});

it('does not publish unaccepted, untested or source-drifted drafts', async () => {
  const db = await store();
  expect(() =>
    db.createDraft({
      id: 'draft-failed',
      authorId: 'session-owner',
      content: { ...draftContent, testEvidence: { passed: false, complete: true, sourceDigest } },
    }),
  ).toThrow();

  const drifted = db.createDraft({
    id: 'draft-drift',
    authorId: 'session-owner',
    content: draftContent,
  });
  expect(() => db.submitForReview(drifted.id, drifted.version, 'e'.repeat(64))).toThrow();
  expect(() =>
    db.publish({ draftId: drifted.id, version: drifted.version, route: 'local-api' }, [installed]),
  ).toThrow();
  db.close();
});

it('requires the exact source digest and runtime route to exist in the installed registry', async () => {
  const db = await store();
  const draft = db.createDraft({
    id: 'draft-runtime',
    authorId: 'session-owner',
    content: draftContent,
  });
  db.submitForReview(draft.id, draft.version, sourceDigest);
  db.resolveReview({
    draftId: draft.id,
    version: draft.version,
    reviewId: 'review-runtime',
    reviewerId: 'independent-reviewer',
    decision: 'accepted',
    sourceDigest,
  });

  expect(() =>
    db.publish({ draftId: draft.id, version: draft.version, route: 'local-api' }, []),
  ).toThrow();
  expect(() =>
    db.publish({ draftId: draft.id, version: draft.version, route: 'native-codex' }, [installed]),
  ).toThrow();
  expect(() =>
    db.publish({ draftId: draft.id, version: draft.version, route: 'local-api' }, [
      { ...installed, sourceDigest: 'e'.repeat(64) },
    ]),
  ).toThrow();
  db.close();
});

it('keeps accepted publications immutable when a later draft revision receives feedback', async () => {
  const db = await store();
  const draft = db.createDraft({
    id: 'draft-revise',
    authorId: 'session-owner',
    content: draftContent,
  });
  db.submitForReview(draft.id, draft.version, sourceDigest);
  db.resolveReview({
    draftId: draft.id,
    version: draft.version,
    reviewId: 'review-revise',
    reviewerId: 'independent-reviewer',
    decision: 'accepted',
    sourceDigest,
  });
  const publication = db.publish(
    { draftId: draft.id, version: draft.version, route: 'local-api' },
    [installed],
  );
  const revised = db.reviseDraft({
    id: draft.id,
    expectedVersion: draft.version,
    content: { ...draftContent, description: 'Count CSV data rows without the header.' },
  });

  expect(revised.version).toBe(2);
  expect(revised.status).toBe('unpublished');
  expect(db.getDraft(draft.id, 1)?.status).toBe('accepted');
  expect(db.publication(publication.toolId, publication.version)).toEqual(publication);
  expect(db.select(publication.toolId, publication.version, 'local-api', [installed])).toEqual(
    publication,
  );
  db.close();
});
