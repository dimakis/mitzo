import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelosWorkStore } from '../telos-work-store.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';
import { reviewTelosWorkRoleContext } from '../telos-work-role-review.js';
const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture(options: { historicalCycle?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'telos-role-review-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'telos.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,parent_id TEXT,summary TEXT,intent TEXT,rationale TEXT,acceptance_criteria TEXT,status TEXT,updated_at TEXT);
 CREATE TABLE sources(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT);
 CREATE TABLE links(id TEXT PRIMARY KEY,item_id TEXT,type TEXT,url TEXT,title TEXT,description TEXT,created_at TEXT);
 INSERT INTO items VALUES('goal',NULL,'Overall','Overall goal','Why','["Goal criterion"]','active',NULL),('item','goal','Selected work','Reviewed intent','Why selected','["Item criterion"]','active',NULL),('other',NULL,'Private sibling','Do not copy','Private','[]','active',NULL);`);
  // Legacy canonical rows can predate enrollment and its composition triggers.
  // Construct that historical state before the production store installs guards.
  if (options.historicalCycle)
    db.prepare("UPDATE items SET parent_id='item' WHERE id='goal'").run();
  const work = new TelosWorkStore(path, { ordinaryConversation: (id) => id === 'lead' });
  const artifacts = new TelosArtifactStore(path);
  cleanup.push(() => {
    artifacts.close();
    work.close();
    db.close();
  });
  return { work, artifacts, db, actor: { kind: 'operator' as const, id: 'operator' } };
}
it('constructs the reviewed brief and ancestor criteria from canonical owners without sibling context', () => {
  const f = fixture();
  const context = reviewTelosWorkRoleContext({
    ...f,
    itemId: 'item',
    role: 'lead',
    selectedSourceSnapshotIds: [],
    selectedArtifactRefs: [],
  });
  expect(context.brief.revision).toBe(f.work.read('item', f.actor).revision);
  expect(context.brief.text).toContain('Reviewed intent');
  expect(context.parentCriteria).toEqual([
    {
      itemId: 'goal',
      revision: f.work.read('goal', f.actor).revision,
      criteria: ['Goal criterion'],
    },
  ]);
  expect(context.overallGoal.text).toBe('Overall goal');
  expect(JSON.stringify(context)).not.toContain('Private sibling');
  expect(context.sources).toEqual([]);
});
function review(
  f: ReturnType<typeof fixture>,
  change: Partial<Parameters<typeof reviewTelosWorkRoleContext>[0]> = {},
) {
  return reviewTelosWorkRoleContext({
    ...f,
    itemId: 'item',
    role: 'lead',
    selectedSourceSnapshotIds: [],
    selectedArtifactRefs: [],
    ...change,
  });
}
it('refuses sibling artifacts, forged hashes and missing exact artifact revisions', () => {
  const f = fixture();
  const sibling = f.artifacts.save({
    itemId: 'other',
    filename: 'private.txt',
    title: 'Private',
    bytes: Buffer.from('Private bytes'),
    sessionId: 'user-upload:operator',
  });
  const own = f.artifacts.save({
    itemId: 'item',
    filename: 'reviewed.txt',
    title: 'Reviewed',
    bytes: Buffer.from('Reviewed bytes'),
    sessionId: 'user-upload:operator',
  });
  const ref = (artifact: typeof own) => ({
    artifactId: artifact.id,
    revision: artifact.revision,
    sha256: artifact.sha256,
  });
  expect(() => review(f, { selectedArtifactRefs: [ref(sibling)] })).toThrow(/unavailable/);
  expect(() =>
    review(f, { selectedArtifactRefs: [{ ...ref(own), sha256: '0'.repeat(64) }] }),
  ).toThrow(/unavailable/);
  expect(() => review(f, { selectedArtifactRefs: [{ ...ref(own), revision: 99 }] })).toThrow(
    /unavailable/,
  );
  expect(review(f, { selectedArtifactRefs: [ref(own)] }).artifacts).toEqual([ref(own)]);
});
it('selects only reviewed source snapshots belonging to the exact item', () => {
  const f = fixture();
  for (const itemId of ['item', 'other'])
    f.work.execute(
      {
        operation: 'source',
        itemId,
        requestId: itemId,
        expectedRevision: f.work.read(itemId, f.actor).revision,
        snapshot: {
          version: 1,
          itemId,
          snapshotId: `source-${itemId}`,
          source: null,
          selection: {
            kind: 'selected',
            messageIds: ['reviewed-message'],
            blockIds: [],
            throughSequence: 0,
          },
          adoptedBrief: null,
          artifacts: [],
          author: null,
          sourceCreatedAt: null,
          adoptedAt: null,
        },
      },
      f.actor,
    );
  expect(
    review(f, { selectedSourceSnapshotIds: ['source-item'] }).sources.map(
      (source) => source.snapshotId,
    ),
  ).toEqual(['source-item']);
  expect(() => review(f, { selectedSourceSnapshotIds: ['source-other'] })).toThrow(/unavailable/);
  expect(review(f).sources).toEqual([]);
});
it('changes the parent pin when canonical criteria change', () => {
  const f = fixture();
  const before = review(f);
  f.db
    .prepare("UPDATE items SET acceptance_criteria='[\"Changed criterion\"]' WHERE id='goal'")
    .run();
  expect(review(f).parentCriteria[0].revision).not.toBe(before.parentCriteria[0].revision);
});
it('requires the nearest explicit available outcome lead for a worker', () => {
  const f = fixture();
  expect(() => review(f, { role: 'worker' })).toThrow(/lead unavailable/);
  for (const change of [
    { operation: 'classify', kind: 'outcome' },
    {
      operation: 'link',
      role: 'lead',
      conversation: { namespace: 'mitzo', conversationId: 'lead' },
    },
    {
      operation: 'assign',
      role: 'lead',
      conversationId: 'lead',
      expectedAssignmentRevision: 0,
    },
  ])
    f.work.execute(
      {
        ...change,
        itemId: 'goal',
        requestId: JSON.stringify(change),
        expectedRevision: f.work.read('goal', f.actor).revision,
      },
      f.actor,
    );
  expect(review(f, { role: 'worker' }).leadConversationId).toBe('lead');
  expect(review(f, { role: 'worker' }).executionTaskId).toBeUndefined();
});
it('keeps unknown original selection unavailable and private profile evidence out of role context', () => {
  const f = fixture();
  f.work.execute(
    {
      operation: 'source',
      itemId: 'item',
      requestId: 'unknown-source',
      expectedRevision: f.work.read('item', f.actor).revision,
      snapshot: {
        version: 1,
        itemId: 'item',
        snapshotId: 'legacy-unknown',
        source: null,
        selection: { kind: 'unknown' },
        adoptedBrief: null,
        artifacts: [],
        author: null,
        sourceCreatedAt: null,
        adoptedAt: null,
      },
    },
    f.actor,
  );
  expect(() => review(f, { selectedSourceSnapshotIds: ['legacy-unknown'] })).toThrow(/unavailable/);
  f.db.exec(
    "ALTER TABLE items ADD COLUMN profile TEXT; UPDATE items SET profile='LifeOps' WHERE id='item'",
  );
  expect(() => review(f)).toThrow(/unavailable/);
});

it('rejects a historical ancestry cycle that predates Work enrollment', () => {
  const f = fixture({ historicalCycle: true });
  expect(() => review(f)).toThrow(/ancestry/);
});
