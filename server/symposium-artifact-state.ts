import { closeSync, lstatSync, openSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Stable owned-host lease ledger. Never silently abandon a pre-upgrade launch ledger.
 * Legacy state may contain unknown creates or pending retention; copying its rows into
 * new gateway custody would invent authority. Reconciliation is deliberately separate.
 */
export function stableSymposiumArtifactLeasePath(stateParent: string): string {
  if (!isAbsolute(stateParent)) throw new Error('Artifact state parent must be absolute');
  const parent = lstatSync(stateParent);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    parent.mode & 0o077
  )
    throw new Error('Artifact state parent must be an owned private directory');
  for (const entry of readdirSync(stateParent)) {
    if (!entry.startsWith('gateway-')) continue;
    const directory = join(stateParent, entry);
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077
    )
      throw new Error('Legacy artifact custody requires reconciliation');
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        lstatSync(join(directory, `artifact-leases.db${suffix}`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      throw new Error(
        'Legacy artifact lease state requires reconciliation before a new host launch',
      );
    }
  }
  const path = join(stateParent, 'artifact-leases.db');
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const stat = lstatSync(`${path}${suffix}`);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077
      )
        throw new Error('Artifact lease ledger must remain an owned private regular file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Create privately before SQLite creates matching WAL/SHM sidecars.
    closeSync(openSync(path, 'wx', 0o600));
  }
  return path;
}
