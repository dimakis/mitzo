import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { readPrivateOperationFile } from './private-operation-file.js';
import type Database from 'better-sqlite3';
import { basename } from 'node:path';

const archiveLimit = 64 * 1024 * 1024;

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
      readPrivateOperationFile(database + '.migration.json', 1024 * 1024).toString('utf8'),
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
    const bytes = readPrivateOperationFile(database + '.recovery.json', archiveLimit);
    if (createHash('sha256').update(bytes).digest('hex') !== proof.sha256)
      throw Error('Recovery archive fingerprint changed');
  } catch (cause) {
    throw new Error('Telos recovery archive requires a complete private migration receipt', {
      cause,
    });
  }
}
