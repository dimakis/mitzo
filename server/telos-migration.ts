import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { openTelosOwnedDatabase } from '@mitzo/protocol/telos-sqlite-owners';

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
function inventory(db: Database.Database) {
  const hash = createHash('sha256');
  const rowDigest = (row: Record<string, unknown>) => {
    hash.update('row:');
    for (const value of Object.values(row)) {
      if (Buffer.isBuffer(value)) {
        hash.update(`blob:${value.byteLength}:`);
        hash.update(value);
      } else {
        const text = String(value);
        hash.update(`${typeof value}:${Buffer.byteLength(text)}:`);
        hash.update(text);
      }
    }
  };
  const schema = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all() as { type: string; name: string; sql: string }[];
  hash.update(JSON.stringify(schema));
  const withoutRowid = new Set(
    (db.pragma('table_list') as { schema: string; name: string; wr: number }[])
      .filter((table) => table.schema === 'main' && table.wr === 1)
      .map((table) => table.name),
  );
  const counts: Record<string, number> = {};
  for (const table of schema.filter((row) => row.type === 'table')) {
    // Backup preserves row identities. Scan their existing order; sorting every
    // artifact BLOB would needlessly copy large values into a temporary sort.
    const order = withoutRowid.has(table.name)
      ? (
          db.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as {
            name: string;
            pk: number;
          }[]
        )
          .filter((column) => column.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((column) => quote(column.name))
          .join(',')
      : 'rowid';
    let count = 0;
    for (const row of db
      .prepare(`SELECT * FROM ${quote(table.name)} ORDER BY ${order}`)
      .safeIntegers()
      .iterate()) {
      rowDigest(row as Record<string, unknown>);
      count++;
    }
    counts[table.name] = count;
  }
  // AUTOINCREMENT history must survive too, even after the highest row was removed.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get())
    for (const row of db
      .prepare('SELECT * FROM sqlite_sequence ORDER BY name')
      .safeIntegers()
      .iterate())
      rowDigest(row as Record<string, unknown>);
  return { sha256: hash.digest('hex'), counts };
}
/** Consistent whole-database backup, including WAL, artifacts and all extension
 * tables. The service and legacy writers must be stopped for final cutover;
 * this utility copies data and never changes a running service's selection. */
export async function migrateTelosDatabase(source: string, destination: string) {
  const from = resolve(source),
    to = resolve(destination);
  if (from === to || existsSync(to)) throw Error('Telos migration destination already exists');
  if (!existsSync(from)) throw Error('Telos migration source does not exist');
  if (
    [from, to].some((path) =>
      lstatSync(join(dirname(path), '.telos-file-owners'), { throwIfNoEntry: false }),
    )
  )
    throw Error('Retained Telos file family cannot be relocated; keep its canonical path');
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  const temporary = to + '.pending-' + randomUUID();
  const owner = openTelosOwnedDatabase('canonical', from, { readonly: true, fileMustExist: true });
  const db = owner.database;
  let target: Database.Database | undefined;
  let ownsTemporary = false;
  try {
    db.pragma('busy_timeout = 5000');
    owner.seal();
    db.exec('BEGIN');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='items'").get())
      throw Error('Source is not a Telos database');
    const before = inventory(db);
    const descriptor = openSync(temporary, 'wx', 0o600);
    ownsTemporary = true;
    closeSync(descriptor);
    await db.backup(temporary);
    target = new Database(temporary, { readonly: true, fileMustExist: true });
    if (target.pragma('integrity_check', { simple: true }) !== 'ok')
      throw Error('Telos migration integrity check failed');
    const after = inventory(target);
    if (before.sha256 !== after.sha256) throw Error('Telos migration content verification failed');
    target.close();
    target = undefined;
    db.exec('ROLLBACK');
    // Atomic publication without overwrite, including a concurrent destination creator.
    linkSync(temporary, to);
    unlinkSync(temporary);
    return { verified: true as const, source: from, destination: to, ...after };
  } finally {
    target?.close();
    if (db.inTransaction) db.exec('ROLLBACK');
    owner.close();
    if (ownsTemporary && existsSync(temporary)) unlinkSync(temporary);
  }
}
