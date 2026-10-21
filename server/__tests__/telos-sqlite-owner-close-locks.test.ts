import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import {
  createFreshTelosDatabaseFiles,
  openTelosOwnedDatabase,
  type TelosOwnedDatabase,
} from '../../packages/protocol/src/telos-sqlite-owners.js';
const require = createRequire(import.meta.url);
const sqlite = require.resolve('better-sqlite3');
const roots: string[] = [];
const owners: TelosOwnedDatabase[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("closing a second real owner cannot release another owner's actual SQLite writer locks", () => {
  const root = mkdtempSync(join(tmpdir(), 'telos-close-locks-'));
  roots.push(root);
  const files = {
    canonical: join(root, 'canonical.db'),
    events: join(root, 'events.db'),
    tasks: join(root, 'tasks.db'),
  };
  createFreshTelosDatabaseFiles(files);
  const first = openTelosOwnedDatabase('canonical', files.canonical, {}, files);
  owners.push(first);
  first.database.pragma('journal_mode=WAL');
  first.database.exec('CREATE TABLE evidence(value TEXT)');
  first.seal();
  const second = openTelosOwnedDatabase('canonical', files.canonical, {}, files);
  owners.push(second);
  second.database.prepare('SELECT * FROM evidence').all();
  second.seal();
  first.database.exec('BEGIN IMMEDIATE');
  second.close();
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const Database=require(process.argv[1]); const db=new Database(process.argv[2],{timeout:0});
    try { db.exec("INSERT INTO evidence VALUES ('independent writer')"); process.stdout.write('WROTE'); }
    catch(error) { process.stdout.write(String(error.code)); process.exitCode=23; }
    finally { db.close(); }
  `,
      sqlite,
      files.canonical,
    ],
    { encoding: 'utf8', timeout: 5000, env: process.env },
  );
  expect(result.status).toBe(23);
  expect(result.stdout).toBe('SQLITE_BUSY');
  first.database.exec('ROLLBACK');
  expect(first.database.prepare('SELECT * FROM evidence').all()).toEqual([]);
});

it('rejects a worker family before its error cleanup can drop a retained canonical writer lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telos-worker-close-locks-'));
  roots.push(root);
  const files = {
    canonical: join(root, 'canonical.db'),
    events: join(root, 'events.db'),
    tasks: join(root, 'tasks.db'),
  };
  createFreshTelosDatabaseFiles(files);
  const first = openTelosOwnedDatabase('canonical', files.canonical, {}, files);
  owners.push(first);
  // Use the actual rollback-mode writer here to detect the auxiliary MAIN fd close.
  // This mode itself grants no deletion authority.
  first.database.exec('CREATE TABLE evidence(value TEXT)');
  first.seal();
  first.database.exec('BEGIN IMMEDIATE');
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    require(workerData.tsx).register();
    const { openTelosOwnedDatabase } = require(workerData.ownerModule);
    try {
      const owner = openTelosOwnedDatabase('canonical', workerData.files.canonical, {timeout:0}, workerData.files);
      owner.seal(); owner.close(); parentPort.postMessage('closed');
    } catch (error) { parentPort.postMessage({ error: String(error.message) }); }
  `,
    {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 64 },
      workerData: {
        tsx: require.resolve('tsx/cjs/api'),
        ownerModule: new URL('../../packages/protocol/src/telos-sqlite-owners.ts', import.meta.url)
          .pathname,
        files,
      },
    },
  );
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    expect(result).toEqual({ error: 'Owner leases require the process main thread' });
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const Database=require(process.argv[1]); const db=new Database(process.argv[2],{timeout:0});
      try { db.exec("INSERT INTO evidence VALUES ('independent writer')"); }
      catch(error) { process.stdout.write(String(error.code)); process.exitCode=23; }
      finally { db.close(); }
    `,
        sqlite,
        files.canonical,
      ],
      { encoding: 'utf8', timeout: 5000, env: process.env },
    );
    expect(probe.status).toBe(23);
    expect(probe.stdout).toBe('SQLITE_BUSY');
  } finally {
    await worker.terminate();
    first.database.exec('ROLLBACK');
  }
});

it('cannot leave an untracked worker writer alive after the last managed family closes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'telos-inverse-worker-locks-'));
  roots.push(root);
  const files = {
    canonical: join(root, 'canonical.db'),
    events: join(root, 'events.db'),
    tasks: join(root, 'tasks.db'),
  };
  createFreshTelosDatabaseFiles(files);
  const first = openTelosOwnedDatabase('canonical', files.canonical, {}, files);
  owners.push(first);
  first.database.exec('CREATE TABLE evidence(value TEXT)');
  first.seal();
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    require(workerData.tsx).register();
    const { openTelosOwnedDatabase } = require(workerData.ownerModule);
    try {
      const owner = openTelosOwnedDatabase('canonical',workerData.files.canonical,{timeout:0},workerData.files);
      owner.seal(); owner.database.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('UNTRACKED_WRITER');
      parentPort.on('message',()=>{owner.database.exec('ROLLBACK');owner.close();process.exit(0);});
    } catch (error) { parentPort.postMessage({denied:error.code}); }
  `,
    {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 64 },
      workerData: {
        tsx: require.resolve('tsx/cjs/api'),
        ownerModule: new URL('../../packages/protocol/src/telos-sqlite-owners.ts', import.meta.url)
          .pathname,
        files,
      },
    },
  );
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    first.close();
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        `const Database=require(process.argv[1]);const db=new Database(process.argv[2],{timeout:0});try{db.exec("INSERT INTO evidence VALUES ('inverse writer')");}catch(e){process.stdout.write(String(e.code));process.exitCode=23;}finally{db.close();}`,
        sqlite,
        files.canonical,
      ],
      { encoding: 'utf8', timeout: 5000, env: process.env },
    );
    if (result === 'UNTRACKED_WRITER') expect(probe.status).toBe(23);
    else expect(probe.status).toBe(0);
    expect(result).toEqual({ denied: 'MITZO_OWNER_UNSUPPORTED' });
  } finally {
    await worker.terminate();
  }
});
