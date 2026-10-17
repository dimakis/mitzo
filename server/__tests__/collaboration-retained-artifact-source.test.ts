import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { createRetainedCollaborationArtifactSource } from '../collaboration-retained-artifact-source.js';
import { createCollaborationRetainedArtifactFixture } from './fixtures/collaboration-retained-artifacts.js';

const fixtures: ReturnType<typeof createCollaborationRetainedArtifactFixture>[] = [];
afterEach(() => {
  fixtures.splice(0).forEach((f) => f.close());
  vi.restoreAllMocks();
});
function fixture() {
  const f = createCollaborationRetainedArtifactFixture();
  fixtures.push(f);
  const save = (text = '  Older\r\nπ saved bytes ', sessionId = 'removed-origin') =>
    f.store.save({
      itemId: f.itemId,
      filename: 'selected.md',
      title: 'Selected',
      bytes: Buffer.from(text),
      sessionId,
      requestId: text,
    });
  const older = save();
  const pin = { artifactId: older.id, revision: older.revision, sha256: older.sha256 };
  const authorizeArtifact = vi.fn(async () => {});
  const source = () =>
    createRetainedCollaborationArtifactSource({ store: f.store, authorizeArtifact });
  return {
    ...f,
    get store() {
      return f.store;
    },
    save,
    older,
    pin,
    authorizeArtifact,
    source,
  };
}
it('reads an explicitly selected older revision through real retained owner after restart without the origin session', async () => {
  const f = fixture();
  f.save('Latest saved bytes');
  f.restart();
  const content = await f.source().read(f.pin);
  expect(content).toMatchObject({
    ...f.pin,
    filename: 'selected.md',
    itemId: f.itemId,
    retention: 'independent',
    provenance: { sessionId: 'removed-origin', sourceKind: 'session_artifact' },
  });
  expect(content.bytes).toEqual(Buffer.from('  Older\r\nπ saved bytes '));
  expect(f.authorizeArtifact).toHaveBeenCalledWith(
    f.pin,
    expect.objectContaining({ itemId: f.itemId, revision: 1 }),
  );
  expect(f.store.read(f.older.id).revision).toBe(2);
});
it('refuses missing retention or any pin mismatch rather than selecting latest', async () => {
  const f = fixture();
  f.save('Latest saved bytes');
  for (const pin of [
    { ...f.pin, revision: 3 },
    { ...f.pin, sha256: '0'.repeat(64) },
    { ...f.pin, artifactId: 'missing' },
  ])
    await expect(f.source().read(pin)).rejects.toMatchObject({ code: 'snapshot_changed' });
});
it('renews artifact authorization and refuses a current access change', async () => {
  const f = fixture();
  const source = f.source();
  await source.read(f.pin);
  f.authorizeArtifact.mockRejectedValueOnce(Error('Access revoked'));
  await expect(source.read(f.pin)).rejects.toThrow('Access revoked');
});
it.each(['lifeops', 'tamper', 'remove'] as const)(
  'checks custody and privacy after awaited authorization: %s',
  async (change) => {
    const f = fixture();
    f.authorizeArtifact.mockImplementationOnce(async () => {
      const db = new Database(f.path);
      if (change === 'lifeops')
        db.prepare('UPDATE items SET profile=? WHERE id=?').run('Life-Ops', f.itemId);
      if (change === 'tamper')
        db.prepare('UPDATE telos_artifact_revisions SET bytes=? WHERE id=? AND revision=?').run(
          Buffer.from('CORRUPTED'),
          f.pin.artifactId,
          1,
        );
      if (change === 'remove') db.pragma('foreign_keys = OFF'); // Simulated custody loss, not a supported delete.
      if (change === 'remove')
        db.prepare('DELETE FROM telos_artifact_revisions WHERE id=? AND revision=?').run(
          f.pin.artifactId,
          1,
        );
      db.close();
    });
    await expect(f.source().read(f.pin)).rejects.toMatchObject({ code: 'snapshot_changed' });
  },
);
it('keeps private LifeOps and scoped source packets outside ordinary forwarding', async () => {
  const f = fixture();
  const capture = f.save('Private reviewed packet', 'source-capture:private');
  await expect(
    f.source().read({ artifactId: capture.id, revision: capture.revision, sha256: capture.sha256 }),
  ).rejects.toThrow();
  const db = new Database(f.path);
  db.prepare('UPDATE items SET profile=? WHERE id=?').run('life_ops', f.itemId);
  db.close();
  await expect(f.source().read(f.pin)).rejects.toThrow();
});
it('uses real save retry/conflict/rollback owners and never writes through the reader', async () => {
  const f = fixture();
  expect(f.save().revision).toBe(1);
  expect(() =>
    f.store.save({
      itemId: f.itemId,
      filename: 'selected.md',
      title: 'Selected',
      bytes: Buffer.from('conflict'),
      sessionId: 'removed-origin',
      requestId: '  Older\r\nπ saved bytes ',
    }),
  ).toThrow(/identity/);
  const db = new Database(f.path);
  const counts = () =>
    ['items', 'links', 'telos_artifact_revisions', 'telos_artifact_save_requests'].map((table) =>
      db.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
    );
  const before = counts();
  await f.source().read(f.pin);
  await f.source().read(f.pin);
  expect(counts()).toEqual(before);
  db.exec(
    "CREATE TRIGGER fail_link BEFORE INSERT ON links BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
  );
  expect(() =>
    f.store.save({
      itemId: f.itemId,
      filename: 'rolled-back.md',
      title: 'Rollback',
      bytes: Buffer.from('discard'),
      sessionId: 'fixture',
      requestId: 'rolled-back',
    }),
  ).toThrow('synthetic rollback');
  expect(counts()).toEqual(before);
  db.close();
});
it('does not let concurrent document edits or a lost save response retarget an older selection', async () => {
  const f = fixture();
  const input = {
    id: f.older.id,
    expectedRevision: 1,
    content: 'First explicit edit',
    requestId: 'edit',
    operatorId: 'fixture',
  };
  const edited = f.store.editDocument(input);
  expect(edited.revision).toBe(2);
  expect(f.store.editDocument(input)).toEqual(edited);
  expect(() =>
    f.store.editDocument({ ...input, requestId: 'competing', content: 'Competing edit' }),
  ).toThrow(/newer revision/);
  f.restart();
  expect((await f.source().read(f.pin)).bytes.toString()).toBe('  Older\r\nπ saved bytes ');
});

