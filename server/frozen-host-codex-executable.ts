import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
  unlinkSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  HostCodexCompanionUpgradePlanSchema,
  type HostCodexCompanionUpgradePlan,
  HostCodexExecutableCustodySchema,
  type HostCodexExecutableCustody,
} from './host-codex-custody.js';
const unavailable = () => new Error('Host Codex runtime unavailable');
const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'mode', 'nlink'] as const;
type Metadata = Pick<BigIntStats, (typeof fields)[number]>;
type Identity = Metadata & { sha256: string };
type DirectoryIdentity = Pick<BigIntStats, 'dev' | 'ino' | 'uid' | 'mode'>;
function canonical(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path)
    throw unavailable();
}
function directory(path: string): DirectoryIdentity {
  canonical(path);
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory()) throw unavailable();
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode };
}
function sameDirectory(path: string, expected: DirectoryIdentity): void {
  const actual = directory(path);
  for (const key of ['dev', 'ino', 'uid', 'mode'] as const)
    if (actual[key] !== expected[key]) throw unavailable();
}
function metadata(path: string): Metadata {
  canonical(path);
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.size > 256n * 1024n * 1024n ||
    stat.mode & 0o022n ||
    !(stat.mode & 0o111n)
  )
    throw unavailable();
  return Object.fromEntries(fields.map((key) => [key, stat[key]])) as Metadata;
}
function sameMetadata(actual: Metadata, expected: Metadata): void {
  for (const key of fields) if (actual[key] !== expected[key]) throw unavailable();
}
function inspect(path: string, destination?: number): Identity {
  const before = metadata(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    sameMetadata(fstatSync(fd, { bigint: true }), before);
    const hash = createHash('sha256'),
      chunk = Buffer.alloc(64 * 1024);
    let length = 0;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, length);
      if (!count) break;
      if (!length) {
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
      if (BigInt(length) > before.size) throw unavailable();
      hash.update(chunk.subarray(0, count));
      if (destination !== undefined) {
        let offset = 0;
        while (offset < count) offset += writeSync(destination, chunk, offset, count - offset);
      }
    }
    if (!length || BigInt(length) !== before.size) throw unavailable();
    sameMetadata(fstatSync(fd, { bigint: true }), before);
    sameMetadata(metadata(path), before);
    return { ...before, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}
/** Bounded read-only native byte measurement for the independent server runtime
 * observer. No process, copying or credential access. Explicit new adoption must
 * measure newly accepted bytes; the returned retained metadata fence is cheap.
 */
export function measureHostCodexExecutable(source: string): {
  sha256: string;
  assertCurrent(): void;
} {
  try {
    const parent = directory(dirname(source)),
      selected = inspect(source);
    return {
      sha256: selected.sha256,
      assertCurrent: () => {
        try {
          sameDirectory(dirname(source), parent);
          sameMetadata(metadata(source), selected);
        } catch {
          throw unavailable();
        }
      },
    };
  } catch {
    throw unavailable();
  }
}
/** Pins native bytes in the private owned login home. Streamed/effect boundaries
 * use inode, nanosecond ctime/mtime, owner, links and permissions. Full hashing is
 * reserved for capture and explicit launch, never each token. This does not attest
 * OS/dependencies or defend a privileged same-UID final kernel launch mutation.
 */
export class FrozenHostCodexExecutable {
  private constructor(
    readonly path: string,
    readonly sha256: string,
    private readonly source: string,
    private readonly sourceIdentity: Identity,
    private readonly ownedIdentity: Identity,
    private readonly sourceDirectory: DirectoryIdentity,
    private readonly ownedDirectory: DirectoryIdentity,
    private codeModeHost?: FrozenHostCodexExecutable,
  ) {}
  static capture(source: string, privateHome: string): FrozenHostCodexExecutable {
    const executable = this.captureFile(source, privateHome, 'codex-runtime');
    const companion = join(dirname(source), 'codex-code-mode-host');
    if (lstatSync(companion, { throwIfNoEntry: false }))
      executable.codeModeHost = this.captureFile(companion, privateHome, 'codex-code-mode-host');
    return executable;
  }
  private static captureFile(
    source: string,
    privateHome: string,
    name: string,
  ): FrozenHostCodexExecutable {
    let fd: number | undefined;
    try {
      const home = directory(privateHome),
        parent = directory(dirname(source));
      if (home.uid !== BigInt(process.getuid!()) || home.mode & 0o077n) throw unavailable();
      // Reject untracked hardlink aliases before creating any owned artifact.
      metadata(source);
      const path = join(privateHome, name);
      fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o500,
      );
      const sourceIdentity = inspect(source, fd);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      const ownedIdentity = inspect(path);
      if (sourceIdentity.sha256 !== ownedIdentity.sha256 || ownedIdentity.nlink !== 1n)
        throw unavailable();
      const homeFd = openSync(
        privateHome,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(homeFd);
      } finally {
        closeSync(homeFd);
      }
      return new FrozenHostCodexExecutable(
        path,
        sourceIdentity.sha256,
        source,
        sourceIdentity,
        ownedIdentity,
        parent,
        home,
      );
    } catch {
      throw unavailable();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  static reopen(raw: unknown): FrozenHostCodexExecutable {
    return this.reopenFile(raw, 'codex-runtime');
  }
  private static reopenFile(raw: unknown, name: string): FrozenHostCodexExecutable {
    try {
      const snapshot = HostCodexExecutableCustodySchema.parse(raw);
      const decode = <T>(value: Record<string, string>): T =>
        Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            key === 'sha256' ? entry : BigInt(entry),
          ]),
        ) as T;
      if (
        snapshot.path !== join(dirname(snapshot.path), name) ||
        snapshot.sourceIdentity.sha256 !== snapshot.sha256 ||
        snapshot.ownedIdentity.sha256 !== snapshot.sha256
      )
        throw unavailable();
      const executable = new FrozenHostCodexExecutable(
        snapshot.path,
        snapshot.sha256,
        snapshot.source,
        decode<Identity>(snapshot.sourceIdentity),
        decode<Identity>(snapshot.ownedIdentity),
        decode<DirectoryIdentity>(snapshot.sourceDirectory),
        decode<DirectoryIdentity>(snapshot.ownedDirectory),
      );
      if (snapshot.codeModeHost) {
        if (
          name !== 'codex-runtime' ||
          snapshot.codeModeHost.source !== join(dirname(snapshot.source), 'codex-code-mode-host') ||
          snapshot.codeModeHost.path !== join(dirname(snapshot.path), 'codex-code-mode-host')
        )
          throw unavailable();
        executable.codeModeHost = this.reopenFile(snapshot.codeModeHost, 'codex-code-mode-host');
      }
      executable.assertLaunchCurrent();
      return executable;
    } catch {
      throw unavailable();
    }
  }
  /** Explicit cold bootstrap only, after original custody and command admission.
   * Existing unexplained files are never adopted or overwritten.
   */
  companionUpgradePlan(): HostCodexCompanionUpgradePlan | undefined {
    this.assertLaunchCurrent();
    if (this.codeModeHost) return;
    const source = join(dirname(this.source), 'codex-code-mode-host');
    if (!lstatSync(source, { throwIfNoEntry: false })) return;
    const selected = inspect(source);
    const encode = (value: Identity | DirectoryIdentity) =>
      Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
    return HostCodexCompanionUpgradePlanSchema.parse({
      path: join(dirname(this.path), 'codex-code-mode-host'),
      source,
      sha256: selected.sha256,
      sourceIdentity: encode(selected),
      sourceDirectory: encode(directory(dirname(source))),
      ownedDirectory: encode(directory(dirname(this.path))),
    });
  }
  completeRuntimeBundle(ownedUpgrade?: HostCodexCompanionUpgradePlan): void {
    const plan = this.companionUpgradePlan();
    if (!plan) return;
    if (ownedUpgrade) {
      if (!isDeepStrictEqual(HostCodexCompanionUpgradePlanSchema.parse(ownedUpgrade), plan))
        throw unavailable();
      if (lstatSync(plan.path, { throwIfNoEntry: false })) {
        // Only a durably recorded upgrade may retire its exact interrupted
        // copy. Unexplained destinations still take the exclusive-create path.
        const partial = metadata(plan.path);
        if (partial.uid !== BigInt(process.getuid!()) || (partial.mode & 0o777n) !== 0o500n)
          throw unavailable();
        sameDirectory(dirname(plan.path), this.ownedDirectory);
        sameMetadata(metadata(plan.path), partial);
        unlinkSync(plan.path);
      }
    }
    this.codeModeHost = FrozenHostCodexExecutable.captureFile(
      plan.source,
      dirname(this.path),
      'codex-code-mode-host',
    );
    this.assertLaunchCurrent();
  }
  custodySnapshot(): HostCodexExecutableCustody {
    this.assertCurrent();
    const encode = (value: Identity | DirectoryIdentity) =>
      Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
    return HostCodexExecutableCustodySchema.parse({
      path: this.path,
      source: this.source,
      sha256: this.sha256,
      sourceIdentity: encode(this.sourceIdentity),
      ownedIdentity: encode(this.ownedIdentity),
      sourceDirectory: encode(this.sourceDirectory),
      ownedDirectory: encode(this.ownedDirectory),
      ...(this.codeModeHost ? { codeModeHost: this.codeModeHost.custodySnapshot() } : {}),
    });
  }
  assertCurrent(): void {
    try {
      sameDirectory(dirname(this.source), this.sourceDirectory);
      sameDirectory(dirname(this.path), this.ownedDirectory);
      sameMetadata(metadata(this.source), this.sourceIdentity);
      sameMetadata(metadata(this.path), this.ownedIdentity);
      if ((this.ownedIdentity.mode & 0o777n) !== 0o500n) throw unavailable();
      this.codeModeHost?.assertCurrent();
    } catch {
      throw unavailable();
    }
  }
  assertLaunchCurrent(): void {
    try {
      this.assertCurrent();
      if (inspect(this.source).sha256 !== this.sha256 || inspect(this.path).sha256 !== this.sha256)
        throw unavailable();
      this.codeModeHost?.assertLaunchCurrent();
      this.assertCurrent();
    } catch {
      throw unavailable();
    }
  }
}
