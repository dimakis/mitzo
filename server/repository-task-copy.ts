import { constants, type Stats } from 'node:fs';
import { cp, lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Best-effort block cloning with independent files and exclusive task ownership.
 * Callers verify the complete prepared-source digest before and after copying.
 * A failed copy is retained under its original claim for inspection.
 */
export async function copyRepositoryTaskCheckout(source: string, destination: string) {
  const parent = dirname(destination);
  const container = await lstat(parent);
  if (
    (await realpath(parent)) !== parent ||
    !container.isDirectory() ||
    (container.mode & 0o077) !== 0
  )
    throw new Error('Repository task copy requires a private canonical container');
  const sourceIdentity = await lstat(source);
  if ((await realpath(source)) !== source || !sourceIdentity.isDirectory())
    throw new Error('Prepared repository source identity changed');
  const occupied = await lstat(destination).then(
    () => true,
    (error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return false;
      throw error;
    },
  );
  if (occupied) throw new Error('Repository task destination already exists');
  let destinationIdentity: Stats | undefined;
  // EXCL also applies to directories on newer Node versions. Let cp create
  // the absent root, then pin it before it writes the first child entry.

  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    mode: constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
    filter: async (entrySource) => {
      if (entrySource === source) {
        if ((await realpath(source)) !== source)
          throw new Error('Repository task copy identity changed');
      } else if (!destinationIdentity) {
        destinationIdentity = await lstat(destination);
        if (!destinationIdentity.isDirectory() || (await realpath(destination)) !== destination)
          throw new Error('Repository task copy identity changed');
      }
      return true;
    },
  });
  const copiedSource = await lstat(source),
    copiedDestination = await lstat(destination);
  if (
    !destinationIdentity ||
    (await realpath(source)) !== source ||
    (await realpath(destination)) !== destination ||
    !copiedSource.isDirectory() ||
    !copiedDestination.isDirectory() ||
    copiedSource.dev !== sourceIdentity.dev ||
    copiedSource.ino !== sourceIdentity.ino ||
    copiedDestination.dev !== destinationIdentity.dev ||
    copiedDestination.ino !== destinationIdentity.ino
  )
    throw new Error('Repository task copy identity changed');
  const retained = await lstat(parent);
  if (
    (await realpath(parent)) !== parent ||
    retained.dev !== container.dev ||
    retained.ino !== container.ino
  )
    throw new Error('Repository task copy container changed');
}
