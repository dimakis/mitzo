import { lstat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

/**
 * Explicit index staging (`hash-object` + `update-index --cacheinfo`) skips the
 * nested-repository boundary that `git add` enforces. Return a refusal when any
 * directory between `file` and `root` (exclusive) holds a `.git` entry — a
 * directory or a gitlink file — so a nested clone's files never land in the
 * enclosing repository. The commit is refused, never retargeted: a nested clone
 * has no retained custody record.
 */
export async function nestedRepositoryRefusal(
  root: string,
  file: string,
): Promise<string | undefined> {
  for (
    let directory = dirname(file);
    directory !== root && directory.startsWith(root + '/');
    directory = dirname(directory)
  ) {
    const marker = await lstat(join(directory, '.git')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      return null;
    });
    if (marker)
      return `File belongs to nested repository ${relative(root, directory)}; commit there with native git`;
  }
  return undefined;
}
