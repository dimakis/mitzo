#!/usr/bin/env node
// Initial ordinary-to-owned transition only. Preparation never controls launchd.
import process from 'node:process';
import console from 'node:console';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  realpathSync,
  readdirSync,
  cpSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { fingerprintDirectory } from './lib/staging-files.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { readOwnedReleasePlan, verifyOwnedRelease } from '../dist/symposium-owned-release.js';
import {
  assertCanonicalStagingService,
  canonicalStagingRoot,
  readStagingOperatorEnvironment,
} from '../dist/symposium-staging-service.js';
import {
  observeCanonicalProcess,
  readCanonicalPrivateJson,
} from '../dist/symposium-canonical-owner-record.js';
import {
  assertOrdinaryOwner,
  assertAcceptedTransition,
  transitionStage,
} from './lib/symposium-staging-transition.mjs';
const root = canonicalStagingRoot(),
  service = join(root, 'service'),
  owned = join(root, 'symposium/service');
const job = 'gui/' + process.getuid() + '/com.mitzo.staging';
const lockPath = join(service, 'deployment.lock'),
  receiptPath = join(service, 'release-receipt.json');
const intentPath = join(owned, 'transition.json'),
  topologyPath = join(service, 'topology.json');
const controllerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const env = {
  PATH: '/opt/homebrew/bin:/usr/bin:/bin',
  HOME: join(root, 'home'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function run(program, args, cwd = root) {
  if (program === 'git')
    args = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args];
  const p = spawnSync(program, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  if (p.status !== 0) throw Error('Transition command refused: ' + program);
  return p.stdout.trim();
}
function absent(path) {
  if (lstatSync(path, { throwIfNoEntry: false }))
    throw Error('Existing evidence requires investigation: ' + path);
}
function directory(path, privateDirectory = false) {
  const s = lstatSync(path);
  if (
    !s.isDirectory() ||
    (privateDirectory && (s.mode & 0o777) !== 0o700) ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid() ||
    realpathSync(path) !== path
  )
    throw Error('Private unaliased directory required');
}
function bytes(path, privateFile = true) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid() ||
      s.nlink !== 1 ||
      (privateFile && (s.mode & 0o777) !== 0o600)
    )
      throw Error('Original file identity refused');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncParent(path) {
  const fd = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function exclusive(path, value) {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncParent(path);
}
function portPids(port) {
  const p = spawnSync('/usr/sbin/lsof', ['-t', '-iTCP:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  if (p.status === 1) return [];
  if (p.status !== 0) throw Error('Listener inventory unavailable');
  return [...new Set(p.stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
}
function jobPid() {
  const text = run('/bin/launchctl', ['print', job]);
  if (!text.includes('path = ' + join(service, 'com.mitzo.staging.plist')))
    throw Error('Original launchd control path changed');
  const m = text.match(/^\s*pid = (\d+)$/m);
  return m ? Number(m[1]) : null;
}
function observe() {
  const pid = jobPid();
  return {
    ...observeCanonicalProcess(pid),
    jobPid: pid,
    portPids: portPids(3190),
    protectedPids: [...portPids(3100), ...portPids(3101)],
  };
}
function verifyStageReceipt(r) {
  if (
    !/^[a-f0-9]{40}$/.test(r.sourceCommit) ||
    r.release !== join(root, 'releases', r.sourceCommit.slice(0, 12)) ||
    r.label !== 'com.mitzo.staging' ||
    r.port !== 3190 ||
    r.bind !== '127.0.0.1' ||
    r.workspace !== join(root, 'workspace')
  )
    throw Error('Ordinary canonical receipt required');
  directory(r.release);
  if (
    realpathSync(run('git', ['rev-parse', '--show-toplevel'], r.release)) !== r.release ||
    run('git', ['rev-parse', 'HEAD'], r.release) !== r.sourceCommit ||
    run('git', ['rev-parse', 'HEAD^{tree}'], r.release) !== r.sourceTree ||
    run('git', ['status', '--porcelain', '--untracked-files=no'], r.release) ||
    run('git', ['remote', 'get-url', 'origin'], r.release) !==
      'https://github.com/dimakis/mitzo.git'
  )
    throw Error('Ordinary source drift');
  run(
    'git',
    ['merge-base', '--is-ancestor', r.sourceCommit, 'refs/remotes/origin/main'],
    r.release,
  );
  if (!r.compiledArtifacts || !Object.keys(r.compiledArtifacts).length)
    throw Error('Original build receipt missing');
  for (const [name, value] of Object.entries(r.compiledArtifacts)) {
    const path = join(r.release, name);
    if (
      !/^(dist|frontend\/dist|packages\/(protocol|harness|client)\/dist)\//.test(name) ||
      name.split('/').includes('..') ||
      realpathSync(path) !== path ||
      hash(bytes(path, false)) !== value
    )
      throw Error('Ordinary artifact drift');
  }
  const actualArtifacts = {};
  function inventory(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error('Compiled artifact alias refused');
    if (stat.isDirectory())
      for (const name of readdirSync(path).sort()) inventory(join(path, name));
    else if (stat.isFile()) actualArtifacts[relative(r.release, path)] = hash(bytes(path, false));
    else throw Error('Unsupported compiled artifact');
  }
  for (const name of [
    'dist',
    'frontend/dist',
    'packages/protocol/dist',
    'packages/harness/dist',
    'packages/client/dist',
  ])
    inventory(join(r.release, name));
  const sorted = (value) =>
    JSON.stringify(
      Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
    );
  if (sorted(actualArtifacts) !== sorted(r.compiledArtifacts))
    throw Error('Ordinary compiled inventory drift');
  directory(join(r.release, 'node_modules'));
  if (
    !r.dependencyFingerprint ||
    fingerprintDirectory(r.release, 'node_modules') !== r.dependencyFingerprint
  )
    throw Error('Ordinary dependencies changed');
  return r;
}
function ordinaryReceipt() {
  const r = verifyStageReceipt(readCanonicalPrivateJson(receiptPath));
  const plist = JSON.parse(
    run('/usr/bin/plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      join(service, 'com.mitzo.staging.plist'),
    ]),
  );
  if (
    plist.Label !== 'com.mitzo.staging' ||
    plist.KeepAlive !== false ||
    plist.WorkingDirectory !== r.release ||
    JSON.stringify(plist.ProgramArguments) !==
      JSON.stringify([process.execPath, join(service, 'start.mjs')])
  )
    throw Error('Original ordinary service changed');
  return r;
}

function ordinaryFiles() {
  const files = {};
  for (const tree of ['bin', 'service']) {
    function walk(path) {
      for (const name of readdirSync(path).sort()) {
        if (
          tree === 'service' &&
          ['deployment.lock', 'deployment-audit.jsonl', 'transitions', 'deployments'].includes(name)
        )
          continue;
        const p = join(path, name),
          s = lstatSync(p);
        if (s.isDirectory()) {
          directory(p);
          walk(p);
        } else files[relative(root, p)] = hash(bytes(p, false));
      }
    }
    walk(join(root, tree));
  }
  return files;
}
function freshMain() {
  const sha = run('git', [
    'ls-remote',
    'https://github.com/dimakis/mitzo.git',
    'refs/heads/main',
  ]).split(/\s+/)[0];
  if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('Main unavailable');
  return sha;
}
function prepared(target, baseline) {
  const plan = readOwnedReleasePlan(join(owned, 'owned-release.json'));
  if (
    plan.acceptedMainBaseline !== baseline ||
    plan.sourceCommit !== target ||
    plan.releaseRoot !== join(root, 'releases', target.slice(0, 12))
  )
    throw Error('Exact prepared commit required');
  verifyOwnedRelease(plan);
  assertCanonicalStagingService(
    plan,
    join(root, 'symposium/settings/staging-registration.json'),
    root,
  );
  readStagingOperatorEnvironment(plan, join(owned, 'staging-operator.json'), {});
  for (const name of [
    'launch.intent',
    'original-owner.json',
    'owner.stdout.log',
    'owner.stderr.log',
  ])
    absent(join(owned, name));
  const plist = JSON.parse(
    run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(owned, 'staging-custodian.plist')]),
  );
  const expectedPlist = {
    Label: 'com.mitzo.staging',
    ProgramArguments: [
      process.execPath,
      join(plan.releaseRoot, 'scripts/start-staging-custodian.mjs'),
      join(owned, 'owned-release.json'),
      join(root, 'symposium/settings/staging-registration.json'),
      join(owned, 'staging-operator.json'),
      '--canonical',
    ],
    EnvironmentVariables: { NODE_OPTIONS: '', NODE_PATH: '', DOTENV_CONFIG_PATH: '/dev/null' },
    WorkingDirectory: plan.releaseRoot,
    StandardOutPath: join(owned, 'owner.stdout.log'),
    StandardErrorPath: join(owned, 'owner.stderr.log'),
    KeepAlive: false,
    RunAtLoad: false,
    ExitTimeOut: 180,
  };
  const canonical = (value) =>
    JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item,
    );
  if (canonical(plist) !== canonical(expectedPlist))
    throw Error('Prepared canonical service changed');
  // A fresh registration must not reuse an existing registry or native launch.
  if (readdirSync(join(root, 'registry')).length)
    throw Error('Fresh empty registry required; retain existing registry evidence');
  const files = [
    join(owned, 'owned-release.json'),
    join(owned, 'staging-custodian.plist'),
    join(owned, 'staging-operator.json'),
    plan.configPath,
    join(root, 'symposium/settings/staging-registration.json'),
  ];
  return { plan, inputs: Object.fromEntries(files.map((path) => [path, hash(bytes(path))])) };
}
// Reuse the ordinary prepare receipt; the controller and app are distinct releases.
function controllerIdentity(commit) {
  const path = join(controllerRoot, 'staging-release.json');
  const receipt = verifyStageReceipt(readCanonicalPrivateJson(path));
  if (
    receipt.sourceCommit !== commit ||
    receipt.release !== controllerRoot ||
    realpathSync(controllerRoot) !== controllerRoot
  )
    throw Error('Executing canonical controller release does not match explicit controller commit');
  const files = [
    'scripts/symposium-staging-transition.mjs',
    'scripts/lib/symposium-staging-transition.mjs',
    'scripts/lib/symposium-staging-router.mjs',
    'scripts/lib/staging-files.mjs',
  ];
  run('git', ['ls-files', '--error-unmatch', ...files], controllerRoot);
  const index = run('git', ['ls-files', '-v'], controllerRoot).split('\n').filter(Boolean);
  if (!index.length || index.some((line) => !line.startsWith('H ')))
    throw Error('Controller hidden tracked-file flags refused');
  return {
    sourceCommit: commit,
    sourceTree: receipt.sourceTree,
    releaseRoot: controllerRoot,
    receiptSha256: hash(bytes(path)),
    scripts: Object.fromEntries(
      files.map((name) => [name, hash(bytes(join(controllerRoot, name), false))]),
    ),
    compiledArtifactsSha256: hash(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(receipt.compiledArtifacts).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
    ),
    dependencyFingerprint: receipt.dependencyFingerprint,
  };
}
function accepted(plan, controller) {
  verifyOwnedRelease(plan);
  const current = controllerIdentity(controller.sourceCommit);
  if (JSON.stringify(current) !== JSON.stringify(controller))
    throw Error('Prepared controller identity changed');
  assertAcceptedTransition(controller.sourceCommit, freshMain(), true);
}

try {
  const command = process.argv[2],
    args = process.argv.slice(3),
    flags = {};
  if (process.platform !== 'darwin' || !['prepare', 'plan', 'apply'].includes(command))
    throw Error('Use prepare/plan/apply on canonical macOS stage');
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (
      ![
        '--commit',
        '--expected-current',
        '--controller-commit',
        '--accepted-main-baseline',
      ].includes(key) ||
      flags[key] ||
      !args[i + 1]
    )
      throw Error('Exact commit arguments required');
    flags[key] = args[++i];
  }
  const target = flags['--commit'],
    expected = flags['--expected-current'],
    controllerCommit = flags['--controller-commit'],
    baseline = flags['--accepted-main-baseline'];
  if (
    !/^[a-f0-9]{40}$/.test(target ?? '') ||
    !/^[a-f0-9]{40}$/.test(expected ?? '') ||
    !/^[a-f0-9]{40}$/.test(controllerCommit ?? '') ||
    !/^[a-f0-9]{40}$/.test(baseline ?? '')
  )
    throw Error('Full commit identities required');
  for (const p of [
    root,
    service,
    owned,
    join(root, 'bin'),
    join(root, 'symposium'),
    join(root, 'symposium/settings'),
    join(root, 'registry'),
  ])
    directory(p, true);
  absent(lockPath);
  absent(topologyPath);
  const { plan, inputs } = prepared(target, baseline),
    old = ordinaryReceipt(),
    controller = controllerIdentity(controllerCommit);
  if (old.sourceCommit !== expected) throw Error('Expected ordinary source changed');
  const live = observe(),
    original = {
      sourceCommit: expected,
      release: old.release,
      pid: live.pid,
      birth: live.birth,
      cwd: live.cwd,
    };
  assertOrdinaryOwner(original, live);
  if (command === 'prepare') {
    exclusive(
      intentPath,
      JSON.stringify({
        version: 2,
        acceptedMainBaseline: baseline,
        controller,
        id: randomUUID(),
        target,
        expected,
        original,
        inputs,
        ordinaryFiles: ordinaryFiles(),
        receiptSha256: hash(bytes(receiptPath)),
        createdAt: Date.now(),
      }) + '\n',
    );
    console.log(
      JSON.stringify({
        prepared: true,
        target,
        expected,
        started: false,
        modelCalls: 0,
        productionActions: [],
      }),
    );
  } else {
    const intent = readCanonicalPrivateJson(intentPath);
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(intent.id) ||
      intent.version !== 2
    )
      throw Error('Prepared transition identity invalid');
    function validate() {
      const candidate = prepared(target, baseline);
      if (
        intent.acceptedMainBaseline !== baseline ||
        intent.target !== target ||
        JSON.stringify(intent.controller) !== JSON.stringify(controller) ||
        intent.expected !== expected ||
        hash(bytes(receiptPath)) !== intent.receiptSha256 ||
        JSON.stringify(candidate.inputs) !== JSON.stringify(intent.inputs) ||
        JSON.stringify(ordinaryFiles()) !== JSON.stringify(intent.ordinaryFiles)
      )
        throw Error('Prepared transition inputs changed');
      ordinaryReceipt();
      assertOrdinaryOwner(intent.original, observe());
    }
    validate();
    if (command === 'plan')
      console.log(
        JSON.stringify({
          planned: true,
          target,
          expected,
          original: intent.original,
          apply: false,
          acceptedMainRequired: true,
          controllerSource: controller.sourceCommit,
          productionActions: [],
        }),
      );
    else {
      accepted(plan, controller);
      const backup = join(service, 'transitions', intent.id),
        lock = {
          id: intent.id,
          target,
          expected,
          mode: 'ordinary-to-owned',
          controllerSource: controller.sourceCommit,
          controllerTree: controller.sourceTree,
          controllerReceiptSha256: controller.receiptSha256,
          requestedAt: Date.now(),
        };
      let lockFd;
      await transitionStage({
        async lock() {
          lockFd = openSync(
            lockPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
          );
          writeFileSync(lockFd, JSON.stringify(lock) + '\n');
          fsyncSync(lockFd);
          syncParent(lockPath);
        },
        async validate() {
          validate();
          accepted(plan, controller);
        },
        async stop() {
          validate();
          accepted(plan, controller);
          assertOrdinaryOwner(intent.original, observe());
          run('/bin/launchctl', ['kill', 'SIGTERM', job]);
          const until = Date.now() + 180000;
          while (Date.now() < until) {
            const p = spawnSync('/bin/ps', ['-p', String(intent.original.pid), '-o', 'pid='], {
              encoding: 'utf8',
              timeout: 3000,
            });
            if (p.status !== 0 && p.status !== 1)
              throw Error('Original process inventory uncertain');
            if (!jobPid() && p.status === 1 && portPids(3190).length === 0) return;
            await setTimeout(250);
          }
          throw Error('Original ordinary shutdown uncertain');
        },
        async preserve() {
          const parent = join(service, 'transitions');
          if (!lstatSync(parent, { throwIfNoEntry: false })) mkdirSync(parent, { mode: 0o700 });
          directory(parent);
          mkdirSync(backup, { mode: 0o700 });
          for (const name of ['workspace', 'state', 'home', 'settings', 'bin']) {
            directory(join(root, name));
            cpSync(join(root, name), join(backup, name), {
              recursive: true,
              verbatimSymlinks: true,
              errorOnExist: true,
              force: false,
            });
          }
          mkdirSync(join(backup, 'service'), { mode: 0o700 });
          for (const name of Object.keys(intent.ordinaryFiles).filter((x) =>
            x.startsWith('service/'),
          )) {
            const out = join(backup, name);
            mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
            cpSync(join(root, name), out, { errorOnExist: true, force: false });
          }
          exclusive(join(backup, 'stopped-original.json'), JSON.stringify(intent) + '\n');
        },
        async install() {
          if (
            jobPid() ||
            portPids(3190).length ||
            [...portPids(3100), ...portPids(3101)].includes(intent.original.pid)
          )
            throw Error('Stopped service changed or protected PID reused');
          accepted(plan, controller);
          if (JSON.stringify(prepared(target, baseline).inputs) !== JSON.stringify(intent.inputs))
            throw Error('Prepared service drift');
          exclusive(
            topologyPath,
            JSON.stringify({
              mode: 'owned-custodian',
              sourceCommit: target,
              transitionId: intent.id,
            }) + '\n',
          );
          const temporary = join(root, 'bin/staging.mjs.' + intent.id);
          exclusive(
            temporary,
            bytes(join(controllerRoot, 'scripts/lib/symposium-staging-router.mjs'), false),
          );
          renameSync(temporary, join(root, 'bin/staging.mjs'));
          syncParent(temporary);
          run('/bin/launchctl', ['bootout', job]);
          const tmp = join(service, 'com.mitzo.staging.plist.' + intent.id);
          exclusive(tmp, bytes(join(owned, 'staging-custodian.plist')));
          renameSync(tmp, join(service, 'com.mitzo.staging.plist'));
          syncParent(tmp);
          run('/bin/launchctl', [
            'bootstrap',
            'gui/' + process.getuid(),
            join(service, 'com.mitzo.staging.plist'),
          ]);
        },
        async start() {
          accepted(plan, controller);
          if (
            JSON.stringify(prepared(target, baseline).inputs) !== JSON.stringify(intent.inputs) ||
            jobPid() ||
            portPids(3190).length ||
            [...portPids(3100), ...portPids(3101)].includes(intent.original.pid)
          )
            throw Error('Pre-start staging identities changed');
          run('/bin/launchctl', ['kickstart', job]);
        },
        async verify() {
          const until = Date.now() + 30000;
          while (Date.now() < until) {
            try {
              const owner = readCanonicalPrivateJson(join(owned, 'original-owner.json'));
              if (
                owner.sourceCommit === target &&
                owner.parent.pid !== intent.original.pid &&
                jobPid() === owner.parent.pid &&
                portPids(3190).length === 1 &&
                portPids(3190)[0] === owner.app.pid
              ) {
                const { assertCanonicalOwnerRuntime } =
                  await import('../dist/symposium-canonical-control.js');
                const { default: Database } = await import('better-sqlite3');
                bytes(join(root, 'registry/staging.db'));
                const db = new Database(join(root, 'registry/staging.db'), {
                  readonly: true,
                  fileMustExist: true,
                });
                try {
                  if (db.prepare('SELECT capacity FROM policy WHERE id=1').get()?.capacity !== 1)
                    throw Error();
                  const rows = db
                    .prepare('SELECT * FROM launches WHERE planDirectory=?')
                    .all(owned);
                  if (rows.length !== 1) throw Error();
                  assertCanonicalOwnerRuntime(plan, owner, rows[0], {
                    jobPid: jobPid(),
                    parent: observeCanonicalProcess(owner.parent.pid),
                    app: observeCanonicalProcess(owner.app.pid),
                    portPids: portPids(3190),
                    protectedPids: [...portPids(3100), ...portPids(3101)],
                  });
                } finally {
                  db.close();
                }
                const response = await globalThis.fetch('http://127.0.0.1:3190', {
                  signal: globalThis.AbortSignal.timeout(2000),
                });
                if (response.ok) return;
              }
            } catch {
              /* Same bounded attempt. Never restart or stop a new owner. */
            }
            await setTimeout(250);
          }
          throw Error('New original custodian readiness uncertain');
        },
        async audit(state) {
          exclusive(
            join(owned, 'transition-' + intent.id + '-' + state + '.json'),
            JSON.stringify({ ...lock, state, at: Date.now(), backup, productionActions: [] }) +
              '\n',
          );
        },
        async unlock() {
          if (JSON.stringify(readCanonicalPrivateJson(lockPath)) !== JSON.stringify(lock))
            throw Error('Shared lock changed');
          closeSync(lockFd);
          unlinkSync(lockPath);
          syncParent(lockPath);
        },
      });
      console.log(
        JSON.stringify({
          verified: true,
          target,
          expected,
          backup,
          productionActions: [],
          modelCalls: 0,
        }),
      );
    }
  }
} catch (error) {
  console.error(
    error.message + '; preserve evidence and any lock. No force, rollback or replacement.',
  );
  process.exitCode = 1;
}
