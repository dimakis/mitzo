import { it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedDependencyStore } from '../prepare-development-host.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'host-store-')));
  t.after(async () => {
    async function writable(path) {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      await chmod(path, info.isDirectory() ? 0o755 : 0o644);
      if (info.isDirectory())
        for (const name of await readdir(path)) await writable(join(path, name));
    }
    await writable(root);
    await rm(root, { recursive: true });
  });
  const cwd = join(root, 'reviewed-source');
  const store = join(root, 'host-store');
  await mkdir(cwd);
  const calls = [];
  async function snapshot(source, build) {
    assert.equal(source, cwd);
    assert.ok(build.startsWith(join(store, '.builds') + '/'));
    await writeFile(join(build, 'package.json'), '{}');
    await writeFile(join(build, 'package-lock.json'), '{}');
  }
  async function prepare(options) {
    calls.push(options);
    assert.equal(options.dependencyStore, false);
    const bin = join(options.cwd, '.mitzo-devtools/toolchains/fixture/node_modules/.bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'node'), 'verified-node');
    await mkdir(join(options.cwd, 'node_modules'), { recursive: true });
    await writeFile(join(options.cwd, 'node_modules/.package-lock.json'), '{}');
    return {
      ready: true,
      platform: process.platform,
      arch: process.arch,
      abi: process.versions.modules,
      toolchainPath: bin,
    };
  }
  return { cwd, store, calls, snapshot, prepare };
}

it('seeds only from a fresh host-owned snapshot, verifies again, and cleans its own build', async (t) => {
  const f = await fixture(t);
  const result = await seedDependencyStore(f);
  assert.equal(result.status, 'published');
  assert.deepEqual(
    f.calls.map((call) => call.install),
    [true, false],
  );
  assert.deepEqual(await readdir(join(f.store, '.builds')), []);
  assert.deepEqual(await readdir(join(f.store, 'entries')), [result.key]);
});

it('does not publish a failed install or remove another retained build', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.store, '.builds', 'other-owner'), { recursive: true });
  await assert.rejects(
    seedDependencyStore({
      ...f,
      prepare: async () => {
        throw Error('native failure');
      },
    }),
    /native failure/,
  );
  assert.deepEqual(await readdir(join(f.store, '.builds')), ['other-owner']);
  await assert.rejects(readdir(join(f.store, 'entries')), { code: 'ENOENT' });
});
