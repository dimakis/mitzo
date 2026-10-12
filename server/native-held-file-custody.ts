import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface OriginalImmutableFile {
  assertCurrent(): void;
  assertBytesCurrent(): void;
  close(): void;
}

/** File observations only. This object does not authorize a provider or model. */
export function captureOriginalImmutableFile(options: {
  path: string;
  sha256: string;
  maximumBytes: number;
  uid: number;
  assertCurrent(): unknown;
}): OriginalImmutableFile {
  const { path, sha256, maximumBytes, uid, assertCurrent: originalCustody } = options;
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 1024 ** 3 ||
    !Number.isSafeInteger(uid) ||
    uid < 0
  )
    throw new Error('invalid original file capture');
  const fail = () => {
    throw new Error('original native file custody lost');
  };
  const custody = () => {
    const result = originalCustody();
    if (result !== undefined && result !== true) fail();
  };
  const stat = (name: string) => lstatSync(name, { bigint: true });
  custody();
  if (realpathSync(path) !== path) fail();
  const parents: Array<{ path: string; original: BigIntStats }> = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const original = stat(parent);
    if (!original.isDirectory() || original.isSymbolicLink() || realpathSync(parent) !== parent)
      fail();
    if (!parents.length && (original.uid !== BigInt(uid) || (original.mode & 0o022n) !== 0n))
      fail();
    parents.push({ path: parent, original });
    if (dirname(parent) === parent) break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let closed = false,
    lost = false;
  let original: BigIntStats;
  try {
    original = fstatSync(fd, { bigint: true });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  const fields = [
    'dev',
    'ino',
    'uid',
    'gid',
    'mode',
    'nlink',
    'size',
    'mtimeNs',
    'ctimeNs',
  ] as const;
  const same = (actual: BigIntStats, expected: BigIntStats) =>
    fields.every((field) => actual[field] === expected[field]);
  const observe = () => {
    if (closed || lost) fail();
    custody();
    if (
      !original.isFile() ||
      original.uid !== BigInt(uid) ||
      original.nlink !== 1n ||
      (original.mode & 0o022n) !== 0n ||
      original.size < 1n ||
      original.size > BigInt(maximumBytes)
    )
      fail();
    if (!same(fstatSync(fd, { bigint: true }), original) || !same(stat(path), original)) fail();
    for (const parent of parents) {
      const actual = stat(parent.path),
        expected = parent.original;
      if (
        !actual.isDirectory() ||
        actual.dev !== expected.dev ||
        actual.ino !== expected.ino ||
        actual.uid !== expected.uid ||
        actual.gid !== expected.gid ||
        actual.mode !== expected.mode
      )
        fail();
    }
    custody();
  };
  const check = (bytes: boolean) => {
    try {
      observe();
      if (bytes) {
        const hash = createHash('sha256'),
          buffer = Buffer.allocUnsafe(64 * 1024);
        const size = Number(original.size);
        for (let position = 0; position < size;) {
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
          if (count < 1) fail();
          hash.update(buffer.subarray(0, count));
          position += count;
        }
        if (hash.digest('hex') !== sha256) fail();
        observe();
      }
    } catch (error) {
      lost = true;
      throw error;
    }
  };
  try {
    check(true);
  } catch (error) {
    closeSync(fd);
    closed = true;
    throw error;
  }
  const held: OriginalImmutableFile = Object.freeze({
    assertCurrent(this: OriginalImmutableFile) {
      if (this !== held) fail();
      check(false);
    },
    assertBytesCurrent(this: OriginalImmutableFile) {
      if (this !== held) fail();
      check(true);
    },
    close(this: OriginalImmutableFile) {
      if (this !== held) fail();
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
    },
  });
  return held;
}
