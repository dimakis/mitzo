/** Concrete ownership of the three Telos host files. Never enroll existing data. */
import Database from 'better-sqlite3';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
  fsyncSync,
  readSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  openLease,
  assertLeaseAdmission,
  closeLease,
  lockLease,
  leaseIdentity,
  installCurrentFileProbe,
  type NativeFileLease,
} from '@mitzo/sqlite-file-owner';

export type TelosDatabaseFiles = Readonly<{ canonical: string; events: string; tasks: string }>;
type Role = keyof TelosDatabaseFiles;
type Identity = { device: string; inode: string };
const roles: readonly Role[] = ['canonical', 'events', 'tasks'];
const sidecars = ['-wal', '-shm', '-journal'] as const;
function deny(): never {
  throw new Error('Retained Telos database ownership unavailable');
}
const identity = (s: BigIntStats): Identity => ({ device: String(s.dev), inode: String(s.ino) });
const same = (a: Identity, b: Identity) => a.device === b.device && a.inode === b.inode;
function selected(files: TelosDatabaseFiles): TelosDatabaseFiles {
  const result = Object.fromEntries(
    roles.map((role) => [role, resolve(files[role])]),
  ) as unknown as TelosDatabaseFiles;
  const familyPaths = Object.values(result).flatMap((path) =>
    ['', ...sidecars].map((suffix) => path + suffix),
  );
  if (
    new Set(familyPaths).size !== familyPaths.length ||
    Object.values(result).some((file) =>
      Object.values(result).some((other) => other !== file && other.startsWith(file + '-')),
    )
  )
    deny();
  return result;
}
export function selectedTelosDatabaseFiles(): TelosDatabaseFiles {
  const root = resolve(process.env.REPO_PATH || '.');
  return selected({
    canonical: process.env.TELOS_DB_PATH || join(root, 'command_center/data/smart_todo.db'),
    events: join(root, '.mitzo/events.db'),
    tasks: join(root, '.mitzo/tasks.db'),
  });
}
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
function directory(files: TelosDatabaseFiles) {
  return join(dirname(files.canonical), '.telos-file-owners');
}
function privateFile(stat: BigIntStats, dir = false) {
  if (
    (dir ? !stat.isDirectory() : !stat.isFile()) ||
    stat.uid !== BigInt(process.geteuid?.() ?? -1) ||
    (stat.mode & 0o777n) !== (dir ? 0o700n : 0o600n) ||
    (!dir && stat.nlink !== 1n)
  )
    deny();
}
function create(path: string, content: string | Buffer) {
  const fd = openSync(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
    return identity(fstatSync(fd, { bigint: true }));
  } finally {
    closeSync(fd);
  }
}
/** Explicit host-only NEW-file operation. App startup never invokes this function.
 * Incomplete creation is retained as unavailable; never remove/adopt uncertain files. */
