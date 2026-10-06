import type { SQLiteBackupOwner } from '@mitzo/protocol/database-backup';
import SQLite from 'better-sqlite3';
import { join } from 'node:path';
import { captureWorkspace } from './capture.js';

export interface MitzoTelosCoreOwners {
  events: SQLiteBackupOwner;
  tasks: SQLiteBackupOwner;
  telos: SQLiteBackupOwner;
}
const active = new WeakSet<SQLiteBackupOwner>();
/** This group's coverage is events, tasks/workload and the entire Telos database,
 * including registered artifact bytes. It never claims whole-ecosystem coverage.
 * Application saves continue; any overlapping write invalidates the candidate.
 */
export async function captureMitzoTelosCore(options: {
  owners: MitzoTelosCoreOwners;
  destination: string;
}): Promise<void> {
  const members = [
    ['mitzo-events', options.owners.events],
    ['mitzo-tasks', options.owners.tasks],
    ['telos', options.owners.telos],
  ] as const;
  for (const [, owner] of members) {
    if (
      !owner ||
      typeof owner.backupWatermark !== 'function' ||
      typeof owner.backupSnapshot !== 'function' ||
      active.has(owner)
    )
      throw Error('Backup owner unavailable');
  }
  if (new Set(members.map(([, owner]) => owner)).size !== members.length)
    throw Error('Backup owners must be distinct');
  // Read all starting versions without yielding, before any source capture starts.
  const start = members.map(([, owner]) => owner.backupWatermark());
  members.forEach(([, owner]) => active.add(owner));
  try {
    await captureWorkspace({
      destination: options.destination,
      required: members.map(([id]) => id),
      withBarrier: async (work) => {
        const result = await work();
        if (members.some(([, owner], index) => owner.backupWatermark() !== start[index]))
          throw Error('Backup stores changed during capture');
        return result;
      },
      adapters: members.map(([id, owner], index) => ({
        id,
        async capture(destination) {
          const file = join(destination, 'store.db');
          await owner.backupSnapshot(file);
          const db = new SQLite(file, { readonly: true, fileMustExist: true });
          try {
            if (
              db.pragma('integrity_check', { simple: true }) !== 'ok' ||
              (db.pragma('foreign_key_check') as unknown[]).length
            )
              throw Error('Backup snapshot validation failed');
          } finally {
            db.close();
          }
          return { watermark: start[index] };
        },
      })),
    });
  } finally {
    members.forEach(([, owner]) => active.delete(owner));
  }
}
