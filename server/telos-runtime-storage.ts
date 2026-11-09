import { lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  openTelosOwnedDatabase,
  selectedTelosDatabaseFiles,
} from '@mitzo/protocol/telos-sqlite-owners';
import { initializeTelosRuntimeSchema, TelosRuntimeStore } from './telos-runtime-store.js';

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function retainedRecoveryEvidence(path: string): boolean {
  if (
    entryExists(join(dirname(path), '.telos-file-owners')) ||
    entryExists(path + '.migration.json')
  )
    return true;
  try {
    return readdirSync(dirname(path)).some((name) => name.startsWith(basename(path) + '-'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Bootstrap only, before accepting requests. Never chooses the legacy store as
 * fallback, copies live data, retires another writer or creates an empty substitute. */
export function ensureTelosRuntimeStorage(legacyRepo: string) {
  const path = selectedTelosDatabaseFiles().canonical;
  const present = entryExists(path);
  if (!present) {
    const legacy = join(legacyRepo, 'command_center/data/smart_todo.db');
    if (entryExists(legacy) || retainedRecoveryEvidence(legacy))
      throw Error('Telos offline migration required before startup');
    if (retainedRecoveryEvidence(path))
      throw Error('Retained Telos family cannot be replaced with empty storage');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700)
    throw Error('Private owned Telos runtime directory required');
  if (!present) {
    TelosRuntimeStore.initialize(path);
  } else {
    const file = lstatSync(path);
    if (
      !file.isFile() ||
      file.uid !== process.getuid?.() ||
      file.nlink !== 1 ||
      (file.mode & 0o777) !== 0o600
    )
      throw Error('Private owned Telos runtime database required');
    const owner = openTelosOwnedDatabase('canonical', path, { fileMustExist: true });
    try {
      const columns = new Set(
        (owner.database.pragma('table_info(items)') as Array<{ name: string }>).map(
          (column) => column.name,
        ),
      );
      if (
        ![
          'id',
          'summary',
          'profile',
          'cluster_id',
          'urgency',
          'starred',
          'status',
          'snoozed_until',
          'context_hints',
          'first_seen',
          'last_seen',
          'created_at',
          'updated_at',
        ].every((column) => columns.has(column))
      )
        throw Error(
          'Existing Telos canonical schema required; inspect retained storage before startup',
        );
      owner.database.pragma('foreign_keys = ON');
      initializeTelosRuntimeSchema(owner.database);
      owner.seal();
    } finally {
      owner.close();
    }
  }
}
