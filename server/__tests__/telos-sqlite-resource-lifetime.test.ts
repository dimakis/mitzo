import { afterEach, expect, it, vi } from 'vitest';
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { closeLease, openLease } from '@mitzo/sqlite-file-owner';
import {
  createFreshTelosDatabaseFiles,
  openTelosOwnedDatabase,
  type TelosOwnedDatabase,
} from '../../packages/protocol/src/telos-sqlite-owners.js';

const closing = vi.hoisted(() => ({
  fail: -1,
  calls: [] as number[],
  enabled: false,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    closeSync(fd: number) {
      if (closing.enabled) closing.calls.push(fd);
      fs.closeSync(fd);
      if (closing.enabled && fd === closing.fail) {
        closing.fail = -1;
        throw new Error('Injected ambiguous sidecar close failure');
      }
    },
  };
});
const require = createRequire(import.meta.url);
const sqlite = require.resolve('better-sqlite3');
const roots: string[] = [];
const owners: TelosOwnedDatabase[] = [];
const workers: Worker[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telos-resource-lifetime-'));
  roots.push(root);
  const files = {
    canonical: join(root, 'canonical.db'),
    events: join(root, 'events.db'),
    tasks: join(root, 'tasks.db'),
  };
  createFreshTelosDatabaseFiles(files);
  return { root, files };
}
function open(
  files: ReturnType<typeof fixture>['files'],
  role: 'canonical' | 'tasks' = 'canonical',
) {
  const owner = openTelosOwnedDatabase(role, files[role], {}, files);
  owners.push(owner);
  owner.database.pragma('journal_mode=WAL');
  owner.database.exec('CREATE TABLE IF NOT EXISTS evidence(value TEXT)');
  owner.seal();
  return owner;
}
function writerProbe(path: string) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      "const Database=require(process.argv[1]);const db=new Database(process.argv[2],{timeout:0});try{db.exec('BEGIN IMMEDIATE;ROLLBACK');}catch(e){process.stdout.write(String(e.code));process.exitCode=23;}finally{db.close();}",
      sqlite,
      path,
    ],
    { encoding: 'utf8', timeout: 5000, env: process.env },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { status: result.status, stdout: result.stdout };
}
afterEach(async () => {
  closing.enabled = false;
  closing.fail = -1;
  for (const worker of workers.splice(0)) await worker.terminate();
  for (const owner of owners.splice(0)) owner.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(['same module', 'secondary module'] as const)(
  'denies a warm missing owner directory before admitting SQLite through %s',
  async (module) => {
    const { root, files } = fixture();
    const original = open(files);
    original.database.exec('BEGIN IMMEDIATE');
    renameSync(join(root, '.telos-file-owners'), join(root, '.telos-file-owners.saved'));
    let factory = openTelosOwnedDatabase;
    if (module === 'secondary module') {
      vi.resetModules();
      factory = (await import('../../packages/protocol/src/telos-sqlite-owners.js'))
        .openTelosOwnedDatabase;
    }
    let admitted: TelosOwnedDatabase | undefined;
    let failure: unknown;
    try {
      admitted = factory('canonical', files.canonical, {}, files);
      owners.push(admitted);
      admitted.close();
    } catch (error) {
      failure = error;
    }
    expect(writerProbe(files.canonical)).toEqual({ status: 23, stdout: 'SQLITE_BUSY' });
    original.database.exec('ROLLBACK');
    original.close();
    expect(writerProbe(files.canonical)).toEqual({ status: 0, stdout: '' });
    expect(admitted).toBeUndefined();
    expect(failure).toBeInstanceOf(Error);
  },
);

it('denies worker admission after warm owner-directory loss and preserves the original writer', async () => {
  const { root, files } = fixture();
  const original = open(files);
  original.database.exec('BEGIN IMMEDIATE');
  renameSync(join(root, '.telos-file-owners'), join(root, '.telos-file-owners.saved'));
  const worker = new Worker(
    `
    const {parentPort,workerData}=require('node:worker_threads');
    require(workerData.tsx).register();
    const {openTelosOwnedDatabase}=require(workerData.module);
    try {
      const owner=openTelosOwnedDatabase('canonical',workerData.files.canonical,{timeout:0},workerData.files);
      owner.close();parentPort.postMessage({admitted:true});
    } catch(error) {parentPort.postMessage({denied:error.code});}
  `,
    {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 64 },
      workerData: {
        tsx: require.resolve('tsx/cjs/api'),
        module: new URL('../../packages/protocol/src/telos-sqlite-owners.ts', import.meta.url)
          .pathname,
        files,
      },
    },
  );
  workers.push(worker);
  const result = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Worker admission timed out')), 5000);
    worker.once('message', (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  expect(writerProbe(files.canonical)).toEqual({ status: 23, stdout: 'SQLITE_BUSY' });
  original.database.exec('ROLLBACK');
  original.close();
  expect(result).toEqual({ denied: 'MITZO_OWNER_BUSY' });
});

it('retires a partially closed sidecar set before fd reuse and finishes family cleanup', () => {
  const { root, files } = fixture();
  const canonical = openTelosOwnedDatabase('canonical', files.canonical, {}, files);
  owners.push(canonical);
  canonical.database.pragma('journal_mode=WAL');
  canonical.database.exec('CREATE TABLE evidence(value TEXT)');
  writeFileSync(files.canonical + '-journal', '', { mode: 0o600, flag: 'wx' });
  canonical.seal();
  const task = open(files, 'tasks');
  task.database.exec('BEGIN IMMEDIATE');
  function descriptor(path: string) {
    const id = statSync(path, { bigint: true });
    const matches = readdirSync('/dev/fd')
      .map(Number)
      .filter((fd) => {
        try {
          const info = fstatSync(fd, { bigint: true });
          return info.dev === id.dev && info.ino === id.ino;
        } catch {
          return false;
        }
      });
    // Captures occur after SQLite opens its own handles.
    return Math.max(...matches);
  }
  const wal = descriptor(files.canonical + '-wal');
  const shm = descriptor(files.canonical + '-shm');
  const journal = descriptor(files.canonical + '-journal');
  expect(Number.isFinite(wal) && Number.isFinite(shm) && Number.isFinite(journal)).toBe(true);
  closing.calls = [];
  closing.fail = shm;
  closing.enabled = true;
  let failure: unknown;
  try {
    canonical.close();
  } catch (error) {
    failure = error;
  }
  closing.enabled = false;
  expect(failure).toBeInstanceOf(Error);
  const attempted = [...closing.calls];
  const innocent = join(root, 'unrelated');
  writeFileSync(innocent, 'UNRELATED DATA', { flag: 'wx' });
  const innocentId = statSync(innocent, { bigint: true });
  const descriptors: number[] = [];
  try {
    let reused = false;
    for (let i = 0; i < 256; i++) {
      const fd = openSync(innocent, 'r');
      descriptors.push(fd);
      if (fd === wal) {
        reused = true;
        break;
      }
      if (fd > wal) break;
    }
    expect(reused).toBe(true);
    // A stale sidecar cache is exercised even if another constructor is attempted.
    try {
      const next = openTelosOwnedDatabase('canonical', files.canonical, {}, files);
      owners.push(next);
      next.close();
    } catch {
      /* invalidated retained history correctly denies another constructor */
    }
    const reusedId = fstatSync(wal, { bigint: true });
    expect({ dev: reusedId.dev, ino: reusedId.ino }).toEqual({
      dev: innocentId.dev,
      ino: innocentId.ino,
    });
    expect(writerProbe(files.tasks)).toEqual({ status: 23, stdout: 'SQLITE_BUSY' });
    expect(attempted).toEqual(expect.arrayContaining([wal, shm, journal]));
  } finally {
    for (const fd of descriptors) {
      try {
        const id = fstatSync(fd, { bigint: true });
        if (id.dev === innocentId.dev && id.ino === innocentId.ino) closeSync(fd);
      } catch {
        /* the RED implementation may already have closed a reused fd */
      }
    }
    if (task.database.inTransaction) task.database.exec('ROLLBACK');
  }
  task.close();
  const lease = openLease(join(root, '.telos-file-owners/exclusion'));
  closeLease(lease);
});

it('keeps an ordinary connection claim after failed close and releases it only after actual close', () => {
  const root = mkdtempSync(join(tmpdir(), 'telos-ordinary-close-'));
  roots.push(root);
  const files = {
    canonical: join(root, 'canonical.db'),
    events: join(root, 'events.db'),
    tasks: join(root, 'tasks.db'),
  };
  const ordinary = openTelosOwnedDatabase('canonical', files.canonical, {}, files);
  owners.push(ordinary);
  ordinary.database.exec('CREATE TABLE evidence(value TEXT); BEGIN IMMEDIATE');
  const lock = join(root, 'test.lock');
  writeFileSync(lock, '', { mode: 0o600, flag: 'wx' });
  const close = vi.spyOn(ordinary.database, 'close').mockImplementationOnce(() => {
    throw new Error('Actual connection still open');
  });
  try {
    expect(() => ordinary.close()).toThrow('Telos SQLite close failed');
    expect(ordinary.database.open).toBe(true);
    expect(writerProbe(files.canonical)).toEqual({ status: 23, stdout: 'SQLITE_BUSY' });
    expect(() => openLease(lock)).toThrow('ordinary SQLite connections remain open');
    expect(() => ordinary.assertCurrent()).toThrow();
    ordinary.close();
    expect(ordinary.database.open).toBe(false);
    const lease = openLease(lock);
    closeLease(lease);
  } finally {
    close.mockRestore();
  }
});

it('releases ordinary admission when the actual SQLite constructor fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'telos-ordinary-opening-'));
  roots.push(root);
  const files = {
    canonical: join(root, 'missing.db'),
    events: join(root, 'events.db'),
    tasks: join(root, 'tasks.db'),
  };
  expect(() =>
    openTelosOwnedDatabase(
      'canonical',
      files.canonical,
      { readonly: true, fileMustExist: true },
      files,
    ),
  ).toThrow();
  const lock = join(root, 'test.lock');
  writeFileSync(lock, '', { mode: 0o600, flag: 'wx' });
  const lease = openLease(lock);
  closeLease(lease);
});

it('preserves cold ordinary worker operation and excludes metadata capture until its actual close', async () => {
  const { files } = fixture();
  const root = mkdtempSync(join(tmpdir(), 'telos-ordinary-worker-'));
  roots.push(root);
  const legacy = {
    canonical: join(root, 'canonical.db'),
    events: join(root, 'events.db'),
    tasks: join(root, 'tasks.db'),
  };
  const worker = new Worker(
    `
    const {parentPort,workerData}=require('node:worker_threads');
    require(workerData.tsx).register();
    const {openTelosOwnedDatabase}=require(workerData.module);
    const owner=openTelosOwnedDatabase('canonical',workerData.files.canonical,{},workerData.files);
    owner.database.pragma('journal_mode=WAL');
    owner.database.exec('CREATE TABLE evidence(value TEXT);BEGIN IMMEDIATE');
    let unqualified=false;try{owner.assertCurrent();}catch{unqualified=true;}
    parentPort.postMessage({ready:true,unqualified});
    parentPort.once('message',()=>{owner.close();parentPort.postMessage('CLOSED');parentPort.close();});
  `,
    {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 64 },
      workerData: {
        tsx: require.resolve('tsx/cjs/api'),
        module: new URL('../../packages/protocol/src/telos-sqlite-owners.ts', import.meta.url)
          .pathname,
        files: legacy,
      },
    },
  );
  workers.push(worker);
  function message() {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Ordinary worker timed out')), 5000);
      worker.once('message', (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      worker.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
  expect(await message()).toEqual({ ready: true, unqualified: true });
  expect(() => openTelosOwnedDatabase('canonical', files.canonical, {}, files)).toThrow(
    'ordinary SQLite connections remain open',
  );
  expect(writerProbe(legacy.canonical)).toEqual({ status: 23, stdout: 'SQLITE_BUSY' });
  const closed = message();
  worker.postMessage('close');
  expect(await closed).toBe('CLOSED');
  expect(writerProbe(legacy.canonical)).toEqual({ status: 0, stdout: '' });
  const qualified = open(files);
  expect(() => qualified.assertCurrent()).not.toThrow();
});

it('keeps admission denied after an ordinary worker is terminated without explicit close', () => {
  const root = mkdtempSync(join(tmpdir(), 'telos-terminated-worker-'));
  roots.push(root);
  const files = {
    canonical: join(root, 'canonical.db'),
    events: join(root, 'events.db'),
    tasks: join(root, 'tasks.db'),
  };
  const workerSource = [
    "const {parentPort,workerData}=require('node:worker_threads');",
    'require(workerData.tsx).register();',
    'const {openTelosOwnedDatabase}=require(workerData.module);',
    "const owner=openTelosOwnedDatabase('canonical',workerData.files.canonical,{},workerData.files);",
    "owner.database.exec('CREATE TABLE evidence(value TEXT);BEGIN IMMEDIATE');",
    "parentPort.postMessage('READY');parentPort.on('message',()=>{});",
  ].join('\n');
  const childSource = [
    'const native=require(process.argv[1]);',
    "const {Worker}=require('node:worker_threads');",
    'const worker=new Worker(' +
      JSON.stringify(workerSource) +
      ',{eval:true,resourceLimits:{maxOldGenerationSizeMb:64},workerData:{tsx:process.argv[2],module:process.argv[3],files:JSON.parse(process.argv[4])}});',
    "worker.once('error',error=>{console.error(error);process.exitCode=1;});",
    "worker.once('message',async()=>{await worker.terminate();try{native.assertLeaseAdmission();process.exitCode=1;}catch(error){if(error.code==='MITZO_OWNER_BUSY')process.stdout.write('LIFETIME_RETAINED');else{console.error(error);process.exitCode=1;}}});",
  ].join('\n');
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      childSource,
      require.resolve('@mitzo/sqlite-file-owner'),
      require.resolve('tsx/cjs/api'),
      new URL('../../packages/protocol/src/telos-sqlite-owners.ts', import.meta.url).pathname,
      JSON.stringify(files),
    ],
    { encoding: 'utf8', timeout: 5000, env: process.env },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('LIFETIME_RETAINED');
});
