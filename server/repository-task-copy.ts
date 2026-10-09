import { constants } from 'node:fs';
import { cp, lstat, mkdir, realpath } from 'node:fs/promises';
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
  // mkdir is exclusive even for an existing empty directory or symlink.
  await mkdir(destination, { mode: 0o700 });
  const destinationIdentity = await lstat(destination);
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    mode: constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
  });
  const copiedSource = await lstat(source),
    copiedDestination = await lstat(destination);
  if (
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
