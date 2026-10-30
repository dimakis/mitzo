import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
  unlinkSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { observeLocalCodexSyncPhase } from './local-codex-observation.js';
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
type SharedPlacement = NonNullable<HostCodexExecutableCustody['sharedPlacement']>;
// Process-owned code evidence only. Never adopt directories by scanning disk,
// and never delete files referenced by durable conversation custody on close.
const reusableBundles = new Map<string, HostCodexExecutableCustody>();
function freezeCustody(value: HostCodexExecutableCustody): HostCodexExecutableCustody {
  const freeze = (object: object): void => {
    Object.values(object).forEach((entry: unknown) => {
      if (entry && typeof entry === 'object') freeze(entry);
    });
    Object.freeze(object);
  };
  freeze(value);
  return value;
}
const encode = (value: Identity | DirectoryIdentity) =>
  Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
const decodeDirectory = (value: SharedPlacement['rootIdentity']): DirectoryIdentity =>
  Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, BigInt(entry)]),
  ) as DirectoryIdentity;
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
function assertPlacement(path: string, shared?: SharedPlacement, privateHome?: string): void {
  if (privateHome) {
    const home = directory(privateHome);
    if (home.uid !== BigInt(process.getuid!()) || home.mode & 0o077n) throw unavailable();
  }
  if (shared) {
    const root = decodeDirectory(shared.rootIdentity);
    if (
      root.uid !== BigInt(process.getuid!()) ||
      root.mode & 0o077n ||
      dirname(dirname(path)) !== shared.privateRoot ||
      !/^host-runtime-[A-Za-z0-9]{6}$/.test(basename(dirname(path))) ||
      (privateHome &&
        (dirname(privateHome) !== shared.privateRoot || privateHome === dirname(path)))
    )
      throw unavailable();
    sameDirectory(shared.privateRoot, root);
  } else if (privateHome && dirname(path) !== privateHome) throw unavailable();
  if (path !== join(dirname(path), 'codex-runtime')) throw unavailable();
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
    // Every measurement still streams and hashes fresh bytes. A bounded larger
    // chunk reduces synchronous read/write calls for real native artifacts,
    // without retaining byte evidence across qualifications or enlarging the
    // 256 MiB file bound. Tiny fixtures allocate only their own byte length.
    const hash = createHash('sha256'),
      chunk = Buffer.allocUnsafe(Math.min(Number(before.size), 1024 * 1024));
    let length = 0;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, length);
      if (!count) break;
      if (!length) {
        if (count < 4) throw unavailable();
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
/** Pins native bytes in a private owned code directory. Streamed/effect boundaries
 * use inode, nanosecond ctime/mtime, owner, links and permissions. Full hashing is
 * reserved for capture and explicit launch, never each token. This does not attest
 * OS/dependencies or defend a privileged same-UID final kernel launch mutation.
 */
export class FrozenHostCodexExecutable {
  private sharedPlacement?: SharedPlacement;
  private loginHome?: { path: string; identity: DirectoryIdentity };
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
    return observeLocalCodexSyncPhase('native_capture', () => {
      const executable = this.captureFile(source, privateHome, 'codex-runtime');
      const companion = join(dirname(source), 'codex-code-mode-host');
      if (lstatSync(companion, { throwIfNoEntry: false }))
        executable.codeModeHost = this.captureFile(companion, privateHome, 'codex-code-mode-host');
      return executable;
    });
  }
  /** New conversation adoption only. A complete private code bundle may be reused
   * across independent login homes. Retained conversations must reopen their exact
   * recorded custody instead; this method never repairs or rebinds their files.
   */
  static captureReusable(source: string, privateRoot: string): FrozenHostCodexExecutable {
    try {
      const root = directory(privateRoot);
      if (root.uid !== BigInt(process.getuid!()) || root.mode & 0o077n) throw unavailable();
      const companion = join(dirname(source), 'codex-code-mode-host');
      const key = JSON.stringify(
        [
          privateRoot,
          root,
          source,
          directory(dirname(source)),
          metadata(source),
          lstatSync(companion, { throwIfNoEntry: false }) ? metadata(companion) : null,
        ],
        (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
      );
      const retained = reusableBundles.get(key);
      if (retained) {
        try {
          return this.reopen(retained);
        } catch {
          // Only new adoption can allocate another bundle. Preserve invalid old
          // files and every durable snapshot, which continue to fail closed.
          reusableBundles.delete(key);
        }
      }
      const bundle = mkdtempSync(join(privateRoot, 'host-runtime-'));
      const executable = this.capture(source, bundle);
      executable.sharedPlacement = {
        kind: 'shared-runtime-v1',
        privateRoot,
        rootIdentity: {
          dev: String(root.dev),
          ino: String(root.ino),
          uid: String(root.uid),
          mode: String(root.mode),
        },
      };
      executable.assertCurrent();
      // Capture and publication have no asynchronous boundary. Independent Node
      // processes use unique directories; neither overwrites another's custody.
      reusableBundles.set(key, freezeCustody(executable.custodySnapshot()));
      return executable;
    } catch {
      throw unavailable();
    }
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
  static assertCustodyForLoginHome(raw: unknown, privateHome: string): void {
    try {
      const snapshot = HostCodexExecutableCustodySchema.parse(raw);
      assertPlacement(snapshot.path, snapshot.sharedPlacement, privateHome);
    } catch {
      throw unavailable();
    }
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
      if (snapshot.sharedPlacement) {
        if (name !== 'codex-runtime') throw unavailable();
        executable.sharedPlacement = snapshot.sharedPlacement;
      }
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
    if (this.sharedPlacement) throw unavailable();
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
    return HostCodexExecutableCustodySchema.parse({
      path: this.path,
      source: this.source,
      sha256: this.sha256,
      sourceIdentity: encode(this.sourceIdentity),
      ownedIdentity: encode(this.ownedIdentity),
      sourceDirectory: encode(this.sourceDirectory),
      ownedDirectory: encode(this.ownedDirectory),
      ...(this.codeModeHost ? { codeModeHost: this.codeModeHost.custodySnapshot() } : {}),
      ...(this.sharedPlacement ? { sharedPlacement: this.sharedPlacement } : {}),
    });
  }
  /** Explicit replacement for the legacy executable-inside-login-home fence.
   * Shared code must belong to the exact same private root as this login home;
   * private root and bundle directory identities remain part of every fence.
   */
  assertForLoginHome(privateHome: string): void {
    try {
      assertPlacement(this.path, this.sharedPlacement, privateHome);
      if (this.loginHome && this.loginHome.path !== privateHome) throw unavailable();
      this.loginHome ??= { path: privateHome, identity: directory(privateHome) };
      this.assertCurrent();
    } catch {
      throw unavailable();
    }
  }
  assertCurrent(): void {
    try {
      if (this.loginHome) sameDirectory(this.loginHome.path, this.loginHome.identity);
      if (this.sharedPlacement) {
        assertPlacement(this.path, this.sharedPlacement);
        if (
          !!lstatSync(join(dirname(this.source), 'codex-code-mode-host'), {
            throwIfNoEntry: false,
          }) !== !!this.codeModeHost
        )
          throw unavailable();
      }
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
    observeLocalCodexSyncPhase('native_launch_integrity', () => {
      try {
        this.assertCurrent();
        if (
          inspect(this.source).sha256 !== this.sha256 ||
          inspect(this.path).sha256 !== this.sha256
        )
          throw unavailable();
        this.codeModeHost?.assertLaunchCurrent();
        this.assertCurrent();
      } catch {
        throw unavailable();
      }
    });
  }
}
