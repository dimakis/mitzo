import process from 'node:process';
import { join } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  OFFLINE_CONTAINMENT_TARGET,
  offlineContainmentDigest as digest,
} from './staging-offline-containment-contract.mjs';
const refuse = () =>
  Error('Exact new native disposition ledger unavailable; preserve original row and guard');
/** Concrete append-only SQLite CAS. An opened ledger exposes no native lease,
 * capacity grant, adoption, retirement, reset or replay method. */
export function createContainedNativeDispositionLedger({
  root,
  assertOriginalGuard,
  assertNativeAuthorityCurrent,
}) {
  if (
    root !== OFFLINE_CONTAINMENT_TARGET.canonicalRoot ||
    typeof assertOriginalGuard !== 'function' ||
    typeof assertNativeAuthorityCurrent !== 'function'
  )
    throw refuse();
  const path = join(root, 'registry/staging.db');
  const open = (readonly) => {
    const s = lstatSync(path),
      p = lstatSync(join(root, 'registry'));
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.uid !== process.getuid() ||
      s.nlink !== 1 ||
      (s.mode & 0o777) !== 0o600 ||
      realpathSync(path) !== path ||
      !p.isDirectory() ||
      p.uid !== process.getuid() ||
      (p.mode & 0o777) !== 0o700 ||
      realpathSync(join(root, 'registry')) !== join(root, 'registry')
    )
      throw refuse();
    return new Database(path, { readonly, fileMustExist: true });
  };
  const validate = (db, plan) => {
    assertOriginalGuard();
    const f = plan.facts;
    if (
      f.canonicalRoot !== root ||
      f.capacity !== 1 ||
      f.original.launchId !== OFFLINE_CONTAINMENT_TARGET.original.launchId ||
      f.original.instanceId !== OFFLINE_CONTAINMENT_TARGET.original.instanceId ||
      f.original.sourceCommit !== OFFLINE_CONTAINMENT_TARGET.original.sourceCommit ||
      f.original.state !== 'retirement_uncertain' ||
      digest(f.original) !== plan.originalRowSha256 ||
      db.prepare('SELECT capacity FROM policy WHERE id=1').get()?.capacity !== 1
    )
      throw refuse();
    const rows = db.prepare('SELECT * FROM launches').all();
    if (rows.length !== 1 || digest(rows[0]) !== plan.originalRowSha256) throw refuse();
    if (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='native_capacity_dispositions'",
        )
        .get() &&
      db.prepare('SELECT COUNT(*) AS n FROM native_capacity_dispositions').get().n !== 0
    )
      throw refuse();
  };
  return Object.freeze({
    assertAbsent(plan) {
      const db = open(true);
      try {
        validate(db, plan);
      } finally {
        db.close();
      }
    },
    append(plan) {
      assertOriginalGuard();
      assertNativeAuthorityCurrent(plan.sha256);
      const db = open(false);
      try {
        db.pragma('synchronous = FULL');
        db.transaction(() => {
          validate(db, plan);
          assertNativeAuthorityCurrent(plan.sha256);
          db.exec(
            'CREATE TABLE IF NOT EXISTS native_capacity_dispositions(launchId TEXT PRIMARY KEY,allocation TEXT UNIQUE NOT NULL,operation TEXT NOT NULL,classification TEXT NOT NULL,recordJson TEXT NOT NULL,planSha256 TEXT NOT NULL,registrationJson TEXT NOT NULL,archive TEXT NOT NULL,containmentReceiptSha256 TEXT NOT NULL)',
          );
          const f = plan.facts;
          db.prepare('INSERT INTO native_capacity_dispositions VALUES(?,?,?,?,?,?,?,?,?)').run(
            f.original.launchId,
            f.allocation,
            f.operation,
            'one_new_allocation_cleanup_unconfirmed',
            JSON.stringify(f.original),
            plan.sha256,
            JSON.stringify(f.registration),
            f.archiveRoot,
            f.containmentReceiptSha256,
          );
          assertOriginalGuard();
          assertNativeAuthorityCurrent(plan.sha256);
          if (
            digest(db.prepare('SELECT * FROM launches').all()) !== digest([f.original]) ||
            db.prepare('SELECT capacity FROM policy WHERE id=1').get()?.capacity !== 1
          )
            throw refuse();
        }).immediate();
      } finally {
        db.close();
      }
    },
  });
}
