import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  writeSync,
  fsyncSync,
  fchmodSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

/** Private constructor seam only. Never serialized in Worker IPC or request input. */
export type OriginalProcessObserver = (
  role: 'gateway' | 'controller',
  child: ChildProcess,
  assertCurrent: () => void,
) => void;
export interface KernelProcessBirth {
  readonly domain: string;
  readonly pid: number;
  readonly parentPid: number;
  readonly uid: number;
  readonly birth: string;
}
export interface OriginalProcessBirthRecord {
  readonly role: 'gateway' | 'controller';
  readonly owner: Readonly<KernelProcessBirth>;
  readonly child: Readonly<KernelProcessBirth>;
}
/** The host adapter must read kernel birth (e.g. Darwin proc_pidinfo), not ps,
 * listener discovery or historical rows. append must durably fsync before return.
 * This journal is diagnostic provenance, never cleanup/admission authority. */
export function createOriginalProcessRecorder(input: {
  readKernelBirth(pid: number): KernelProcessBirth;
  append(record: Readonly<OriginalProcessBirthRecord>): void;
}): OriginalProcessObserver {
  if (typeof input.readKernelBirth !== 'function' || typeof input.append !== 'function')
    throw Error('Original process journal requires trusted host adapters');
  const read = input.readKernelBirth,
    append = input.append;
  const retained = new WeakSet<ChildProcess>();
  const snapshot = (pid: number) => {
    const value = read(pid);
    if (
      !value ||
      value.pid !== pid ||
      !/^[a-f0-9]{64}$/.test(value.domain) ||
      !Number.isSafeInteger(value.parentPid) ||
      value.parentPid < 1 ||
      !Number.isSafeInteger(value.uid) ||
      value.uid !== process.getuid?.() ||
      typeof value.birth !== 'string' ||
      !/^[0-9]{1,20}:[0-9]{1,20}$/.test(value.birth)
    )
      throw Error('Original kernel process birth unavailable');
    return Object.freeze({
      domain: value.domain,
      pid: value.pid,
      parentPid: value.parentPid,
      uid: value.uid,
      birth: value.birth,
    });
  };
  return (role, child, assertCurrent) => {
    if (
      !['gateway', 'controller'].includes(role) ||
      retained.has(child) ||
      !Number.isSafeInteger(child.pid) ||
      child.pid! < 1 ||
      child.pid === process.pid
    )
      throw Error('Original process creation unavailable');
    // Consume the one creation observation even if any subsequent read/append fails.
    retained.add(child);
    const current = () => {
      assertCurrent();
      if (child.exitCode !== null || child.signalCode !== null || child.killed)
        throw Error('Original process creation lost');
    };
    current();
    const owner = snapshot(process.pid),
      original = snapshot(child.pid!);
    if (
      owner.parentPid !== process.ppid ||
      original.parentPid !== owner.pid ||
      original.domain !== owner.domain
    )
      throw Error('Original process parent/domain mismatch');
    current();
    const ownerAfter = snapshot(process.pid),
      childAfter = snapshot(child.pid!);
    if (
      JSON.stringify(ownerAfter) !== JSON.stringify(owner) ||
      JSON.stringify(childAfter) !== JSON.stringify(original)
    )
      throw Error('Original process birth changed');
    current();
    const result: unknown = append(Object.freeze({ role, owner, child: original }));
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      throw Error('Original process journal must be synchronous');
    }
    // An already-written record is preserved if authority is lost here.
    current();
  };
}

/** Fresh private journal opened before any child creation. All later appends use
 * that exact held FD. The creating host must close its lease after observation. */
export function createPrivateOriginalProcessJournal(
  directory: string,
  readKernelBirth: (pid: number) => KernelProcessBirth,
): OriginalProcessObserver & { close(): void } {
  const parent = lstatSync(directory);
  if (
    !isAbsolute(directory) ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o777) !== 0o700 ||
    parent.uid !== process.getuid?.()
  )
    throw Error('Original process journal directory unavailable');
  const stableParent = () => {
    const now = lstatSync(directory);
    if (
      !now.isDirectory() ||
      now.isSymbolicLink() ||
      now.dev !== parent.dev ||
      now.ino !== parent.ino ||
      now.uid !== parent.uid ||
      (now.mode & 0o777) !== 0o700
    )
      throw Error('Original process journal directory changed');
  };
  const dir = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let fd: number;
  try {
    const observed = fstatSync(dir);
    if (observed.ino !== parent.ino || observed.dev !== parent.dev)
      throw Error('Original journal parent changed');
    stableParent();
    fd = openSync(
      join(directory, `original-process-${randomUUID()}.jsonl`),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    closeSync(dir);
    throw error;
  }
  let closed = false;
  let veto = false;
  let records = 0;
  let totalBytes = 0;
  const maxRecords = 128,
    maxTotalBytes = 45_056;
  try {
    fchmodSync(fd, 0o600);
    stableParent();
    fsyncSync(fd);
    fsyncSync(dir);
    const original = fstatSync(fd);
    const record = createOriginalProcessRecorder({
      readKernelBirth,
      append(value) {
        if (closed || veto) throw Error('Original process journal fenced');
        if (records >= maxRecords) throw Error('Original process journal record budget exhausted');
        stableParent();
        const now = fstatSync(fd);
        if (
          !now.isFile() ||
          now.nlink !== 1 ||
          now.uid !== parent.uid ||
          now.dev !== original.dev ||
          now.ino !== original.ino ||
          (now.mode & 0o777) !== 0o600
        )
          throw Error('Original process journal changed');
        const bytes = Buffer.from(JSON.stringify(value) + '\n');
        if (bytes.length > 2048 || totalBytes + bytes.length > maxTotalBytes)
          throw Error('Original process journal byte budget exhausted');
        if (writeSync(fd, bytes) !== bytes.length)
          throw Error('Original process journal write uncertain');
        fsyncSync(fd);
        stableParent();
        records++;
        totalBytes += bytes.length;
      },
    });
    const guarded: OriginalProcessObserver = (role, child, current) => {
      if (closed || veto) throw Error('Original process journal fenced');
      try {
        record(role, child, current);
      } catch (error) {
        veto = true;
        throw error;
      }
    };
    return Object.assign(guarded, {
      close() {
        if (!closed) {
          closed = true;
          closeSync(fd);
          closeSync(dir);
        }
      },
    });
  } catch (error) {
    closeSync(fd);
    closeSync(dir);
    throw error;
  }
}
