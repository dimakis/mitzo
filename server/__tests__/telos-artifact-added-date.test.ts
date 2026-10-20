import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCollaborationRetainedArtifactFixture } from './fixtures/collaboration-retained-artifacts.js';

const firstDate = '2026-10-20T09:00:00.000Z';
const editDate = '2026-10-20T10:00:00.000Z';
const laterDate = '2026-10-20T11:00:00.000Z';
let fixture: ReturnType<typeof createCollaborationRetainedArtifactFixture>;
let db: Database.Database;
beforeEach(() => {
  fixture = createCollaborationRetainedArtifactFixture();
  db = new Database(fixture.path);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(firstDate);
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
  fixture.close();
});
function input() {
  return {
    itemId: fixture.itemId,
    filename: 'plan.md',
    title: 'Original title',
    bytes: Buffer.from('# Original r1'),
    sessionId: 'original-conversation',
  };
}
function link(id: string) {
  return db.prepare('SELECT * FROM links WHERE id=?').get(`artifact-${id}`) as
    | {
        id: string;
        item_id: string;
        type: string;
        url: string;
        title: string;
        description: string;
        created_at: string;
      }
    | undefined;
}

it('preserves the association Added date through the Files edit owner while keeping revision dates separate', () => {
  const original = fixture.store.save(input());
  const before = link(original.id);
  expect(before?.created_at).toBe(firstDate);
  vi.setSystemTime(editDate);
  const request = {
    id: original.id,
    expectedRevision: 1,
    content: '# Edited r2',
    requestId: 'files-edit-1',
    operatorId: 'synthetic-operator',
  };
  const edited = fixture.store.editDocument(request);
  expect(link(original.id)).toEqual(before);
  expect(edited).toMatchObject({
    revision: 2,
    createdAt: editDate,
    sourceKind: 'user_edit',
    sessionId: 'user-edit:synthetic-operator',
  });
  expect(fixture.store.read(original.id, 1)).toMatchObject({ ...original, bytes: input().bytes });
  expect(fixture.store.read(original.id, 2).bytes.toString()).toBe('# Edited r2');
  vi.setSystemTime(laterDate);
  expect(fixture.store.editDocument(request)).toEqual(edited);
  expect(link(original.id)).toEqual(before);
  expect(fixture.store.revisionPage(original.id).artifacts.map((a) => a.revision)).toEqual([2, 1]);
  fixture.restart();
  expect(link(original.id)).toEqual(before);
  expect(fixture.store.metadataForRevision(original.id, 2).createdAt).toBe(editDate);
});

it('updates existing association metadata without replacing its original timestamp', () => {
  const original = fixture.store.save(input());
  const before = link(original.id)!;
  vi.setSystemTime(editDate);
  const request = {
    ...input(),
    title: 'Renamed title',
    sourcePath: '/synthetic/renamed.md',
    requestId: 'metadata-update-1',
  };
  const renamed = fixture.store.save(request);
  expect(renamed).toMatchObject({
    id: original.id,
    revision: 2,
    title: 'Renamed title',
    createdAt: editDate,
    sha256: original.sha256,
  });
  expect(link(original.id)).toEqual({ ...before, title: 'Renamed title' });
  vi.setSystemTime(laterDate);
  expect(fixture.store.save(request)).toEqual(renamed);
  expect(link(original.id)).toEqual({ ...before, title: 'Renamed title' });
});

it('dates a newly created association at its own creation, even for an existing artifact', () => {
  const original = fixture.store.save(input());
  db.prepare('DELETE FROM links WHERE id=?').run(`artifact-${original.id}`);
  vi.setSystemTime(editDate);
  const next = fixture.store.save({ ...input(), bytes: Buffer.from('# A later revision') });
  expect(next.revision).toBe(2);
  expect(link(original.id)?.created_at).toBe(editDate);
  const another = fixture.store.save({ ...input(), filename: 'new-document.md' });
  expect(link(another.id)?.created_at).toBe(editDate);
  expect(fixture.store.metadataForRevision(original.id, 1).createdAt).toBe(firstDate);
});

it.each(['2026-10-20T09:30:00.000Z', ''])(
  'preserves the recorded legacy date %j without guessing a backfill',
  (recordedDate) => {
    const original = fixture.store.save(input());
    db.prepare('UPDATE links SET created_at=? WHERE id=?').run(
      recordedDate,
      `artifact-${original.id}`,
    );
    vi.setSystemTime(editDate);
    fixture.store.save({ ...input(), bytes: Buffer.from('# Revised legacy document') });
    expect(link(original.id)?.created_at).toBe(recordedDate);
    expect(fixture.store.metadataForRevision(original.id, 1).createdAt).toBe(firstDate);
    expect(fixture.store.metadataForRevision(original.id, 2).createdAt).toBe(editDate);
  },
);

it('keeps source-capture revisions out of document associations', () => {
  const capture = fixture.store.save({
    ...input(),
    filename: 'capture.json',
    sessionId: 'source-capture:synthetic',
  });
  vi.setSystemTime(editDate);
  fixture.store.save({
    ...input(),
    filename: 'capture.json',
    sessionId: 'source-capture:synthetic',
    bytes: Buffer.from('{}'),
  });
  expect(link(capture.id)).toBeUndefined();
  expect(fixture.store.revisionPage.bind(fixture.store, capture.id)).toThrow();
});

it('rolls back revision insertion and preserves the original association if its write fails', () => {
  const original = fixture.store.save(input());
  const before = link(original.id);
  // Fault injection on the existing owner's synthetic DB, after revision insertion.
  db.exec(`CREATE TRIGGER reject_artifact_link BEFORE INSERT ON links
    WHEN NEW.type='artifact' BEGIN SELECT RAISE(ABORT,'synthetic alias failure'); END;`);
  vi.setSystemTime(editDate);
  expect(() => fixture.store.save({ ...input(), bytes: Buffer.from('# Must roll back') })).toThrow(
    'synthetic alias failure',
  );
  expect(link(original.id)).toEqual(before);
  expect(fixture.store.revisionPage(original.id).artifacts.map((a) => a.revision)).toEqual([1]);
  expect(fixture.store.read(original.id, 1).bytes).toEqual(input().bytes);
});
