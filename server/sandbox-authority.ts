import { lstatSync, readFileSync, realpathSync, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type SerializedAuthority = Array<{
  path: string;
  stat?: { dev: string; ino: string; mode: string };
  digest?: string;
}>;

export function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonical(parent), path.slice(parent.length));
  }
}
export function validatePath(path: string): void {
  // SRT interprets globs. Policy roots must be literal, canonical absolute paths.
  if (
    !isAbsolute(path) ||
    path === '/' ||
    /[*?[\]{}]/.test(path) ||
    resolve(path) !== path ||
    canonical(path) !== path
  )
    throw new Error('Sandbox roots must be canonical absolute paths without patterns');
}
export function identity(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Bind grants to the filesystem objects authorized before asynchronous setup.
 * Ancestors cover absent paths and directory replacement; Git authority also
 * fingerprints content so in-place rewrites cannot change the granted branch.
 */
export class AuthoritySnapshot {
  private paths = new Map<
    string,
    { stat?: { dev: string; ino: string; mode: string }; digest?: string }
  >();
  serialize(): SerializedAuthority {
    return [...this.paths].map(([path, value]) => ({ path, ...value }));
  }
  static restore(entries: SerializedAuthority): AuthoritySnapshot {
    const snapshot = new AuthoritySnapshot();
    for (const { path, ...value } of entries) snapshot.paths.set(path, value);
    return snapshot;
  }
  capture(path: string, contents = false): void {
    if (!this.paths.has(path)) {
      const stat = identity(path);
      const digest =
        contents && stat?.isFile()
          ? createHash('sha256').update(readFileSync(path)).digest('hex')
          : undefined;
      this.paths.set(path, {
        stat: stat
          ? { dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode) }
          : undefined,
        digest,
      });
    }
    const parent = dirname(path);
    if (parent !== path) this.capture(parent);
  }
  verify(): void {
    for (const [path, expected] of this.paths) {
      const actual = identity(path);
      if (
        canonical(path) !== path ||
        actual?.dev.toString() !== expected.stat?.dev ||
        actual?.ino.toString() !== expected.stat?.ino ||
        actual?.mode.toString() !== expected.stat?.mode ||
        (expected.digest !== undefined &&
          createHash('sha256').update(readFileSync(path)).digest('hex') !== expected.digest)
      ) {
        throw new Error(`Sandbox authority changed before execution: ${path}`);
      }
    }
  }
}
