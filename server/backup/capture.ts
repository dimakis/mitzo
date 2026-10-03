import type Database from 'better-sqlite3';
import SQLite from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { durableJson, safeDirectory, syncDirectory, syncSnapshotTree } from './files.js';

const storeId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const receipt = z.object({ watermark: z.string().min(1).max(256) }).strict();
export interface SnapshotAdapter {
  id: string;
  capture(destination: string): Promise<z.infer<typeof receipt>>;
}
export interface CaptureOptions {
  destination: string;
  required: string[];
  adapters: SnapshotAdapter[];
  /** Implemented by store owners: fences every writer participating in this consistency group. */
  withBarrier<T>(work: () => Promise<T>): Promise<T>;
}
export async function captureWorkspace(options: CaptureOptions): Promise<void> {
  const { destination, required, adapters } = options;
  const identifiers = adapters.map((adapter) => storeId.parse(adapter.id));
  required.forEach((value) => storeId.parse(value));
  if (
    !required.length ||
    new Set(required).size !== required.length ||
    new Set(identifiers).size !== identifiers.length ||
    required.some((value) => !identifiers.includes(value))
  )
    throw new Error('Incomplete backup coverage');
  await safeDirectory(dirname(destination));
  try {
    await lstat(destination);
    throw new Error('Capture destination already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const staging = destination + '.capture-' + randomUUID();
  await mkdir(staging, { mode: 0o700 });
  try {
    const stores = await options.withBarrier(async () => {
      const results = [];
      for (const adapter of adapters) {
        const path = join(staging, adapter.id);
        await mkdir(path, { mode: 0o700 });
        results.push({ id: adapter.id, ...receipt.parse(await adapter.capture(path)) });
      }
      await syncSnapshotTree(staging);
      // The coverage receipt is inside the encrypted Restic snapshot, never the cloud catalog.
      await durableJson(join(staging, 'coverage.json'), {
        version: 1,
        capturedAt: new Date().toISOString(),
        required,
        stores: results,
      });
      return results;
    });
    if (required.some((value) => !stores.some((store) => store.id === value)))
      throw new Error('Incomplete backup coverage');
    await mkdir(destination, { mode: 0o700 });
    await rename(staging, destination);
    await syncDirectory(dirname(destination));
  } catch {
    throw new Error('Workspace capture failed');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
/** Called with the store owner's connection while its consistency fence is held. */
export async function sqliteSnapshot(owner: Database.Database, destination: string): Promise<void> {
  await safeDirectory(dirname(destination));
  try {
    await lstat(destination);
    throw new Error('Snapshot destination already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await owner.backup(destination);
  const snapshot = new SQLite(destination, { readonly: true, fileMustExist: true });
  try {
    if (snapshot.pragma('integrity_check', { simple: true }) !== 'ok')
      throw new Error('SQLite snapshot integrity failure');
    if ((snapshot.pragma('foreign_key_check') as unknown[]).length !== 0)
      throw new Error('SQLite snapshot relationship failure');
  } finally {
    snapshot.close();
  }
}
