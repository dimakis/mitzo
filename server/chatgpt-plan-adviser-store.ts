import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { readBoundedFile } from './bounded-file-read.js';
import { protectCodexProfileRoots } from './codex-private-path.js';
import {
  PlanAdviserStateSchema,
  type PlanAdviserState,
  type PlanAdviserStore,
} from './chatgpt-plan-adviser.js';

const retainedOwner = z
  .object({
    version: z.literal(2),
    pid: z.number().int().positive(),
    claim: z.string().uuid(),
    fence: z
      .object({ device: z.number().int().nonnegative(), inode: z.number().int().positive() })
      .strict(),
  })
  .strict();

/** The kernel fence owns the writer for its entire lifetime, including recovery.
 * Process death/reboot releases it; uncertain or legacy evidence stays retained. */
export class FilePlanAdviserStore implements PlanAdviserStore {
  private owner: number | undefined;
  private rootFd: number;
  private readonly path: string;
  private readonly lock: string;
  private readonly fencePath: string;
  private fenceIdentity: { dev: number; ino: number } | undefined;
  private fence: Database.Database | undefined;
  constructor(private root: string) {
    if (!isAbsolute(root) || realpathSync(root) !== resolve(root))
      throw Error('Canonical private adviser directory required');
    this.rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    this.path = join(root, 'accounts.json');
    this.lock = join(root, 'owner.lock');
    this.fencePath = join(root, 'owner.fence.db');
    try {
      this.checkRoot();
      protectCodexProfileRoots([root]);
      // Only SQLite may open an existing fence: closing an extra raw descriptor
      // would release this process's POSIX locks held by another connection.
      try {
        closeSync(
          openSync(
            this.fencePath,
            constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      this.fenceIdentity = this.checkFencePath();
      this.fence = new Database(this.fencePath, { timeout: 0 });
      // Never commit this transaction while the store is usable. SQLite's OS
      // locks serialize competing starters and release on crash or reboot.
      this.fence.exec('BEGIN IMMEDIATE');
      const fence = this.checkFence();
      this.owner = this.claimOwner();
      writeFileSync(
        this.owner,
        JSON.stringify({
          version: 2,
          pid: process.pid,
          claim: randomUUID(),
          fence: { device: fence.dev, inode: fence.ino },
        }),
      );
      fsyncSync(this.owner);
      fsyncSync(this.rootFd);
      // Fail on existing unsafe credentials before returning a usable writer.
      this.load();
    } catch {
      this.close();
      throw Error('Private adviser storage unavailable; check ownership and retained lock');
    }
  }
  private checkPrivateFile(fd: number, path: string) {
    const owned = fstatSync(fd),
      current = lstatSync(path);
    if (
      !owned.isFile() ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      owned.nlink !== 1 ||
      current.nlink !== 1 ||
      owned.uid !== process.getuid?.() ||
      owned.mode & 0o077 ||
      owned.ino !== current.ino ||
      owned.dev !== current.dev
    )
      throw Error('Private adviser file ownership changed');
    return owned;
  }
  private checkFence() {
    this.checkRoot();
    if (!this.fenceIdentity || !this.fence?.inTransaction)
      throw Error('Adviser writer fence is closed');
    return this.checkFencePath();
  }
  private checkFencePath() {
    const current = lstatSync(this.fencePath);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.uid !== process.getuid?.() ||
      current.mode & 0o077 ||
      (this.fenceIdentity &&
        (this.fenceIdentity.dev !== current.dev || this.fenceIdentity.ino !== current.ino))
    )
      throw Error('Private adviser fence changed');
    return { dev: current.dev, ino: current.ino };
  }
  private claimOwner(): number {
    const create = () =>
      openSync(
        this.lock,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    try {
      return create();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const fd = openSync(this.lock, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        this.checkPrivateFile(fd, this.lock);
        const previous = retainedOwner.parse(
          JSON.parse(readBoundedFile(fd, 4096).toString('utf8')),
        );
        const fence = this.checkFence();
        // A replacement/missing fence cannot prove the former writer released
        // ownership. Legacy PID-only markers likewise need host investigation.
        if (previous.fence.device !== fence.dev || previous.fence.inode !== fence.ino)
          throw Error('Retained adviser fence identity changed', { cause: error });
        this.checkPrivateFile(fd, this.lock);
        renameSync(this.lock, this.lock + '.retained-' + randomUUID());
        fsyncSync(this.rootFd);
      } finally {
        closeSync(fd);
      }
      return create();
    }
  }
  private checkRoot() {
    const before = fstatSync(this.rootFd),
      current = lstatSync(this.root);
    if (
      !before.isDirectory() ||
      before.uid !== process.getuid?.() ||
      before.mode & 0o077 ||
      current.isSymbolicLink() ||
      before.ino !== current.ino ||
      before.dev !== current.dev ||
      realpathSync(this.root) !== resolve(this.root)
    )
      throw Error('Private adviser storage changed');
  }
  private check() {
    this.checkFence();
    if (this.owner === undefined) throw Error('Adviser storage is closed');
    const owned = fstatSync(this.owner),
      current = lstatSync(this.lock);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.uid !== process.getuid?.() ||
      current.mode & 0o077 ||
      owned.ino !== current.ino ||
      owned.dev !== current.dev
    )
      throw Error('Adviser storage ownership changed');
  }
  assertCurrent() {
    this.check();
  }
  load(): PlanAdviserState {
    this.check();
    let fd: number;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        // eslint-disable-next-line preserve-caught-error -- Filesystem errors may carry private credential paths.
        throw Error('Adviser credential file unavailable');
      const state = { hostId: 'urn:uuid:' + randomUUID(), accounts: [] };
      this.save(state);
      return state;
    }
    try {
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077
      )
        throw Error('Unsafe adviser credential file');
      const state = PlanAdviserStateSchema.parse(
        JSON.parse(readBoundedFile(fd, 1048576).toString('utf8')),
      );
      this.check();
      return state;
    } finally {
      closeSync(fd);
    }
  }
  save(state: PlanAdviserState) {
    this.check();
    const serialized = JSON.stringify(PlanAdviserStateSchema.parse(state));
    if (Buffer.byteLength(serialized) > 1048576)
      throw Error('Adviser credentials exceeded storage limit');
    // Replacing an unsafe file must fail, even though rename would follow no leaf link.
    try {
      const current = lstatSync(this.path);
      if (
        !current.isFile() ||
        current.nlink !== 1 ||
        current.uid !== process.getuid?.() ||
        current.mode & 0o077
      )
        throw Error('Unsafe adviser credential file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temp = join(this.root, `.accounts-${randomUUID()}`);
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, serialized);
      fsyncSync(fd);
      this.check();
      renameSync(temp, this.path);
      fsyncSync(this.rootFd);
    } finally {
      closeSync(fd);
      try {
        unlinkSync(temp);
      } catch {
        // Any unfinished private temp file remains protected. Preserve the write's original failure.
      }
    }
  }
  close() {
    if (this.owner !== undefined) {
      try {
        this.check();
        unlinkSync(this.lock);
        fsyncSync(this.rootFd);
      } catch {
        /* Retain uncertain ownership for host recovery. */
      }
      closeSync(this.owner);
      this.owner = undefined;
    }
    if (this.rootFd !== -1) {
      this.fence?.close();
      this.fence = undefined;
      this.fenceIdentity = undefined;
      closeSync(this.rootFd);
      this.rootFd = -1;
    }
  }
}
