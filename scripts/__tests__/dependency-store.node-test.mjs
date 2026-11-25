import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  symlink,
  chmod,
  rm,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dependencyIdentity,
  publishDependencySet,
  restoreDependencySet,
  pruneDependencyStore,
} from '../lib/dependency-store.mjs';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const writable = async (path) => {
      const { lstat } = await import('node:fs/promises');
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      await chmod(path, info.isDirectory() ? 0o755 : 0o644);
      if (info.isDirectory())
        for (const name of await readdir(path)) await writable(join(path, name));
    };
    await writable(root);
    await rm(root, { recursive: true, force: true });
  }
});
const runtime = { platform: process.platform, arch: process.arch, abi: process.versions.modules };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dependency-store-')));
  roots.push(root);
  const store = join(root, 'store');
  const cwd = join(store, '.builds', 'trusted');
  const manifest = JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] });
  const lock = JSON.stringify({
    packages: {
      '': { name: 'fixture' },
      'packages/example': { name: '@mitzo/example' },
      'node_modules/@mitzo/example': { resolved: 'packages/example', link: true },
    },
  });
  const source = async (path) => {
    await mkdir(join(path, 'packages/example'), { recursive: true });
    await mkdir(join(path, 'packages/sqlite-file-owner'), { recursive: true });
    await writeFile(join(path, 'package.json'), manifest);
    await writeFile(join(path, 'package-lock.json'), lock);
    await writeFile(join(path, 'packages/example/package.json'), '{"name":"@mitzo/example"}');
    await writeFile(join(path, 'packages/sqlite-file-owner/owner.cc'), 'native-source');
  };
  await source(cwd);
  await mkdir(join(cwd, 'node_modules/@mitzo'), { recursive: true });
  await writeFile(join(cwd, 'node_modules/.package-lock.json'), lock);
  await writeFile(join(cwd, 'node_modules/value'), 'original');
  await symlink('../../packages/example', join(cwd, 'node_modules/@mitzo/example'));
  const target = join(root, 'session');
  await source(target);
  const toolchain = '.mitzo-devtools/toolchains/fixture';
  await mkdir(join(cwd, toolchain), { recursive: true });
  await writeFile(join(cwd, toolchain, 'receipt.json'), 'verified-toolchain');
  await mkdir(join(cwd, 'packages/sqlite-file-owner/build/Release'), { recursive: true });
  await writeFile(join(cwd, 'packages/sqlite-file-owner/build/Release/addon.node'), 'native');
  const publish = () =>
    publishDependencySet({ store, cwd, runtime, toolchain, verify: async () => ({ ready: true }) });
  return { root, store, cwd, target, source, toolchain, publish };
}

it('clones a verified entry privately with session-local workspace links and native output', async () => {
  const f = await fixture();
  const entry = await f.publish();
  const start = performance.now();
  const restored = await restoreDependencySet({ store: f.store, cwd: f.target });
  assert.equal(restored.status, 'hit');
  assert.equal(restored.key, entry.key);
  assert.ok(performance.now() - start < 60_000);
  assert.equal(
    await realpath(join(f.target, 'node_modules/@mitzo/example')),
    join(f.target, 'packages/example'),
  );
  const second = join(f.root, 'second');
  await f.source(second);
  await restoreDependencySet({ store: f.store, cwd: second });
  await writeFile(join(f.target, 'node_modules/value'), 'session-only');
  assert.equal(await readFile(join(second, 'node_modules/value'), 'utf8'), 'original');
  assert.equal(
    await readFile(join(f.store, 'entries', entry.key, 'payload/node_modules/value'), 'utf8'),
    'original',
  );
  assert.equal(
    await readFile(join(f.target, 'packages/sqlite-file-owner/build/Release/addon.node'), 'utf8'),
    'native',
  );
});

