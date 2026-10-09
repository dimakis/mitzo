import { constants } from 'node:fs';
import { cp, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Best-effort block cloning with independent files and exclusive task ownership.
 * Callers verify the complete prepared-source digest before and after copying.
 * A failed copy is retained under its original claim for inspection.
 */
export async function copyRepositoryTaskCheckout(
  source: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
) {
  const parent = dirname(destination);
  const container = await lstat(parent);
  if (
    (await realpath(parent)) !== parent ||
    !container.isDirectory() ||
    (container.mode & 0o077) !== 0
  )
    throw new Error('Repository task copy requires a private canonical container');
  if ((await realpath(source)) !== source || !(await lstat(source)).isDirectory())
    throw new Error('Prepared repository source identity changed');
  // mkdir is exclusive even for an existing empty directory or symlink.
  await mkdir(destination, { mode: 0o700 });
  if (platform === 'darwin') {
    // Node's reflink flag can be unavailable on macOS even when clonefile works.
    // The system copy tool clones blocks when supported and otherwise copies.
    await promisify(execFile)('/bin/cp', ['-cRpPn', `${source}/.`, destination], {
      env: { PATH: '/usr/bin:/bin' },
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
  } else {
    await cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      mode: constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
    });
  }
  const retained = await lstat(parent);
  if (
    (await realpath(parent)) !== parent ||
    retained.dev !== container.dev ||
    retained.ino !== container.ino
  )
    throw new Error('Repository task copy container changed');
}
