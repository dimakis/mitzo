import Database from 'better-sqlite3';
import {
  createFreshTelosDatabaseFiles,
  type TelosDatabaseFiles,
} from '@mitzo/protocol/telos-sqlite-owners';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TelosArtifactStore } from '../../telos-artifact-store.js';

/** Restore the synthetic canonical-owner backup, then run the real supported
 * artifact initializer. The JSON receipt records owner/source/snapshot hashes.
 * No hand-built tables, live data, credentials or service calls are used.
 */
function restoreArtifactDatabase(path: string, owned: boolean) {
  const sql = readFileSync(new URL('./canonical-artifact-owner.sql', import.meta.url), 'utf8');
  const receipt = JSON.parse(
    readFileSync(new URL('./canonical-artifact-owner.json', import.meta.url), 'utf8'),
  ) as { snapshotSha256: string; itemId: string };
  if (createHash('sha256').update(sql).digest('hex') !== receipt.snapshotSha256)
    throw Error('Canonical fixture backup changed');
  const db = new Database(path);
  if (owned) db.pragma('journal_mode=WAL');
  // SQLite dumps may emit child tables before parents; restore as a backup,
  // then re-enable real owner foreign-key enforcement before opening the store.
  db.pragma('foreign_keys = OFF');
  db.exec(sql);
  db.pragma('foreign_keys = ON');
  db.close();
  return receipt;
}
/** NEW isolated files only; never enroll or migrate an existing database family. */
export function restoreOwnedCollaborationArtifactFixture(files: TelosDatabaseFiles) {
  createFreshTelosDatabaseFiles(files);
  return restoreArtifactDatabase(files.canonical, true);
}
export function createCollaborationRetainedArtifactFixture(owned = false) {
  const root = mkdtempSync(join(tmpdir(), 'retained-forward-'));
  const path = join(root, 'telos.db');
  const files = {
    canonical: path,
    events: join(root, '.mitzo/events.db'),
    tasks: join(root, '.mitzo/tasks.db'),
  };
  const receipt = owned
    ? restoreOwnedCollaborationArtifactFixture(files)
    : restoreArtifactDatabase(path, false);
  function selectOwner<T>(action: () => T): T {
    if (!owned) return action();
    const previousRoot = process.env.REPO_PATH,
      previousPath = process.env.TELOS_DB_PATH;
    try {
      process.env.REPO_PATH = root;
      process.env.TELOS_DB_PATH = path;
      return action();
    } finally {
      if (previousRoot === undefined) delete process.env.REPO_PATH;
      else process.env.REPO_PATH = previousRoot;
      if (previousPath === undefined) delete process.env.TELOS_DB_PATH;
      else process.env.TELOS_DB_PATH = previousPath;
    }
  }
  let store = selectOwner(() => new TelosArtifactStore(path));
  return {
    path,
    selectOwner,
    itemId: receipt.itemId,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = selectOwner(() => new TelosArtifactStore(path));
    },
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
