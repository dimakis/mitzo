import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TelosArtifactStore } from '../../telos-artifact-store.js';

/** Restore the synthetic canonical-owner backup, then run the real supported
 * artifact initializer. The JSON receipt records owner/source/snapshot hashes.
 * No hand-built tables, live data, credentials or service calls are used.
 */
export function createCollaborationRetainedArtifactFixture() {
  const root = mkdtempSync(join(tmpdir(), 'retained-forward-'));
  const path = join(root, 'telos.db');
  const sql = readFileSync(new URL('./canonical-artifact-owner.sql', import.meta.url), 'utf8');
  const receipt = JSON.parse(
    readFileSync(new URL('./canonical-artifact-owner.json', import.meta.url), 'utf8'),
  ) as { snapshotSha256: string; itemId: string };
  if (createHash('sha256').update(sql).digest('hex') !== receipt.snapshotSha256)
    throw Error('Canonical fixture backup changed');
  const db = new Database(path);
  // SQLite dumps may emit child tables before parents; restore as a backup,
  // then re-enable real owner foreign-key enforcement before opening the store.
  db.pragma('foreign_keys = OFF');
  db.exec(sql);
  db.pragma('foreign_keys = ON');
  db.close();
  let store = new TelosArtifactStore(path);
  return {
    path,
    itemId: receipt.itemId,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = new TelosArtifactStore(path);
    },
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
