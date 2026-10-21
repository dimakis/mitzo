/** Concrete ownership of the three Telos host files. Never enroll existing data. */
import Database from 'better-sqlite3';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  fsyncSync,
  readSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  openLease,
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
  if (new Set(Object.values(result)).size !== 3) deny();
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
  for (const file of Object.values(files))
    for (const suffix of ['', ...sidecars]) if (exists(file + suffix)) deny();
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
  birthRecord: Anchor | undefined;
  exclusive = false;
  constructor(readonly files: TelosDatabaseFiles) {
    this.root = directory(files);
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
      try {
        for (const role of roles) {
          const anchor = capture(files[role]);
          this.anchors.push(anchor);
          if (birth.files[role].path !== files[role] || !same(anchor.id, birth.files[role])) deny();
        }
      } catch (error) {
        this.invalidate();
        throw error;
      }
      this.lease = openLease(join(this.root, 'exclusion'));
      lockLease(this.lease, 0);
      if (!same(leaseIdentity(this.lease), birth.exclusion)) deny();
      this.assert();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  matches(files: TelosDatabaseFiles) {
    return roles.every((role) => this.files[role] === files[role]);
  }
  invalidate() {
    this.invalid = true;
    // Invalidate the RETAINED record, including after its directory was renamed.
    // A restored old pathname cannot revive this history on cold reopening.
    if (this.birthRecord) {
      try {
        writeSync(this.birthRecord.fd, Buffer.from('!'), 0, 1, 0);
        fsyncSync(this.birthRecord.fd);
      } catch {
        /* this lifetime remains denied */
      }
    }
    try {
      create(join(this.root, 'invalid'), 'Observed retained-owner loss\n');
    } catch {
      /* already invalid or unavailable */
    }
  }
  assert() {
    try {
      if (this.invalid || !this.lease || exists(join(this.root, 'invalid'))) deny();
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
    for (const anchor of this.anchors.splice(0)) closeSync(anchor.fd);
    if (this.lease) {
      const lease = this.lease;
      this.lease = undefined;
      closeLease(lease);
    }
    if (activeFamily === this) activeFamily = undefined;
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
  // Ordinary legacy operation stays available; ownership is independently denied.
  try {
    if (resolve(filename) === files[role]) family = retain(files);
  } catch {
    /* fail closed for deletion */
  }
  let anchor: Anchor | undefined;
  let database: Database.Database;
  let opened: Database.Database | undefined;
  try {
    if (family) anchor = capture(filename);
    database = new Database(filename, options);
    opened = database;
    if (family) installCurrentFileProbe(database);
  } catch (error) {
    if (opened?.open) opened.close();
    if (anchor) closeSync(anchor.fd);
    if (family && --family.refs === 0) family.dispose();
    throw error;
  }
  let closed = false;
  let sealed = false;
  const sealedSidecars: Array<Anchor | { path: string }> = [];
  function assertCurrent() {
    if (closed || !sealed || !family || !anchor) deny();
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
      for (const sidecar of sealedSidecars) {
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
      try {
        for (const suffix of sidecars) {
          const path = filename + suffix;
          sealedSidecars.push(exists(path) ? capture(path) : { path });
        }
        assertCurrent();
      } catch (error) {
        family.invalidate();
        throw error;
      }
    },
    assertCurrent,
    acquireDeletionExclusion() {
      assertCurrent();
      if (!family || family.exclusive || !family.lease) deny();
      lockLease(family.lease, 1);
      family.exclusive = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
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
        for (const sidecar of sealedSidecars) if ('fd' in sidecar) closeSync(sidecar.fd);
        if (anchor) closeSync(anchor.fd);
        if (family && --family.refs === 0) family.dispose();
      }
    },
  });
}