it('keys the lockfile, runtime and native workspace source, excluding generated output', async () => {
  const f = await fixture();
  const key = await dependencyIdentity(f.cwd, runtime);
  await writeFile(join(f.cwd, 'packages/sqlite-file-owner/build/Release/addon.node'), 'rebuilt');
  assert.equal(await dependencyIdentity(f.cwd, runtime), key);
  assert.notEqual(await dependencyIdentity(f.cwd, { ...runtime, abi: 'different' }), key);
  await writeFile(join(f.cwd, 'packages/sqlite-file-owner/owner.cc'), 'changed-source');
  assert.notEqual(await dependencyIdentity(f.cwd, runtime), key);
});

it('refuses promotion from session-owned paths and failed verification', async () => {
  const f = await fixture();
  await assert.rejects(
    publishDependencySet({
      store: f.store,
      cwd: f.target,
      runtime,
      toolchain: f.toolchain,
      verify: async () => ({ ready: true }),
    }),
    { code: 'untrusted_build' },
  );
  await assert.rejects(
    publishDependencySet({
      store: f.store,
      cwd: f.cwd,
      runtime,
      toolchain: f.toolchain,
      verify: async () => {
        throw Error('native probe failed');
      },
    }),
    /native probe failed/,
  );
  assert.equal((await restoreDependencySet({ store: f.store, cwd: f.target })).status, 'miss');
});

it('rejects external links, corrupted contents and redirected session destinations', async () => {
  const f = await fixture();
  await symlink('/etc/passwd', join(f.cwd, 'node_modules/escape'));
  await assert.rejects(f.publish(), { code: 'unsafe_link' });
  assert.ok(!(await readdir(f.store)).some((name) => name.startsWith('.pending-')));
  await rm(join(f.cwd, 'node_modules/escape'));
  const entry = await f.publish();
  const file = join(f.store, 'entries', entry.key, 'payload/node_modules/value');
  await chmod(file, 0o644);
  await writeFile(file, 'corrupt');
  const result = await restoreDependencySet({ store: f.store, cwd: f.target });
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'integrity_mismatch');
  await assert.rejects(readFile(join(f.target, 'node_modules/value')), { code: 'ENOENT' });
});

it('prunes only owned entries by host-recorded LRU with a finite entry/age bound', async () => {
  const f = await fixture();
  const first = await f.publish();
  await writeFile(join(f.cwd, 'package-lock.json'), '{"packages":{}}');
  const second = await f.publish();
  const unrelated = join(f.store, 'keep-user-data');
  await writeFile(unrelated, 'keep');
  await pruneDependencyStore({ store: f.store, maxEntries: 1, maxAgeMs: 30 * 86400_000 });
  assert.deepEqual(await readdir(join(f.store, 'entries')), [second.key]);
  assert.notEqual(second.key, first.key);
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');
});

it('rejects malformed metadata before replacing task files', async () => {
  const f = await fixture();
  const entry = await f.publish();
  const path = join(f.store, 'entries', entry.key, 'entry.json');
  const metadata = JSON.parse(await readFile(path, 'utf8'));
  await chmod(path, 0o644);
  metadata.parts = ['.mitzo-devtools/toolchains/../../package.json'];
  await writeFile(path, JSON.stringify(metadata));
  const before = await readFile(join(f.target, 'package.json'), 'utf8');
  const result = await restoreDependencySet({ store: f.store, cwd: f.target });
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'invalid_entry');
  assert.equal(await readFile(join(f.target, 'package.json'), 'utf8'), before);
});

it('refuses symlinked install destinations without changing their target', async () => {
  const f = await fixture();
  await f.publish();
  const outside = join(f.root, 'other-session');
  await mkdir(outside);
  await writeFile(join(outside, 'keep'), 'original');
  await symlink(outside, join(f.target, 'node_modules'));
  await assert.rejects(restoreDependencySet({ store: f.store, cwd: f.target }), {
    code: 'redirected_directory',
  });
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'original');
});

