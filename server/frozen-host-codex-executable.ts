import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
const unavailable = () => new Error('Host Codex runtime unavailable');
type Identity = { dev: number; ino: number; sha256: string };
function inspect(path: string, destination?: number): Identity {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path)
    throw unavailable();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.size > 256 * 1024 * 1024 ||
      before.mode & 0o022 ||
      !(before.mode & 0o111)
    )
      throw unavailable();
    const hash = createHash('sha256'),
      chunk = Buffer.alloc(64 * 1024);
    let length = 0;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, length);
      if (!count) break;
      if (!length) {
        // Native ELF/Mach-O only: script wrappers would execute mutable imports.
        const magic = chunk.subarray(0, 4).toString('hex');
        if (
          ![
            '7f454c46',
            'cffaedfe',
            'cefaedfe',
            'feedfacf',
            'feedface',
            'cafebabe',
            'bebafeca',
            'cafebabf',
            'bfbafeca',
          ].includes(magic)
        )
          throw unavailable();
      }
      length += count;
      if (length > before.size) throw unavailable();
      hash.update(chunk.subarray(0, count));
      if (destination !== undefined) {
        let offset = 0;
        while (offset < count) offset += writeSync(destination, chunk, offset, count - offset);
      }
    }
    const after = fstatSync(fd),
      leaf = lstatSync(path);
    if (
      !length ||
      length !== before.size ||
      before.dev !== leaf.dev ||
      before.ino !== leaf.ino ||
      !leaf.isFile() ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw unavailable();
    return { dev: before.dev, ino: before.ino, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}
/** Copies one explicitly selected native executable into the existing private
 * login home after durable bootstrap admission. This pins bytes and argv lookup;
 * it does not attest host OS, dependencies, accepted source or provider readiness.
 */
export class FrozenHostCodexExecutable {
  private constructor(
    readonly path: string,
    readonly sha256: string,
    private readonly source: string,
    private readonly sourceIdentity: Identity,
    private readonly ownedIdentity: Identity,
  ) {}
  static capture(source: string, privateHome: string): FrozenHostCodexExecutable {
    let fd: number | undefined;
    try {
      const home = lstatSync(privateHome);
      if (
        !isAbsolute(privateHome) ||
        realpathSync(privateHome) !== privateHome ||
        !home.isDirectory() ||
        home.uid !== process.getuid?.() ||
        home.mode & 0o077
      )
        throw unavailable();
      const path = join(privateHome, 'codex-runtime');
      fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o500,
      );
      const sourceIdentity = inspect(source, fd);
      closeSync(fd);
      fd = undefined;
      const ownedIdentity = inspect(path);
      if (sourceIdentity.sha256 !== ownedIdentity.sha256) throw unavailable();
      return new FrozenHostCodexExecutable(
        path,
        sourceIdentity.sha256,
        source,
        sourceIdentity,
        ownedIdentity,
      );
    } catch {
      throw unavailable();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  assertCurrent(): void {
    try {
      for (const [path, expected] of [
        [this.source, this.sourceIdentity],
        [this.path, this.ownedIdentity],
      ] as const) {
        const actual = inspect(path);
        if (
          actual.dev !== expected.dev ||
          actual.ino !== expected.ino ||
          actual.sha256 !== expected.sha256
        )
          throw unavailable();
      }
      if ((lstatSync(this.path).mode & 0o777) !== 0o500) throw unavailable();
    } catch {
      throw unavailable();
    }
  }
}
