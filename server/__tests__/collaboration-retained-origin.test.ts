import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCollaborationRetainedArtifactFixture } from './fixtures/collaboration-retained-artifacts.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';
let fixture: ReturnType<typeof createCollaborationRetainedArtifactFixture>;
beforeEach(() => {
  fixture = createCollaborationRetainedArtifactFixture();
});
afterEach(() => {
  fixture.close();
  vi.restoreAllMocks();
});
function versions() {
  const save = (text: string, sessionId: string, filename = 'plan.md') =>
    fixture.store.save({
      itemId: fixture.itemId,
      filename,
      title: 'Plan',
      bytes: Buffer.from(text),
      sessionId,
    });
  const first = save('first', 'opened-source');
  const second = save('second', 'user-edit:absent-origin');
  save('latest', 'another-origin');
  const unrelated = save('unrelated', 'other-source', 'unrelated.md');
  return { first, second, unrelated };
}
it('finds real origin association for an exact older selected version without substituting latest or hydrating blobs', () => {
  const f = versions();
  const bytes = vi.spyOn(fixture.store, 'readBoundedRevision');
  const read = vi.spyOn(fixture.store, 'read');
  expect(fixture.store.hasConversationOrigin(f.second.id, f.second.revision, 'opened-source')).toBe(
    true,
  );
  expect(
    fixture.store.hasConversationOrigin(f.unrelated.id, f.unrelated.revision, 'opened-source'),
  ).toBe(false);
  expect(fixture.store.hasConversationOrigin(f.second.id, 9999, 'opened-source')).toBe(false);
  expect(
    fixture.store.hasConversationOrigin(f.second.id, f.second.revision, 'unrelated-source'),
  ).toBe(false);
  expect(bytes).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
it('renews real current item privacy instead of treating stored origin as an access grant', () => {
  const f = versions();
  expect(fixture.store.hasConversationOrigin(f.second.id, f.second.revision, 'opened-source')).toBe(
    true,
  );
  const db = new Database(fixture.path);
  db.prepare('UPDATE items SET profile=? WHERE id=?').run('life_ops', fixture.itemId);
  db.close();
  expect(fixture.store.hasConversationOrigin(f.second.id, f.second.revision, 'opened-source')).toBe(
    false,
  );
});
it('opens the existing retained owner without schema initialization or write capability', () => {
  const f = versions();
  const db = new Database(fixture.path);
  const schema = () =>
    db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
  const before = schema();
  const reader = TelosArtifactStore.openReadOnly(fixture.path);
  try {
    expect(reader.hasConversationOrigin(f.second.id, f.second.revision, 'opened-source')).toBe(
      true,
    );
    expect(reader.metadataForRevision(f.second.id, 2)).toMatchObject({
      revision: 2,
      sessionId: 'user-edit:absent-origin',
    });
    expect(() =>
      reader.save({
        itemId: fixture.itemId,
        filename: 'forbidden.md',
        title: 'Forbidden',
        bytes: Buffer.from('no'),
        sessionId: 'caller',
      }),
    ).toThrow(/readonly/i);
    expect(schema()).toEqual(before);
  } finally {
    reader.close();
    db.close();
  }
});
it('does not create a missing retained database during observational access', () => {
  const path = join(dirname(fixture.path), 'missing.db');
  expect(() => TelosArtifactStore.openReadOnly(path)).toThrow();
  expect(existsSync(path)).toBe(false);
});
