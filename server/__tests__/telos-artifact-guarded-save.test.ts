import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createCollaborationRetainedArtifactFixture } from './fixtures/collaboration-retained-artifacts.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';

let f: ReturnType<typeof createCollaborationRetainedArtifactFixture>;
beforeEach(() => {
  f = createCollaborationRetainedArtifactFixture();
});
afterEach(() => {
  f.close();
  vi.restoreAllMocks();
});
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function input() {
  return {
    itemId: f.itemId,
    filename: 'owned.md',
    title: 'Owned result',
    bytes: Buffer.from('Exact output'),
    sessionId: 'original-native-session',
    requestId: 'original-save',
    requestInputHash: hash('original approved selectors'),
  };
}
function count() {
  const db = new Database(f.path);
  try {
    return db.prepare('SELECT count(*) AS n FROM telos_artifact_revisions').get();
  } finally {
    db.close();
  }
}

it('commits exact bytes and original receipt, preserving Added date through a later revision', () => {
  const guard = vi.fn(() => {});
  const a = f.store.saveGuarded(input(), guard);
  expect(a).toMatchObject({
    revision: 1,
    sha256: hash('Exact output'),
    sessionId: 'original-native-session',
  });
  const db = new Database(f.path);
  try {
    const before = db.prepare('SELECT created_at FROM links WHERE id=?').get('artifact-' + a.id);
    const b = f.store.saveGuarded(
      {
        ...input(),
        bytes: Buffer.from('Later output'),
        requestId: 'next',
        requestInputHash: hash('next'),
      },
      guard,
    );
    expect(b.revision).toBe(2);
    expect(db.prepare('SELECT created_at FROM links WHERE id=?').get('artifact-' + a.id)).toEqual(
      before,
    );
    expect(f.store.saveGuarded(input(), guard)).toEqual(a);
    expect(f.store.read(a.id, 1).bytes.toString()).toBe('Exact output');
  } finally {
    db.close();
  }
  expect(guard).toHaveBeenCalled();
});

it.each(['before', 'after'] as const)('rolls back a scope refusal %s the mutation', (when) => {
  let calls = 0;
  expect(() =>
    f.store.saveGuarded(input(), () => {
      if (++calls === (when === 'before' ? 1 : 2)) throw Error('original owner revoked');
    }),
  ).toThrow('original owner revoked');
  expect(count()).toEqual({ n: 0 });
  expect(
    f.store.retryReceipt(input().sessionId, input().requestId, input().requestInputHash),
  ).toBeUndefined();
});

it.each([
  async () => {},
  async () => {
    throw Error('not synchronous');
  },
  () => false,
])('rejects a non-void/async scope before mutation', async (guard) => {
  expect(() => f.store.saveGuarded(input(), guard)).toThrow();
  expect(count()).toEqual({ n: 0 });
  await Promise.resolve();
});

it('detaches approved input bytes and labels from the private callback arguments', () => {
  const original = input();
  const saved = f.store.saveGuarded(original, () => {
    original.bytes.fill(33);
    original.title = 'MUTATED';
  });
  expect(saved.title).toBe('Owned result');
  expect(f.store.read(saved.id, saved.revision).bytes.toString()).toBe('Exact output');
});

it.each(['privacy', 'bytes'] as const)(
  'rechecks real %s after the last scope callback before committing',
  (fault) => {
    const db = new Database(f.path);
    const borrowed = TelosArtifactStore.borrowConnection(db);
    try {
      let calls = 0;
      expect(() =>
        borrowed.saveGuarded(input(), () => {
          if (++calls !== 2) return;
          if (fault === 'privacy')
            db.prepare('UPDATE items SET profile=? WHERE id=?').run('lifeops', f.itemId);
          else
            db.prepare('UPDATE telos_artifact_revisions SET bytes=?').run(
              Buffer.alloc(input().bytes.length, 33),
            );
        }),
      ).toThrow();
      expect(count()).toEqual({ n: 0 });
      expect(db.inTransaction).toBe(false);
    } finally {
      borrowed.close();
      expect(db.open).toBe(true);
      db.close();
    }
  },
);

it('does not treat a borrowed active outer transaction as the guarded commit owner', () => {
  const db = new Database(f.path);
  const borrowed = TelosArtifactStore.borrowConnection(db);
  try {
    db.transaction(() => {
      expect(() => borrowed.saveGuarded(input(), () => {})).toThrow(/outer|commit/i);
      expect(db.inTransaction).toBe(true);
      expect(db.prepare('SELECT count(*) AS n FROM telos_artifact_revisions').get()).toEqual({
        n: 0,
      });
      // Existing work-owned unguarded composition remains available to its owner.
      borrowed.save(input());
    })();
    expect(count()).toEqual({ n: 1 });
  } finally {
    borrowed.close();
    db.close();
  }
});
