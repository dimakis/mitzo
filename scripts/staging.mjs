#!/usr/bin/env node
import process from 'node:process';
import console from 'node:console';
import { setTimeout } from 'node:timers';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  stagingBoundary,
  compareStage,
  promoteStage,
  assertPinnedStageSource,
  assertStageCandidate,
} from './lib/staging-operations.mjs';
import {
  privateJson,
  replacePrivateJson,
  fingerprintDirectory,
  artifacts,
  stageDirectory,
  appendAudit,
} from './lib/staging-files.mjs';
import { assertStageJob } from './lib/staging-job.mjs';
const repo = 'https://github.com/dimakis/mitzo.git',
  root = join(homedir(), '.local/share/mitzo-staging'),
  label = 'com.mitzo.staging';
const receiptPath = join(root, 'service/release-receipt.json');
const args = process.argv.slice(2),
  command = args.shift();
if (command === '--help' || !command) {
  console.log(
    'staging check [--offline]\nstaging prepare --commit SHA\nstaging deploy --commit SHA --expected-current SHA [--apply]',
  );
  process.exit(0);
}
if (!['check', 'prepare', 'deploy'].includes(command)) throw Error('Unsupported staging command');
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (['--offline', '--apply'].includes(args[i])) flags[args[i]] = true;
  else if (['--commit', '--expected-current'].includes(args[i]) && args[i + 1])
    flags[args[i]] = args[++i];
  else throw Error('Unknown staging argument');
}
if (process.platform !== 'darwin') throw Error('This host controller supports macOS launchd only');
if (realpathSync(root) !== root) throw Error('Canonical staging root required');
for (const name of ['service', 'settings', 'workspace', 'state', 'home', 'releases'])
  stageDirectory(root, name);
