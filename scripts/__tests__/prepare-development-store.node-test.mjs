import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { prepareDevelopment } from '../prepare-development.mjs';
import { publishDependencySet } from '../lib/dependency-store.mjs';

const roots = [];
afterEach(async () => {
  const remove = async (path) => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    await chmod(path, info.isDirectory() ? 0o755 : 0o644);
    if (info.isDirectory()) for (const name of await readdir(path)) await remove(join(path, name));
  };
  for (const root of roots.splice(0)) {
    await remove(root);
    await rm(root, { recursive: true });
  }
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'development-store-')));
  roots.push(root);
  const store = join(root, 'store');
  const cwd = join(store, '.builds', 'trusted');
  async function source(path) {
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, 'package.json'),
      JSON.stringify({ engines: { node: '>=24', npm: '>=11.18.0' } }),
    );
    await writeFile(join(path, 'package-lock.json'), '{}');
  }
  await source(cwd);
  const calls = [];
  let offline = false;
  let brokenProbe = false;
  async function run(command, args, options) {
    calls.push({ command, args, env: options.env });
    if (['install', 'ci'].includes(args[0]) && offline) throw Error('Network access attempted');
    if (args[0] === 'install') {
      const toolchain = args[args.indexOf('--prefix') + 1];
      await mkdir(join(toolchain, 'node_modules/.bin'), { recursive: true });
      for (const name of ['node', 'npm'])
        await writeFile(join(toolchain, 'node_modules/.bin', name), name);
      await mkdir(join(toolchain, 'node_modules/npm/lib'), { recursive: true });
      await writeFile(join(toolchain, 'node_modules/npm/lib/index.js'), 'verified-npm');
      await writeFile(join(toolchain, 'package-lock.json'), '{}');
    }
    if (args[0] === 'ci') {
      await mkdir(join(options.cwd, 'node_modules'), { recursive: true });
      await writeFile(join(options.cwd, 'node_modules/.package-lock.json'), 'verified-tree');
      brokenProbe = false;
    }
    if (args[0] === '-e' && brokenProbe) throw Error('native probe failed');
    return {
      stdout:
        args[0] === '-p'
          ? JSON.stringify({
              platform: process.platform,
              arch: process.arch,
              abi: process.versions.modules,
            })
          : args[0] === '--version'
            ? command.endsWith('npm')
              ? '11.18.0'
              : 'v24.10.0'
            : '',
      stderr: '',
    };
  }
  const options = {
    cwd,
    run,
    install: true,
    dependencyStore: store,
    freeBytes: async () => 8 * 1024 ** 3,
  };
  return {
    root,
    cwd,
    store,
    source,
    calls,
    options,
    goOffline: () => {
      offline = true;
    },
    breakProbe: () => {
      brokenProbe = true;
    },
  };
}

it('preserves only the sandbox loopback proxy while excluding unrelated credentials', async () => {
  const f = await fixture();
  const previous = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  process.env.HTTPS_PROXY = 'http://session:private-proxy-token@localhost:43123';
  process.env.OPENAI_API_KEY = 'must-not-reach-npm';
  try {
    await prepareDevelopment(f.options);
    const install = f.calls.find(({ args }) => args[0] === 'ci');
    assert.equal(install.env.HTTPS_PROXY, process.env.HTTPS_PROXY);
    assert.equal(install.env.OPENAI_API_KEY, undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

it('a verified host miss becomes an offline hit in a fresh task, including its toolchain', async () => {
  const f = await fixture();
  const first = await prepareDevelopment(f.options);
  assert.equal(first.dependencyStore.status, 'miss');
  await publishDependencySet({
    store: f.store,
    cwd: f.cwd,
    runtime: { platform: first.platform, arch: first.arch, abi: first.abi },
    toolchain: relative(f.cwd, resolve(first.toolchainPath, '../..')),
    verify: () => prepareDevelopment({ ...f.options, install: false }),
  });
  const target = join(f.root, 'session');
  await f.source(target);
  f.calls.length = 0;
  f.goOffline();
  const started = performance.now();
  const result = await prepareDevelopment({ ...f.options, cwd: target });
  assert.equal(result.ready, true);
  assert.equal(result.dependencyStore.status, 'hit');
  assert.ok(performance.now() - started < 60_000);
  assert.ok(!f.calls.some(({ args }) => ['ci', 'install'].includes(args[0])));
  assert.ok(f.calls.some(({ args }) => args[0] === '-e'));
  assert.ok(
    JSON.parse(await readFile(join(target, '.mitzo-devtools/readiness.json'), 'utf8'))
      .installationIdentity,
  );
});

it('a failed cache native probe falls back to the isolated install and reports the rejection', async () => {
  const f = await fixture();
  const first = await prepareDevelopment(f.options);
  await publishDependencySet({
    store: f.store,
    cwd: f.cwd,
    runtime: { platform: first.platform, arch: first.arch, abi: first.abi },
    toolchain: relative(f.cwd, resolve(first.toolchainPath, '../..')),
    verify: () => prepareDevelopment({ ...f.options, install: false }),
  });
  const target = join(f.root, 'session');
  await f.source(target);
  f.calls.length = 0;
  f.breakProbe();
  const result = await prepareDevelopment({ ...f.options, cwd: target });
  assert.equal(result.ready, true);
  assert.equal(result.dependencyStore.status, 'rejected');
  assert.equal(result.dependencyStore.reason, 'native_probe_failed');
  assert.equal(f.calls.filter(({ args }) => args[0] === 'ci').length, 1);
});
