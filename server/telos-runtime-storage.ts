import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  openTelosOwnedDatabase,
  selectedTelosDatabaseFiles,
} from '@mitzo/protocol/telos-sqlite-owners';
import { initializeTelosRuntimeSchema, TelosRuntimeStore } from './telos-runtime-store.js';

/** Bootstrap only, before accepting requests. Never chooses the legacy store as
 * fallback, copies live data, retires another writer or creates an empty substitute. */
export function ensureTelosRuntimeStorage(legacyRepo: string) {
  const path = selectedTelosDatabaseFiles().canonical;
  if (!existsSync(path)) {
    const legacy = join(legacyRepo, 'command_center/data/smart_todo.db');
    if (existsSync(legacy)) throw Error('Telos offline migration required before startup');
    if (existsSync(join(dirname(path), '.telos-file-owners')))
      throw Error('Retained Telos family cannot be replaced with empty storage');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const parent = lstatSync(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o777) !== 0o700
    )
      throw Error('Private owned Telos runtime directory required');
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
      owner.database.pragma('foreign_keys = ON');
      owner.database.transaction(() => initializeTelosRuntimeSchema(owner.database)).immediate();
      owner.seal();
    } finally {
      owner.close();
    }
  }
}
