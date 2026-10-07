import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/** Native owner capability. Never accepts a database path to reopen or raw-copy. */
export interface SQLiteBackupOwner {
  backupWatermark(): string;
  backupSnapshot(destination: string): Promise<void>;
}
function available(db: Database.Database): void {
  if (!db.open || db.inTransaction) throw Error('Backup owner unavailable or in transaction');
}
/** Own DML, other connections' commits and persistent schema/header changes. */
export function databaseBackupWatermark(db: Database.Database): string {
  available(db);
  return createHash('sha256')
    .update(
      JSON.stringify([
        db.prepare('SELECT CAST(total_changes() AS TEXT) AS value').get(),
        ...['data_version', 'schema_version', 'user_version', 'application_id'].map((name) =>
          db.pragma(name, { simple: true }),
        ),
      ]),
    )
    .digest('hex');
}
export async function backupOwnedDatabase(
  db: Database.Database,
  destination: string,
): Promise<void> {
  available(db);
  if (
    !isAbsolute(destination) ||
    resolve(destination) !== destination ||
    realpathSync(dirname(destination)) !== dirname(destination)
  )
    throw Error('Unsafe snapshot destination');
  try {
    lstatSync(destination);
    throw Error('Snapshot destination already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Caller owns a private staging directory and validates the entire group watermark.
  await db.backup(destination);
}
