import { lstat } from 'node:fs/promises';
import type { LocalRepositoryReadAnchor } from '../../local-repository-read-access.js';
import { NativeReadAnchorMissingError } from '../../native-file-operation.js';

/** Synthetic fixture owner only. Production must use its signed current owner;
 * the product reader has no filesystem-derived anchor fallback. */
export async function fixtureReadAnchor(path: string): Promise<LocalRepositoryReadAnchor> {
  const info = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new NativeReadAnchorMissingError();
    throw error;
  });
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Fixture read root unavailable');
  return Object.freeze({
    rootPath: path,
    identity: Object.freeze({ dev: String(info.dev), ino: String(info.ino) }),
  });
}

/** Explicit empty actual projection for synthetic offline owners only. */
export async function fixtureReadExclusions(): Promise<readonly string[]> {
  return Object.freeze([]);
}
