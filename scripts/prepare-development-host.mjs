import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import process from 'node:process';
import console from 'node:console';
import { prepareDevelopment, DevelopmentSetupError } from './prepare-development.mjs';
import {
  dependencyStoreRoot,
  ownedDirectory,
  publishDependencySet,
  pruneDependencyStore,
  managedDependencyConsumers,
} from './lib/dependency-store.mjs';

// An operator runs this reviewed host script; ordinary tasks cannot write the
// fixed store root. No flag/environment variable turns a session into a writer.
async function snapshotCommit(cwd, build) {
  const archive = join(build, 'source.tar');
  const env = {
    PATH: process.env.PATH,
    HOME: build,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  await promisify(execFile)(
    'git',
    ['-C', cwd, 'archive', '--format=tar', '--output', archive, 'HEAD'],
    { env },
  );
  await promisify(execFile)('tar', ['-xf', archive, '-C', build], { env });
  await rm(archive);
}

export async function seedDependencyStore({
  cwd = process.cwd(),
  store = dependencyStoreRoot(),
  snapshot = snapshotCommit,
  prepare = prepareDevelopment,
  usageRoots,
} = {}) {
  cwd = await realpath(cwd);
  store = await ownedDirectory(store);
  const lock = join(store, '.setup');
  try {
    await mkdir(lock);
  } catch (cause) {
    if (cause.code === 'EEXIST')
      throw Object.assign(
        Error('Host dependency setup is already running; inspect its owner before recovery.'),
        { code: 'writer_busy' },
      );
    throw cause;
  }
  let build;
  let primary;
  let result;
  try {
    const builds = await ownedDirectory(store, join(store, '.builds'));
    build = await mkdtemp(join(builds, 'setup-'));
    await snapshot(cwd, build);
    // Always install into a fresh protected build, never attest a task's mutable
    // receipt/node_modules. The existing setup owns credential/cache isolation.
    const options = { cwd: build, install: true, dependencyStore: false };
    const ready = await prepare(options);
    if (!ready.ready || !ready.toolchainPath) throw Error('Host setup did not establish readiness');
    const published = await publishDependencySet({
      store,
      cwd: build,
      runtime: { platform: ready.platform, arch: ready.arch, abi: ready.abi },
      toolchain: relative(build, resolve(ready.toolchainPath, '../..')),
      verify: () => prepare({ ...options, install: false }),
    });
    const removed = await pruneDependencyStore({
      store,
      usageRoots: usageRoots ?? (await managedDependencyConsumers()),
    });
    result = { ...published, removed };
  } catch (cause) {
    primary = cause;
  } finally {
    // Only this invocation's mkdtemp and lock are eligible; preserve all other
    // builds/workspaces and never replace the primary error with cleanup noise.
    for (const path of [build, lock].filter(Boolean)) {
      try {
        await rm(path, { recursive: true });
      } catch (cause) {
        if (primary) primary.cleanupCode = cause.code;
        else primary = cause;
      }
    }
  }
  if (primary) throw primary;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {
    console.error(
      'Usage: npm run setup:dev:host (trusted host terminal, reviewed committed source)',
    );
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await seedDependencyStore()));
    } catch (cause) {
      console.error(
        JSON.stringify(
          cause instanceof DevelopmentSetupError
            ? cause.toJSON()
            : {
                ready: false,
                phase: 'host_dependency_store',
                reason: ['EACCES', 'EPERM'].includes(cause.code)
                  ? 'host_writer_required'
                  : cause.code === 'writer_busy'
                    ? 'writer_busy'
                    : 'host_setup_failed',
                message:
                  'Run the reviewed host setup outside task sandboxes; inspect the original operation before retrying.',
                ...(cause.cleanupCode ? { cleanupFailed: true } : {}),
              },
        ),
      );
      process.exitCode = 1;
    }
  }
}