const env = {
  PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: join(root, 'home'),
  TMPDIR: '/private/tmp',
  LANG: 'en_US.UTF-8',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
};
function run(program, argv, cwd = root) {
  if (program === 'git')
    argv = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...argv];
  const p = spawnSync(program, argv, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (p.status !== 0) throw Error('Staging command failed: ' + program);
  return p.stdout.trim();
}
function hash(data) {
  return createHash('sha256').update(data).digest('hex');
}
function canonicalMap(map) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1))),
  );
}
function current() {
  const r = privateJson(receiptPath);
  stagingBoundary({ ...r, root });
  return r;
}
function main() {
  const value = run('git', ['ls-remote', repo, 'refs/heads/main']).split(/\s+/)[0];
  if (!/^[a-f0-9]{40}$/.test(value)) throw Error('Fresh main identity unavailable');
  return value;
}
function portPids(port) {
  const p = spawnSync('/usr/sbin/lsof', ['-t', '-iTCP:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  if (p.status === 1) return [];
  if (p.status !== 0) throw Error('Listener inventory unavailable');
  return [...new Set(p.stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
}
function job() {
  const text = run('launchctl', ['print', 'gui/' + process.getuid() + '/' + label]);
  const match = text.match(/^\s*pid = (\d+)$/m);
  if (!match) return { pid: null };
  const pid = Number(match[1]);
  const names = run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    .split('\n')
    .filter((v) => v.startsWith('n'));
  if (names.length !== 1) throw Error('Stage process directory unavailable');
  return {
    pid,
    cwd: names[0].slice(1),
    portPids: portPids(3190),
    protectedPids: [...portPids(3100), ...portPids(3101)],
  };
}
function audit(event) {
  stageDirectory(root, 'service');
  appendAudit(join(root, 'service/deployment-audit.jsonl'), {
    at: new Date().toISOString(),
    ...event,
  });
}
function validateRelease(r, freshMain) {
  stageDirectory(r.release, '.git');
  stagingBoundary({ ...r, root });
  if (realpathSync(r.release) !== r.release) throw Error('Release path alias refused');
  if (
    run('git', ['rev-parse', 'HEAD'], r.release) !== r.sourceCommit ||
    run('git', ['rev-parse', 'HEAD^{tree}'], r.release) !== r.sourceTree ||
    run('git', ['status', '--porcelain', '--untracked-files=no'], r.release)
  )
    throw Error('Release source drift');
  if (freshMain && r.sourceCommit !== freshMain)
    throw Error('Candidate is not exact current accepted main');
  if (hash(canonicalMap(artifacts(r.release))) !== hash(canonicalMap(r.compiledArtifacts)))
    throw Error('Release artifact drift');
  if (
    r.dependencyFingerprint &&
    fingerprintDirectory(r.release, 'node_modules') !== r.dependencyFingerprint
  )
    throw Error('Release dependency drift');
  assertPinnedStageSource({
    expected: r.sourceCommit,
    expectedTree: r.sourceTree,
    source: run('git', ['rev-parse', 'HEAD'], r.release),
    tree: run('git', ['rev-parse', 'HEAD^{tree}'], r.release),
    dirty: run('git', ['status', '--porcelain', '--untracked-files=no'], r.release),
    origin: run('git', ['remote', 'get-url', 'origin'], r.release),
    acceptedAncestor:
      spawnSync(
        'git',
        [
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.hooksPath=/dev/null',
          'merge-base',
          '--is-ancestor',
          r.sourceCommit,
          'refs/remotes/origin/main',
        ],
        { cwd: r.release, env },
      ).status === 0,
  });
}
function candidate(commit) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw Error('Exact target commit required');
  return join(root, 'releases', commit.slice(0, 12));
}
async function check() {
  const r = current();
  let source = r.sourceCommit,
    artifactOK,
    dependencyOK = Boolean(r.dependencyFingerprint),
    runtimeOK = true;
  try {
    validateRelease(r);
    source = run('git', ['rev-parse', 'HEAD'], r.release);
    if (
      run('git', ['status', '--porcelain', '--untracked-files=no'], r.release) ||
      run('git', ['rev-parse', 'HEAD^{tree}'], r.release) !== r.sourceTree
    )
      source = null;
    artifactOK =
      hash(canonicalMap(artifacts(r.release))) === hash(canonicalMap(r.compiledArtifacts));
    if (r.dependencyFingerprint)
      dependencyOK = fingerprintDirectory(r.release, 'node_modules') === r.dependencyFingerprint;
  } catch {
    artifactOK = false;
    dependencyOK = false;
  }
  try {
    assertStageJob(job(), r);
  } catch {
    runtimeOK = false;
  }
  const freshMain = flags['--offline'] ? null : main();
  const result = compareStage({
    expected: r.sourceCommit,
    main: freshMain ?? r.sourceCommit,
    source,
    artifacts: artifactOK,
    dependencies: dependencyOK,
    runtime: runtimeOK,
    locked: Boolean(lstatSync(join(root, 'service/deployment.lock'), { throwIfNoEntry: false })),
  });
  console.log(
    JSON.stringify({
      url: 'http://mitzo-staging.localhost:3190',
      expected: r.sourceCommit,
      main: freshMain,
      mainChecked: !flags['--offline'],
      ...result,
      providerSetup: 'separate setup required',
      productionActions: [],
    }),
  );
  if (!result.safe) process.exitCode = 1;
}
async function prepare() {
  const target = flags['--commit'],
    final = candidate(target),
    active = current(),
    freshMain = main();
  if (target !== freshMain) throw Error('Preparation requires exact current accepted main');
  if (existsSync(final)) throw Error('Release already exists; inspect it instead of overwriting');
  validateRelease(active);
  const attempt = join(root, 'releases', '.prepare-' + randomUUID());
  audit({ phase: 'build_intent', target, attempt });
  run('git', ['clone', '--no-checkout', repo, attempt]);
  run('git', ['checkout', '--detach', target], attempt);
  if (
    hash(readFileSync(join(active.release, 'package-lock.json'))) !==
    hash(readFileSync(join(attempt, 'package-lock.json')))
  )
    throw Error(
      'Dependency lock changed; independently provision audited dependencies before preparation',
    );
  const before = fingerprintDirectory(active.release, 'node_modules');
  cpSync(join(active.release, 'node_modules'), join(attempt, 'node_modules'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  if (fingerprintDirectory(attempt, 'node_modules') !== before)
    throw Error('Dependency copy changed');
  run('npm', ['run', 'build:server'], attempt);
  run('npm', ['run', 'build'], attempt);
  if (fingerprintDirectory(active.release, 'node_modules') !== before)
    throw Error('Dependency source changed during preparation');
  if (main() !== target) throw Error('Main advanced during build; preserve candidate and re-plan');
  const tree = run('git', ['rev-parse', 'HEAD^{tree}'], attempt);
  writeFileSync(
    join(attempt, 'release.txt'),
    'source_commit=' + target + '\nbase_main=' + target + '\nsource_tree=' + tree + '\n',
  );
  renameSync(attempt, final);
  const r = {
    ...active,
    release: final,
    sourceCommit: target,
    sourceTree: tree,
    compiledArtifacts: artifacts(final),
    dependencyFingerprint: fingerprintDirectory(final, 'node_modules'),
  };
  const path = join(final, 'staging-release.json');
  writeFileSync(path, JSON.stringify(r, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  validateRelease(r, target);
  audit({ phase: 'prepared', target, release: final });
  console.log(
    JSON.stringify({ prepared: final, source: target, started: false, productionActions: [] }),
  );
}
async function deploy() {
  const target = flags['--commit'],
    expected = flags['--expected-current'],
    path = candidate(target);
  if (!/^[a-f0-9]{40}$/.test(expected ?? '')) throw Error('Exact expected-current commit required');
  const active = current(),
    next = privateJson(join(path, 'staging-release.json'));
  assertStageCandidate(next, target, path);
  validateRelease(next, main());
  const originalJob = job();
  assertStageJob(originalJob, active);
  if (active.sourceCommit !== expected) throw Error('Current stage changed since plan');
  const id = randomUUID(),
    backup = join(root, 'service/deployments', id);
  if (!flags['--apply']) {
    console.log(
      JSON.stringify({
        plan: { current: expected, target, backup, service: label },
        apply: false,
        productionActions: [],
      }),
    );
    return;
  }
  // The command and its support modules must match accepted main before they can control deployment.
  for (const name of [
    'scripts/staging.mjs',
    'scripts/lib/staging-operations.mjs',
    'scripts/lib/staging-files.mjs',
    'scripts/lib/staging-job.mjs',
    'scripts/lib/staging-launcher-template.mjs',
  ]) {
    const installed = new URL(name.replace('scripts/', ''), import.meta.url);
    const p = fileURLToPath(installed);
    if (
      !existsSync(join(path, name)) ||
      hash(readFileSync(p)) !== hash(readFileSync(join(path, name)))
    )
      throw Error('Controller is not identical to accepted candidate source');
  }
  const lock = join(root, 'service/deployment.lock');
  let lockFd;
  await promoteStage(
    { expectedCurrent: expected, target },
    {
      lock: async () => {
        lockFd = openSync(lock, 'wx', 0o600);
        writeFileSync(lockFd, JSON.stringify({ id, expected, target }) + '\n');
        fsyncSync(lockFd);
      },
      unlock: async () => {
        closeSync(lockFd);
        unlinkSync(lock);
      },
      audit: async (event) => audit({ id, ...event }),
      validate: async () => {
        assertStageCandidate(next, target, path);
        validateRelease(next, main());
        validateRelease(active);
        assertStageJob(job(), active, originalJob.pid);
      },
      current: async () => current().sourceCommit,
      stop: async () => {
        assertStageJob(job(), active, originalJob.pid);
        run('launchctl', ['kill', 'SIGTERM', 'gui/' + process.getuid() + '/' + label]);
        const deadline = Date.now() + 180000;
        while (Date.now() < deadline) {
          const status = job();
          if (!status.pid && portPids(3190).length === 0) return;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw Error('Original stage shutdown uncertain');
      },
      snapshot: async () => {
        stageDirectory(root, 'service/deployments/' + id, true);
        for (const directory of ['workspace', 'state'])
          cpSync(join(root, directory), join(backup, directory), {
            recursive: true,
            verbatimSymlinks: true,
          });
        writeFileSync(join(backup, 'previous-release.json'), JSON.stringify(active) + '\n', {
          mode: 0o600,
        });
      },
      activate: async () => {
        replacePrivateJson(receiptPath, next);
        stageDirectory(root, 'service/control-lib', true);
        cpSync(
          new URL('./lib/staging-files.mjs', import.meta.url),
          join(root, 'service/control-lib/staging-files.mjs'),
        );
        cpSync(
          new URL('./lib/staging-operations.mjs', import.meta.url),
          join(root, 'service/control-lib/staging-operations.mjs'),
        );
        const launcher = readFileSync(
          new URL('./lib/staging-launcher-template.mjs', import.meta.url),
        );
        const temporary = join(root, 'service/start.mjs.' + id);
        writeFileSync(temporary, launcher, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, join(root, 'service/start.mjs'));
      },
      start: async () => {
        writeFileSync(
          join(root, 'service/launch-permit.json'),
          JSON.stringify({ id, target, expiresAt: Date.now() + 15000 }) + '\n',
          { flag: 'wx', mode: 0o600 },
        );
        run('launchctl', ['kickstart', 'gui/' + process.getuid() + '/' + label]);
      },
      verify: async () => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          try {
            assertStageJob(job(), next);
            const response = await globalThis.fetch('http://127.0.0.1:3190', {
              signal: globalThis.AbortSignal.timeout(2000),
            });
            if (response.ok) return;
          } catch {
            /* Keep the same bounded verification deadline; no second start. */
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw Error('New stage verification uncertain; no automatic rollback');
      },
    },
  );
  console.log(
    JSON.stringify({ deployed: target, id, backup, verified: true, productionActions: [] }),
  );
}
try {
  await { check, prepare, deploy }[command]();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