it('retains the recently read entry and expires old entries without touching other data', async () => {
  const f = await fixture();
  const first = await f.publish();
  await writeFile(join(f.cwd, 'package-lock.json'), '{"packages":{}}');
  await f.publish();
  assert.equal((await restoreDependencySet({ store: f.store, cwd: f.target })).status, 'hit');
  await pruneDependencyStore({ store: f.store, maxEntries: 1, usageRoots: [f.target] });
  assert.deepEqual(await readdir(join(f.store, 'entries')), [first.key]);
  await pruneDependencyStore({ store: f.store, now: Date.now() + 31 * 86400_000 });
  assert.deepEqual(await readdir(join(f.store, 'entries')), []);
});
it('restores the host build modes that the copied toolchain receipt hashes', async () => {
  const f = await fixture();
  // A host installation created under umask 077.
  await chmod(join(f.cwd, f.toolchain, 'receipt.json'), 0o600);
  await chmod(join(f.cwd, f.toolchain), 0o700);
  await f.publish();
  assert.equal((await restoreDependencySet({ store: f.store, cwd: f.target })).status, 'hit');
  const mode = async (path) => (await lstat(join(f.target, path))).mode & 0o777;
  assert.equal(await mode(f.toolchain), 0o700);
  assert.equal(await mode(`${f.toolchain}/receipt.json`), 0o600);
  assert.equal(await mode('node_modules/value'), 0o644 & ~process.umask());
});

it('refreshes host usage when re-publishing so retention keeps the verified identity', async () => {
  const f = await fixture();
  const old = Date.now() - 40 * 86400_000;
  const entry = await publishDependencySet({
    store: f.store,
    cwd: f.cwd,
    runtime,
    toolchain: f.toolchain,
    verify: async () => ({ ready: true }),
    now: old,
  });
  const republished = await f.publish();
  assert.equal(republished.key, entry.key);
  assert.deepEqual(await pruneDependencyStore({ store: f.store }), []);
  assert.deepEqual(await readdir(join(f.store, 'entries')), [entry.key]);
});

it('does not block on a task-planted FIFO usage receipt', async () => {
  const f = await fixture();
  await f.publish();
  await mkdir(join(f.target, '.mitzo-devtools'), { recursive: true });
  await promisify(execFile)('mkfifo', [
    join(f.target, '.mitzo-devtools/dependency-store-use.json'),
  ]);
  const outcome = await Promise.race([
    pruneDependencyStore({ store: f.store, usageRoots: [f.target] }).then(() => 'completed'),
    new Promise((settle) => setTimeout(() => settle('blocked'), 5_000).unref()),
  ]);
  assert.equal(outcome, 'completed');
  await assert.rejects(lstat(join(f.store, '.writer')), { code: 'ENOENT' });
});

it('falls back to the isolated install when an entry payload is removed', async () => {
  const f = await fixture();
  const entry = await f.publish();
  const payload = join(f.store, 'entries', entry.key, 'payload');
  await chmod(join(f.store, 'entries', entry.key), 0o755);
  const writable = async (path) => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    await chmod(path, info.isDirectory() ? 0o755 : 0o644);
    if (info.isDirectory())
      for (const name of await readdir(path)) await writable(join(path, name));
  };
  await writable(payload);
  await rm(payload, { recursive: true });
  const result = await restoreDependencySet({ store: f.store, cwd: f.target });
  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'entry_removed');
  await assert.rejects(readFile(join(f.target, 'node_modules/value')), { code: 'ENOENT' });
});

it('skips schema 1 entries on restore and retention removes them', async () => {
  const f = await fixture();
  const entry = await f.publish();
  const path = join(f.store, 'entries', entry.key, 'entry.json');
  const metadata = JSON.parse(await readFile(path, 'utf8'));
  await chmod(path, 0o644);
  await writeFile(path, JSON.stringify({ ...metadata, schema: 1, modes: undefined }));
  assert.equal((await restoreDependencySet({ store: f.store, cwd: f.target })).status, 'miss');
  assert.deepEqual(await pruneDependencyStore({ store: f.store }), [entry.key]);
});
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat } from 'node:fs/promises';
import { setTimeout } from 'node:timers';