export function createFreshTelosDatabaseFiles(input: TelosDatabaseFiles): void {
  const files = selected(input);
  const ownerDirectory = directory(files);
  if (exists(ownerDirectory)) deny();
  // lstat includes broken symlinks. Check every member before creating any main.
  for (const file of Object.values(files)) {
    for (const suffix of ['', ...sidecars]) if (exists(file + suffix)) deny();
    // Include orphaned super-journals and unknown family suffixes; never try to
    // recover/adopt an earlier SQLite file family during NEW-file creation.
    if (
      exists(dirname(file)) &&
      readdirSync(dirname(file)).some((name) => name.startsWith(basename(file) + '-'))
    )
      deny();
  }
  for (const file of Object.values(files)) mkdirSync(dirname(file), { recursive: true });
  mkdirSync(ownerDirectory, { mode: 0o700 });
  const key = randomBytes(32);
  const keyIdentity = create(join(ownerDirectory, 'key'), key);
  const exclusion = create(join(ownerDirectory, 'exclusion'), '');
  const births = Object.fromEntries(
    roles.map((role) => [role, { path: files[role], ...create(files[role], '') }]),
  );
  const birth = {
    version: 1,
    directory: identity(lstatSync(ownerDirectory, { bigint: true })),
    key: keyIdentity,
    exclusion,
    files: births,
  };
  const payload = JSON.stringify(birth);
  create(
    join(ownerDirectory, 'birth.json'),
    JSON.stringify({ payload, mac: createHmac('sha256', key).update(payload).digest('hex') }),
  );
  const fd = openSync(ownerDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

type Anchor = { path: string; fd: number; id: Identity; contents?: Buffer };
function contents(fd: number): Buffer {
  const size = Number(fstatSync(fd).size);
  if (!Number.isSafeInteger(size) || size < 0 || size > 32768) deny();
  const buffer = Buffer.alloc(size);
  if (readSync(fd, buffer, 0, size, 0) !== size) deny();
  return buffer;
}
function capture(path: string, dir = false, keepContents = false, writable = false): Anchor {
  const fd = openSync(
    path,
    (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd, { bigint: true });
    privateFile(stat, dir);
    if (!same(identity(stat), identity(lstatSync(path, { bigint: true })))) deny();
    return { path, fd, id: identity(stat), ...(keepContents ? { contents: contents(fd) } : {}) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function check(anchor: Anchor) {
  const current = lstatSync(anchor.path, { bigint: true });
  privateFile(current, current.isDirectory());
  if (
    current.isSymbolicLink() ||
    !same(anchor.id, identity(current)) ||
    !same(anchor.id, identity(fstatSync(anchor.fd, { bigint: true }))) ||
    (anchor.contents && !anchor.contents.equals(contents(anchor.fd)))
  )
    deny();
}
let activeFamily: Family | undefined;
class Family {
  readonly anchors: Anchor[] = [];
  readonly root: string;
  lease: NativeFileLease | undefined;
  refs = 0;
  invalid = false;
  disposed = false;
  birthRecord: Anchor | undefined;
  exclusive = false;
  readonly mains: Partial<Record<Role, Anchor>> = {};
  readonly connections: Record<Role, number> = { canonical: 0, events: 0, tasks: 0 };
  readonly sidecarSets: Partial<Record<Role, Array<Anchor | { path: string }>>> = {};
  constructor(readonly files: TelosDatabaseFiles) {
    this.root = directory(files);
    // Main-thread confinement makes the synchronous check/capture/open sequence
    // non-interleaving. No metadata alias FD is opened before native admission.
    assertLeaseAdmission();
    try {
      if (exists(join(this.root, 'invalid'))) deny();
      const dir = capture(this.root, true);
      this.anchors.push(dir);
      const key = capture(join(this.root, 'key'), false, true);
      this.anchors.push(key);
      const record = capture(join(this.root, 'birth.json'), false, true, true);
      this.birthRecord = record;
      this.anchors.push(record);
      const envelope = JSON.parse(record.contents!.toString('utf8')) as {
        payload: string;
        mac: string;
      };
      if (
        typeof envelope.payload !== 'string' ||
        typeof envelope.mac !== 'string' ||
        !/^[a-f0-9]{64}$/.test(envelope.mac) ||
        key.contents!.length !== 32
      )
        deny();
      const expected = createHmac('sha256', key.contents!).update(envelope.payload).digest();
      if (!timingSafeEqual(expected, Buffer.from(envelope.mac, 'hex'))) deny();
      const birth = JSON.parse(envelope.payload);
      if (birth.version !== 1 || !same(dir.id, birth.directory) || !same(key.id, birth.key)) deny();
      // Metadata can be captured without affecting SQLite locks. Authenticate it
      // before exclusion acquisition, but reject other environments before ANY DB
      // or sidecar descriptor is opened and later closed during error cleanup.
      this.lease = openLease(join(this.root, 'exclusion'));
      lockLease(this.lease, 0);
      try {
        for (const role of roles) {
          const anchor = capture(files[role]);
          this.anchors.push(anchor);
          this.mains[role] = anchor;
          if (birth.files[role].path !== files[role] || !same(anchor.id, birth.files[role])) deny();
        }
      } catch (error) {
        this.invalidate();
        throw error;
      }
      if (!same(leaseIdentity(this.lease), birth.exclusion)) deny();
      this.assert();
    } catch (error) {
      const transient =
        error instanceof Error &&
        'code' in error &&
        (error.code === 'MITZO_OWNER_BUSY' || error.code === 'MITZO_OWNER_UNSUPPORTED');
      if (!transient) this.invalidate();
      this.dispose();
      throw error;
    }
  }
  matches(files: TelosDatabaseFiles) {
    return roles.every((role) => this.files[role] === files[role]);
  }
  invalidate() {
    this.invalid = true;
    if (this.disposed) return;
    // Invalidate the RETAINED record, including after its directory was renamed.
    // A restored old pathname cannot revive this history on cold reopening.
    if (this.birthRecord) {
      try {
        if (same(this.birthRecord.id, identity(fstatSync(this.birthRecord.fd, { bigint: true })))) {
          writeSync(this.birthRecord.fd, Buffer.from('!'), 0, 1, 0);
          fsyncSync(this.birthRecord.fd);
        }
      } catch {
        /* this lifetime remains denied */
      }
    }
    const directoryAnchor = this.anchors.find((anchor) => anchor.path === this.root);
    if (directoryAnchor) {
      try {
        // A retained birth fd can invalidate its original record after rename.
        // A path marker requires the ORIGINAL retained directory still at that path.
        check(directoryAnchor);
        create(join(this.root, 'invalid'), 'Observed retained-owner loss\n');
      } catch {
        /* original directory unavailable, or already invalid */
      }
    }
  }
  assert() {
    try {
      if (this.disposed || this.invalid || !this.lease || exists(join(this.root, 'invalid')))
        deny();
      for (const anchor of this.anchors) check(anchor);
      const lock = lstatSync(join(this.root, 'exclusion'), { bigint: true });
      privateFile(lock);
      if (!same(identity(lock), leaseIdentity(this.lease))) deny();
    } catch (error) {
      this.invalidate();
      throw error;
    }
  }
  dispose() {
    if (this.disposed) return;
    // Retire every cached write/close capability BEFORE any descriptor can be
    // released and reused. A later stale owner/fence is inert for this family.
    this.disposed = true;
    this.birthRecord = undefined;
    const anchors = this.anchors.splice(0);
    const lease = this.lease;
    this.lease = undefined;
    if (activeFamily === this) activeFamily = undefined;
    let failed = false;
    for (const anchor of anchors) {
      try {
        closeSync(anchor.fd);
      } catch {
        failed = true;
      }
    }
    if (lease) {
      try {
        closeLease(lease);
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error('Retained Telos descriptor cleanup failed');
  }
}
function retain(files: TelosDatabaseFiles): Family | undefined {
  if (activeFamily) {
    if (!activeFamily.matches(files)) return undefined;
    activeFamily.assert();
    activeFamily.refs++;
    return activeFamily;
  }
  if (!exists(directory(files))) return undefined;
  const family = new Family(files);
  activeFamily = family;
  family.refs++;
  return family;
}
export interface TelosOwnedDatabase {
  readonly database: Database.Database;
  /** Call once, after this constructor's own initialization, before publishing it. */
  seal(): void;
  assertCurrent(): void;
  acquireDeletionExclusion(): () => void;
  invalidate(): void;
  close(): void;
}
/** Capture BEFORE opening SQLite. Never accepts an already opened connection. */
export function openTelosOwnedDatabase(
  role: Role,
  filename: string,
  options: Database.Options = {},
  input = selectedTelosDatabaseFiles(),
): TelosOwnedDatabase {
  const files = selected(input);
  let family: Family | undefined;
  // Unknown legacy roots keep ordinary operation. A known retained family must
  // NEVER create an untracked SQLite handle after admission failure: its later
  // lifetime could outlast the last managed owner and lose process-owned locks.
  if (activeFamily) {
    let physical: Identity | undefined;
    try {
      physical = identity(statSync(filename, { bigint: true }));
    } catch {
      /* absent path */
    }
    const aliasesRetained =
      physical && roles.some((member) => same(activeFamily!.mains[member]!.id, physical!));
    if (aliasesRetained && (resolve(filename) !== files[role] || !activeFamily.matches(files)))
      deny();
  }
  if (resolve(filename) === files[role] && exists(directory(files))) {
    family = retain(files);
    if (!family) deny();
  }
  const anchor = family?.mains[role];
  let database: Database.Database;
  let opened: Database.Database | undefined;
  try {
    if (family) {
      family.connections[role]++;
      family.assert();
    }
    database = new Database(filename, options);
    opened = database;
    if (family) installCurrentFileProbe(database);
  } catch (error) {
    if (opened?.open) opened.close();
    if (family) {
      family.connections[role]--;
      if (--family.refs === 0) family.dispose();
    }
    throw error;
  }
  let closed = false;
  let sealed = false;
  let supportedJournal = false;
  function assertCurrent() {
    if (closed || !sealed || !family || !anchor || !supportedJournal) deny();
    try {
      if (!database.open) deny();
      family.assert();
      check(anchor);
      if (
        (
          database.prepare('SELECT mitzo_file_owner_current() AS current').get() as {
            current: number;
          }
        ).current !== 1
      )
        deny();
      for (const sidecar of family.sidecarSets[role] ?? []) {
        if ('fd' in sidecar) check(sidecar);
        else if (exists(sidecar.path)) deny();
      }
    } catch (error) {
      family?.invalidate();
      throw error;
    }
  }
  return Object.freeze({
    database,
    seal() {
      if (sealed || closed) deny();
      sealed = true;
      if (!family) return;
      supportedJournal = database.pragma('journal_mode', { simple: true }) === 'wal';
      if (!supportedJournal) return;
      try {
        if (!family.sidecarSets[role]) {
          const captures: Array<Anchor | { path: string }> = [];
          family.sidecarSets[role] = captures;
          for (const suffix of sidecars) {
            const path = filename + suffix;
            captures.push(exists(path) ? capture(path) : { path });
          }
        }
        assertCurrent();
      } catch (error) {
        family.invalidate();
        throw error;
      }
    },
    assertCurrent,
    invalidate() {
      if (!closed) family?.invalidate();
    },
    acquireDeletionExclusion() {
      assertCurrent();
      if (!family || family.exclusive || !family.lease) deny();
      lockLease(family.lease, 1);
      family.exclusive = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (family!.disposed) return;
        family!.exclusive = false;
        try {
          lockLease(family!.lease!, 0);
        } catch (error) {
          family!.invalidate();
          throw error;
        }
      };
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        if (database.open) database.close();
      } finally {
        if (database.open) {
          family?.invalidate();
          deny();
        }
        if (family) {
          // POSIX locks are process-owned. Close auxiliary DB-family descriptors
          // only after the LAST managed SQLite connection for this role closes.
          if (--family.connections[role] === 0) {
            for (const sidecar of family.sidecarSets[role] ?? [])
              if ('fd' in sidecar) closeSync(sidecar.fd);
            delete family.sidecarSets[role];
          }
          if (--family.refs === 0) family.dispose();
        }
      }
    },
  });
}

/** A private native SQLite savepoint proves the ORIGINAL writer still exists.
 * This is transaction retention only; it supplies no file-family authority. */
export function retainTelosDeletionWriterMarker(db: Database.Database) {
  if (!db.open || db.readonly || !db.inTransaction) deny();
  const name = `mitzo_telos_writer_${randomBytes(24).toString('hex')}`;
  db.exec(`SAVEPOINT ${name}`);
  let lost = false;
  return Object.freeze({
    assertCurrent() {
      if (lost || !db.open || !db.inTransaction) deny();
      try {
        db.exec(`RELEASE SAVEPOINT ${name}; SAVEPOINT ${name}`);
      } catch {
        lost = true;
        deny();
      }
    },
    release() {
      if (lost || !db.open || !db.inTransaction) deny();
      try {
        db.exec(`RELEASE SAVEPOINT ${name}`);
        lost = true;
      } catch {
        lost = true;
        deny();
      }
    },
  });
}

export interface TelosDeletionReferenceScope {
  assertCurrent(): void;
  close(): void;
}
/** Called by the actual reference store with its private complete reader. It
 * starts its own writer, never borrows another caller's transaction. */
export function beginTelosDeletionReferenceScope(
  owner: TelosOwnedDatabase,
  readCompleteReferences: () => void,
): TelosDeletionReferenceScope {
  owner.assertCurrent();
  const db = owner.database;
  if (db.readonly || db.inTransaction) deny();
  db.exec('BEGIN IMMEDIATE');
  const marker = retainTelosDeletionWriterMarker(db);
  let closed = false;
  const scope = Object.freeze({
    assertCurrent() {
      if (closed || !db.open || !db.inTransaction) deny();
      try {
        marker.assertCurrent();
      } catch (error) {
        owner.invalidate();
        throw error;
      }
      owner.assertCurrent();
      readCompleteReferences();
    },
    close() {
      if (closed) return;
      closed = true;
      if (db.open && db.inTransaction) {
        try {
          marker.release();
        } catch (error) {
          owner.invalidate();
          throw error;
        }
        db.exec('ROLLBACK');
      }
    },
  });
  try {
    scope.assertCurrent();
    return scope;
  } catch (error) {
    scope.close();
    throw error;
  }
}