it('refuses oversized retained bytes before reading a BLOB', async () => {
  const f = fixture();
  const big = f.save('x'.repeat(512 * 1024 + 1));
  const read = vi.spyOn(f.store, 'readBoundedRevision');
  await expect(
    f.source().read({ artifactId: big.id, revision: big.revision, sha256: big.sha256 }),
  ).rejects.toMatchObject({ code: 'capacity_refused' });
  expect(read).not.toHaveBeenCalled();
});

it('exposes exact metadata without bytes and guards both stored size and actual BLOB length', () => {
  const f = fixture();
  expect(f.store.metadataForRevision(f.pin.artifactId, 1)).toEqual(f.older);
  expect(f.store.readBoundedRevision(f.pin.artifactId, 1, f.older.size).bytes).toEqual(
    Buffer.from('  Older\r\nπ saved bytes '),
  );
  expect(() => f.store.readBoundedRevision(f.pin.artifactId, 1, f.older.size - 1)).toThrow();
  for (const bound of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => f.store.readBoundedRevision(f.pin.artifactId, 1, bound)).toThrow();
  for (const revision of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => f.store.metadataForRevision(f.pin.artifactId, revision)).toThrow();
  const fault = new Database(f.path);
  fault.prepare('UPDATE telos_artifact_revisions SET size=? WHERE id=?').run(1, f.pin.artifactId);
  expect(() => f.store.metadataForRevision(f.pin.artifactId, 1)).toThrow();
  expect(() => f.store.readBoundedRevision(f.pin.artifactId, 1, 512 * 1024)).toThrow();
  fault.close();
});
it('accepts the bounded owner read at exactly 512 KiB and refuses the next byte', () => {
  const f = fixture();
  const exact = f.save('x'.repeat(512 * 1024));
  expect(f.store.readBoundedRevision(exact.id, exact.revision, 512 * 1024).bytes).toHaveLength(
    512 * 1024,
  );
  const tooLarge = f.save('x'.repeat(512 * 1024 + 1));
  expect(() => f.store.readBoundedRevision(tooLarge.id, tooLarge.revision, 512 * 1024)).toThrow();
});
