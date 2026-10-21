import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, statSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import {
  openLease,
  closeLease,
  lockLease,
  leaseIdentity,
  installCurrentFileProbe,
  type NativeFileLease,
} from '@mitzo/sqlite-file-owner';

const roots: string[] = [];
const databases: Database.Database[] = [];
const leases: NativeFileLease[] = [];
const children: ChildProcess[] = [];
const workers: Worker[] = [];
const nativePath = new URL('../../packages/sqlite-file-owner/index.cjs', import.meta.url).pathname;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-owner-'));
  roots.push(root);
  const path = join(root, 'owner.lock');
  writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
  return { root, path };
}
function lease(path: string) {
  const handle = openLease(path);
  leases.push(handle);
  return handle;
}
function close(handle: NativeFileLease) {
  closeLease(handle);
  leases.splice(leases.indexOf(handle), 1);
}
const childSource = `
  const native = require(process.argv[1]);
  let handle;
  try {
    handle = native.openLease(process.argv[2]);
    native.lockLease(handle, Number(process.argv[3]));
    process.stdout.write('LOCKED\\n');
    if (process.argv[4] === 'hold') process.stdin.resume();
    else native.closeLease(handle);
  } catch (error) {
    if (handle) native.closeLease(handle);
    process.stdout.write(String(error.code));
    process.exitCode = 23;
  }
`;
function probe(path: string, mode: 0 | 1) {
  return spawnSync(process.execPath, ['-e', childSource, nativePath, path, String(mode)], {
    encoding: 'utf8',
    timeout: 5000,
    env: process.env,
  });
}
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.terminate();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = new Promise<void>((resolve) => child.once('close', () => resolve()));
      child.kill('SIGKILL');
      await ended;
    }
  }
  for (const database of databases.splice(0)) if (database.open) database.close();
  for (const handle of leases.splice(0)) closeLease(handle);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('observes the actual SQLite handle after an identical database replaces its pathname', () => {
  const { root } = fixture();
  const path = join(root, 'canonical.db');
  const original = join(root, 'retained-original.db');
  const database = new Database(path);
  databases.push(database);
  database.exec("CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('retained')");
  installCurrentFileProbe(database);
  const current = database.prepare('SELECT mitzo_file_owner_current() AS current');
  expect(current.get()).toEqual({ current: 1 });
  renameSync(path, original);
  copyFileSync(original, path);
  expect(database.name).toBe(path);
  expect(database.prepare('SELECT value FROM evidence').get()).toEqual({ value: 'retained' });
  expect(current.get()).toEqual({ current: 0 });
  rmSync(path);
  renameSync(original, path);
  // The primitive is deliberately not historical. The owner must retain loss.
  expect(current.get()).toEqual({ current: 1 });
});

it('denies an unsupported memory-file observation and use through an untrusted view', () => {
  const database = new Database(':memory:');
  databases.push(database);
  installCurrentFileProbe(database);
  expect(() => database.prepare('SELECT mitzo_file_owner_current()').get()).toThrow(
    'Actual SQLite file observation unsupported',
  );
  database.exec('CREATE VIEW borrowed AS SELECT mitzo_file_owner_current()');
  expect(() => database.prepare('SELECT * FROM borrowed').get()).toThrow();
});

it('retains the kernel descriptor identity when the lock pathname is replaced', () => {
  const { root, path } = fixture();
  const expected = statSync(path, { bigint: true });
  const handle = lease(path);
  renameSync(path, join(root, 'retained.lock'));
  writeFileSync(path, 'replacement', { flag: 'wx' });
  expect(leaseIdentity(handle)).toEqual({
    device: String(expected.dev),
    inode: String(expected.ino),
  });
  expect(String(statSync(path, { bigint: true }).ino)).not.toBe(String(expected.ino));
});

it('excludes independent processes only while the real exclusive lock is retained', () => {
  const { path } = fixture();
  const handle = lease(path);
  lockLease(handle, 0);
  expect(probe(path, 0).status).toBe(0);
  const denied = probe(path, 1);
  expect(denied.status).toBe(23);
  expect(denied.stdout).toBe('MITZO_OWNER_BUSY');
  lockLease(handle, 1);
  expect(probe(path, 0).status).toBe(23);
  lockLease(handle, 0);
  expect(probe(path, 0).status).toBe(0);
  close(handle);
  expect(probe(path, 1).status).toBe(0);
});

it('keeps its shared lock after a failed exclusive conversion', async () => {
  const { path } = fixture();
  const handle = lease(path);
  lockLease(handle, 0);
  const child = spawn(process.execPath, ['-e', childSource, nativePath, path, '0', 'hold'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(Error('Independent lock owner did not start')), 5000);
    child.stdout.once('data', (data) => {
      clearTimeout(deadline);
      if (String(data) !== 'LOCKED\n') reject(Error(String(data)));
      else resolve();
    });
    child.once('error', reject);
  });
  expect(() => lockLease(handle, 1)).toThrow();
  const ended = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.kill('SIGTERM');
  await ended;
  // This probe runs after the OTHER shared holder is reaped.
  expect(probe(path, 1).status).toBe(23);
  lockLease(handle, 1);
  expect(probe(path, 0).status).toBe(23);
});

it('cannot turn a forged, closed or second descriptor into the retained lease', () => {
  const { root, path } = fixture();
  const handle = lease(path);
  const other = join(root, 'other.lock');
  writeFileSync(other, '', { flag: 'wx' });
  expect(() => openLease(other)).toThrow('already open');
  expect(() => lockLease({ available: true } as unknown as NativeFileLease, 1)).toThrow();
  close(handle);
  const next = lease(path);
  expect(() => lockLease(handle, 1)).toThrow();
  expect(() => closeLease(handle)).toThrow();
  lockLease(next, 1);
  expect(probe(path, 0).status).toBe(23);
});

it('denies worker-environment lease authority before touching the process singleton', async () => {
  const { path } = fixture();
  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads');
      const native = require(workerData.nativePath);
      let handle;
      try {
        handle = native.openLease(workerData.path);
        native.lockLease(handle, 1);
        native.closeLease(handle);
        parentPort.postMessage({ result: 'acquired-real-exclusive-lock' });
      } catch (error) {
        parentPort.postMessage({ result: 'denied', code: error.code });
      }
    `,
    {
      eval: true,
      workerData: { nativePath, path },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    },
  );
  workers.push(worker);
  const result = await new Promise<unknown>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  expect(result).toEqual({ result: 'denied', code: 'MITZO_OWNER_UNSUPPORTED' });
  const handle = lease(path);
  lockLease(handle, 0);
  expect(probe(path, 1).status).toBe(23);
});
