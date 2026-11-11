import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  lstatSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { dirname } from 'node:path';

function privateFileStat(fd: number, limit = Infinity) {
  const stat = fstatSync(fd);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > limit
  )
    throw Error('Private bounded recovery evidence required');
  return stat;
}

/** Validate metadata without reading a potentially large SQLite database into memory. */
export function assertPrivateOperationFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    privateFileStat(fd);
  } finally {
    closeSync(fd);
  }
}

/** Descriptor-bound and bounded: recovery evidence is never followed through a link. */
export function readPrivateOperationFile(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = privateFileStat(fd, limit);
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

/** Exclusive, fsynced host publication. Uncertain outputs are never replaced. */
export function assertPrivateOperationDirectory(path: string): void {
  const parent = lstatSync(path);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700)
    throw Error('Private owned operation directory required');
}

/** Exclusive, fsynced host publication. Uncertain outputs are never replaced. */
export function publishPrivateOperationFile(path: string, bytes: string): void {
  assertPrivateOperationDirectory(dirname(path));
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
