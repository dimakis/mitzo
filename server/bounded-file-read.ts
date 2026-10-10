import { readSync } from 'node:fs';

/** Bound the allocation and read itself; an earlier fstat cannot bound a growing file. */
export function readBoundedFile(fd: number, limit: number): Buffer {
  const bytes = Buffer.alloc(limit + 1);
  let length = 0;
  while (length < bytes.length) {
    const read = readSync(fd, bytes, length, bytes.length - length, length);
    if (read === 0) break;
    length += read;
  }
  if (length > limit) throw new Error('Saved file is too large');
  return bytes.subarray(0, length);
}
