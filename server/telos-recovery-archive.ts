import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, lstatSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { basename } from 'node:path';

const archiveLimit = 64 * 1024 * 1024;

/** Descriptor-bound and bounded: recovery evidence is never followed through a link. */
function privateBytes(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > limit
    )
      throw Error('Private bounded recovery evidence required');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const final = fstatSync(fd);
    if (length !== stat.size || final.size !== stat.size || final.mtimeMs !== stat.mtimeMs)
      throw Error('Recovery evidence changed during read');
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/** A complete private migration receipt must bind every retained archive byte. */
export function verifyTelosRecoveryArchive(database: string, db: Database.Database): void {
  try {
    const markerExists = !!db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mitzo_telos_recovery_archive'",
      )
      .get();
    const marker = markerExists
      ? (db
          .prepare('SELECT schema_version,sha256 FROM mitzo_telos_recovery_archive')
          .all() as Array<{ schema_version: number; sha256: string }>)
      : [];
    const present = (path: string) => {
      try {
        lstatSync(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    };
    const archivePresent = present(database + '.recovery.json');
    if (!markerExists && !archivePresent && !present(database + '.migration.json')) return;
    const receipt = JSON.parse(
      privateBytes(database + '.migration.json', 1024 * 1024).toString('utf8'),
    );
    const proof = receipt.recoveryArchive;
    if (
      receipt.ok === true &&
      receipt.verified === true &&
      receipt.version === 1 &&
      !markerExists &&
      !proof &&
      !archivePresent
    )
      return;
    if (
      receipt.ok !== true ||
      receipt.verified !== true ||
      receipt.version !== 2 ||
      marker.length !== 1 ||
      marker[0].schema_version !== 1 ||
      marker[0].sha256 !== proof?.sha256 ||
      proof?.filename !== basename(database) + '.recovery.json' ||
      typeof proof.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(proof.sha256) ||
      !Number.isSafeInteger(proof.rows) ||
      proof.rows < 1 ||
      !proof.byTable ||
      typeof proof.byTable !== 'object' ||
      Array.isArray(proof.byTable) ||
      Object.entries(proof.byTable).some(
        ([table, count]) =>
          !['history', 'sources'].includes(table) ||
          !Number.isSafeInteger(count) ||
          Number(count) < 1,
      ) ||
      Object.values(proof.byTable).reduce<number>((total, count) => total + Number(count), 0) !==
        proof.rows
    )
      throw Error('Complete archive receipt required');
    const bytes = privateBytes(database + '.recovery.json', archiveLimit);
    if (createHash('sha256').update(bytes).digest('hex') !== proof.sha256)
      throw Error('Recovery archive fingerprint changed');
  } catch (cause) {
    throw new Error('Telos recovery archive requires a complete private migration receipt', {
      cause,
    });
  }
}
