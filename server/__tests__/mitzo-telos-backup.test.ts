import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, realpath, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { TaskStore } from '../task-store.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';
import { captureMitzoTelosCore } from '../backup/mitzo-telos.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'mitzo-telos-backup-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'telos.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE items(id TEXT PRIMARY KEY, summary TEXT, parent_id TEXT REFERENCES items(id), session_id TEXT);
    INSERT INTO items VALUES ('parent','Parent',NULL,NULL),('child','Child','parent','session-a');
    CREATE TABLE links(id TEXT PRIMARY KEY, item_id TEXT REFERENCES items(id), type TEXT, url TEXT, title TEXT, description TEXT, created_at TEXT);`);
  db.close();
  const owners = {
    events: new EventStore(join(root, 'events.db')),
    tasks: new TaskStore(join(root, 'tasks.db')),
    telos: new TelosArtifactStore(path),
  };
  cleanup.push(async () => {
    owners.events.close();
    owners.tasks.close();
    owners.telos.close();
  });
  return { root, path, owners, destination: join(root, 'capture') };
}
it('restores actual owner stores with DB-only Telos relationships, artifact bytes and task links', async () => {
  const f = await fixture();
  f.owners.events.append('session-a', 'message_start', { messageId: 'm1' });
  const parent = f.owners.tasks.create({ title: 'Parent' });
  const child = f.owners.tasks.create({ title: 'Child', parentId: parent.id });
  const artifact = f.owners.telos.save({
    itemId: 'child',
    filename: 'evidence.md',
    title: 'Evidence',
    bytes: Buffer.from('SYNTHETIC-EVIDENCE'),
    sessionId: 'session-a',
    sourcePath: '/synthetic/evidence.md',
  });
  await captureMitzoTelosCore({ owners: f.owners, destination: f.destination });
  f.owners.events.close();
  f.owners.tasks.close();
  f.owners.telos.close();
  for (const name of ['events.db', 'tasks.db', 'telos.db']) {
    for (const suffix of ['', '-wal', '-shm'])
      await rm(join(f.root, name + suffix), { force: true });
  }
  const events = new EventStore(join(f.destination, 'mitzo-events', 'store.db'));
  const tasks = new TaskStore(join(f.destination, 'mitzo-tasks', 'store.db'));
  const telos = new TelosArtifactStore(join(f.destination, 'telos', 'store.db'));
  try {
    expect(events.getSessionEvents('session-a')).toHaveLength(1);
    expect(tasks.get(child.id)?.parentId).toBe(parent.id);
    expect(telos.read(artifact.id).bytes.toString()).toBe('SYNTHETIC-EVIDENCE');
    const db = new Database(join(f.destination, 'telos', 'store.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT parent_id,session_id FROM items WHERE id=?').get('child')).toEqual({
        parent_id: 'parent',
        session_id: 'session-a',
      });
      expect(db.prepare('SELECT url FROM links WHERE item_id=?').get('child')).toEqual({
        url: `/api/telos/artifacts/${artifact.id}`,
      });
    } finally {
      db.close();
    }
    expect(
      JSON.parse(await readFile(join(f.destination, 'coverage.json'), 'utf8')).required,
    ).toEqual(['mitzo-events', 'mitzo-tasks', 'telos']);
  } finally {
    events.close();
    tasks.close();
    telos.close();
  }
});
it.each(['owner', 'external'] as const)(
  'discards an inconsistent capture after a %s write while saving continues',
  async (writer) => {
    const f = await fixture();
    const original = f.owners.telos.backupSnapshot.bind(f.owners.telos);
    vi.spyOn(f.owners.telos, 'backupSnapshot').mockImplementation(async (path) => {
      await original(path);
      if (writer === 'owner') f.owners.tasks.create({ title: 'Saved during backup' });
      else {
        const db = new Database(f.path);
        try {
          db.prepare('UPDATE items SET summary=? WHERE id=?').run('Saved during backup', 'child');
        } finally {
          db.close();
        }
      }
    });
    await expect(
      captureMitzoTelosCore({ owners: f.owners, destination: f.destination }),
    ).rejects.toThrow('capture');
    await expect(access(f.destination)).rejects.toThrow();
    f.owners.tasks.create({ title: 'Saving still works' });
    vi.restoreAllMocks();
    await captureMitzoTelosCore({ owners: f.owners, destination: f.destination });
  },
);
it('fails before capture when a required owner is unavailable or has a live transaction', async () => {
  const f = await fixture();
  f.owners.tasks.getDatabase().exec('BEGIN');
  try {
    await expect(
      captureMitzoTelosCore({ owners: f.owners, destination: f.destination }),
    ).rejects.toThrow();
  } finally {
    f.owners.tasks.getDatabase().exec('ROLLBACK');
  }
  await expect(access(f.destination)).rejects.toThrow();
  f.owners.events.close();
  await expect(
    captureMitzoTelosCore({ owners: f.owners, destination: f.destination }),
  ).rejects.toThrow();
});

it('binds captures to existing running owners and resolves canonical Telos only when invoked', async () => {
  const f = await fixture();
  const { bindMitzoTelosCoreCapture } = await import('../backup/mitzo-telos-binding.js');
  const telosPath = vi.fn(() => f.path);
  const capture = bindMitzoTelosCoreCapture({
    events: f.owners.events,
    tasks: f.owners.tasks,
    telosPath,
  });
  expect(telosPath).not.toHaveBeenCalled();
  await capture(f.destination);
  expect(telosPath).toHaveBeenCalledOnce();
  expect(
    JSON.parse(await readFile(join(f.destination, 'coverage.json'), 'utf8')).required,
  ).toHaveLength(3);
  // Reopening for another invocation must not retain a closed Telos owner.
  await capture(join(f.root, 'second-capture'));
  expect(telosPath).toHaveBeenCalledTimes(2);
});
it('does not create a missing Telos database or leak its configured path', async () => {
  const f = await fixture();
  const { bindMitzoTelosCoreCapture } = await import('../backup/mitzo-telos-binding.js');
  const missing = join(f.root, 'private-missing-telos.db');
  const capture = bindMitzoTelosCoreCapture({
    events: f.owners.events,
    tasks: f.owners.tasks,
    telosPath: () => missing,
  });
  await expect(capture(f.destination)).rejects.toThrow('Mitzo/Telos backup unavailable');
  await expect(access(missing)).rejects.toThrow();
  await expect(access(f.destination)).rejects.toThrow();
});
