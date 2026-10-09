#!/usr/bin/env node
// Explicit qualification of historical ordinary staging. Never stops or starts it.
import process from 'node:process';
import console from 'node:console';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import {
  readFileSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { auditLegacyClosure } from './lib/staging-legacy.mjs';
import {
  privateJson,
  replacePrivateJson,
  stageDirectory,
  appendAudit,
  assertVisibleTrackedIndex,
} from './lib/staging-files.mjs';
import { stagingBoundary, assertPinnedStageSource } from './lib/staging-operations.mjs';
import { registrationDigest } from './lib/staging-registration.mjs';
import { assertStageJob } from './lib/staging-job.mjs';
import { requalifyStage } from './lib/staging-requalification.mjs';

const root = join(homedir(), '.local/share/mitzo-staging'),
  source = dirname(dirname(fileURLToPath(import.meta.url)));
const receiptPath = join(root, 'service/release-receipt.json'),
  lockPath = join(root, 'service/deployment.lock');
const qualificationPath = join(root, 'service/legacy-qualification.json');
const legacyPath = join(homedir(), 'Library/LaunchAgents/com.mitzo.staging.plist');
const canonicalPath = join(root, 'service/com.mitzo.staging.plist');
const hash = (b) => createHash('sha256').update(b).digest('hex');
const fileHash = (p) => hash(readFileSync(p));
const argv = process.argv.slice(2),
  command = argv.shift(),
  flags = {};
const names = [
  'staging.mjs',
  'lib/staging-files.mjs',
  'lib/staging-operations.mjs',
  'lib/staging-job.mjs',
  'lib/staging-launcher-template.mjs',
  'lib/staging-registration.mjs',
];
function run(program, args, cwd = root) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: join(root, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  if (result.status !== 0) throw Error('Qualification command refused: ' + program);
  return result.stdout.trim();
}
const git = (cwd, ...args) =>
  run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], cwd);
function absent(p) {
  if (lstatSync(p, { throwIfNoEntry: false }))
    throw Error('Existing evidence requires investigation: ' + p);
}
function originalJob(receipt) {
  const text = run('launchctl', ['print', `gui/${process.getuid()}/com.mitzo.staging`]);
  if (text.match(/^\s*path = (.+)$/m)?.[1]?.trim() !== legacyPath)
    throw Error('This qualification supports only the original legacy registration');
  const registrationSha256 = registrationDigest(legacyPath);
  if (registrationDigest(canonicalPath) !== registrationSha256)
    throw Error('Legacy/private registrations differ');
  const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', legacyPath]));
  if (
    plist.Label !== 'com.mitzo.staging' ||
    plist.KeepAlive !== false ||
    plist.WorkingDirectory !== receipt.release ||
    plist.ProgramArguments?.length !== 2 ||
    realpathSync(plist.ProgramArguments[0]) !== realpathSync(process.execPath) ||
    plist.ProgramArguments[1] !== join(root, 'service/start.mjs')
  )
    throw Error('Legacy service configuration refused');
  const pid = Number(text.match(/^\s*pid = (\d+)$/m)?.[1]);
  const birth = run('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
  const cwd = run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    .split('\n')
    .filter((l) => l.startsWith('n'));
  if (cwd.length !== 1) throw Error('Original process directory unknown');
  const portPids = (port) => {
    const p = spawnSync('/usr/sbin/lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    if (p.status === 1) return [];
    if (p.status !== 0) throw Error('Listener inventory unavailable');
    return [...new Set(p.stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
  };
  const job = {
    pid,
    birth,
    cwd: cwd[0].slice(1),
    portPids: portPids(3190),
    protectedPids: [...portPids(3100), ...portPids(3101)],
  };
  assertStageJob(job, receipt);
  return {
    original: { pid, birth, cwd: job.cwd },
    legacyRegistration: { path: legacyPath, sha256: registrationSha256 },
  };
}
function inspect(ownLock = false) {
  for (const p of ['service', 'settings', 'workspace', 'state', 'home', 'releases', 'bin'])
    stageDirectory(root, p);
  if (!ownLock) absent(lockPath);
  for (const p of [
    qualificationPath,
    join(root, 'service/topology.json'),
    join(root, 'symposium/service/transition.json'),
    join(root, 'symposium/service/launch.intent'),
    join(root, 'symposium/service/original-owner.json'),
  ])
    absent(p);
  const r = privateJson(receiptPath);
  stagingBoundary({ ...r, root });
  if (
    r.openShellEnabled !== false ||
    JSON.stringify(r.providerProfiles) !== '[]' ||
    JSON.stringify(privateJson(join(root, 'settings/account-profiles.json'))) !== '[]'
  )
    throw Error('Only unconfigured ordinary staging may be requalified');
  assertPinnedStageSource({
    expected: r.sourceCommit,
    expectedTree: r.sourceTree,
    source: git(r.release, 'rev-parse', 'HEAD'),
    tree: git(r.release, 'rev-parse', 'HEAD^{tree}'),
    dirty: git(r.release, 'status', '--porcelain', '--untracked-files=no'),
    origin: git(r.release, 'remote', 'get-url', 'origin'),
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
        { cwd: r.release },
      ).status === 0,
  });
  if (realpathSync(git(r.release, 'rev-parse', '--show-toplevel')) !== r.release)
    throw Error('Original Git worktree redirect refused');
  const closure = auditLegacyClosure(r.release, r),
    job = originalJob(r),
    files = {};
  for (const name of [
    ...names.filter((n) => n !== 'lib/staging-registration.mjs').map((n) => 'bin/' + n),
    'service/start.mjs',
    'service/control-lib/staging-files.mjs',
    'service/control-lib/staging-operations.mjs',
    'service/control-tool.json',
  ]) {
    const p = join(root, name),
      s = lstatSync(p);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.uid !== process.getuid() ||
      s.nlink !== 1 ||
      s.mode & 0o022 ||
      realpathSync(p) !== p
    )
      throw Error('Original controller evidence refused');
    files[name] = fileHash(p);
  }
  const historical = privateJson(join(root, 'service/control-tool.json'));
  for (const name of names.filter((n) => n !== 'lib/staging-registration.mjs'))
    if (historical.controllerFiles['scripts/' + name] !== files['bin/' + name])
      throw Error('Historical controller drift');
  if (JSON.stringify(privateJson(receiptPath)) !== JSON.stringify(r))
    throw Error('Receipt changed during audit');
  const snapshot = {
    version: 1,
    sourceCommit: r.sourceCommit,
    sourceTree: r.sourceTree,
    originalReceiptSha256: fileHash(receiptPath),
    ...closure,
    ...job,
    files,
  };
  return { receipt: r, snapshot, auditSha256: hash(JSON.stringify(snapshot)) };
}
function accepted() {
  const head = git(source, 'rev-parse', 'HEAD'),
    main = git(
      source,
      'ls-remote',
      'https://github.com/dimakis/mitzo.git',
      'refs/heads/main',
    ).split(/\s+/)[0];
  if (
    head !== main ||
    !/^[a-f0-9]{40}$/.test(head) ||
    git(source, 'status', '--porcelain', '--untracked-files=no') ||
    realpathSync(git(source, 'rev-parse', '--show-toplevel')) !== source ||
    git(source, 'remote', 'get-url', 'origin') !== 'https://github.com/dimakis/mitzo.git'
  )
    throw Error('Qualification apply requires exact clean accepted main');
  assertVisibleTrackedIndex(git(source, 'ls-files', '-v'));
  for (const n of [
    ...names.map((n) => 'scripts/' + n),
    'scripts/requalify-staging.mjs',
    'scripts/lib/staging-legacy.mjs',
    'scripts/lib/staging-requalification.mjs',
  ])
    git(source, 'ls-files', '--error-unmatch', n);
  return head;
}
function exclusive(p, b) {
  const fd = openSync(p, 'wx', 0o600);
  try {
    writeFileSync(fd, b);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncParent(p);
}
function syncParent(p) {
  const fd = openSync(dirname(p), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function archiveDirectory(p) {
  if (lstatSync(p, { throwIfNoEntry: false })) return;
  archiveDirectory(dirname(p));
  mkdirSync(p, { mode: 0o700 });
  syncParent(p);
}
function atomic(p, b, id) {
  if (lstatSync(p, { throwIfNoEntry: false })) {
    const s = lstatSync(p);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || realpathSync(p) !== p)
      throw Error('Controller destination alias refused');
  }
  const temp = p + '.' + id;
  exclusive(temp, b);
  renameSync(temp, p);
  syncParent(p);
}
try {
  if (process.platform !== 'darwin' || !['audit', 'apply'].includes(command))
    throw Error(
      'Use requalify-staging audit | apply --expected-current SHA --expected-audit SHA256',
    );
  for (let i = 0; i < argv.length; i++)
    if (['--expected-current', '--expected-audit'].includes(argv[i]) && argv[i + 1])
      flags[argv[i]] = argv[++i];
    else throw Error('Unknown qualification argument');
  const inspection = inspect();
  if (command === 'audit') {
    console.log(
      JSON.stringify({
        ...inspection.snapshot,
        auditSha256: inspection.auditSha256,
        applied: false,
        serviceControl: false,
        modelCalls: 0,
        productionActions: [],
      }),
    );
  } else {
    if (
      inspection.receipt.sourceCommit !== flags['--expected-current'] ||
      inspection.auditSha256 !== flags['--expected-audit']
    )
      throw Error('Explicit audited original pins required');
    const controller = accepted(),
      id = randomUUID(),
      archive = join(root, 'service/requalifications', id);
    let fd;
    await requalifyStage({
      async lock() {
        fd = openSync(lockPath, 'wx', 0o600);
        writeFileSync(
          fd,
          JSON.stringify({
            id,
            mode: 'legacy-qualification',
            expected: inspection.receipt.sourceCommit,
            controller,
          }) + '\n',
        );
        fsyncSync(fd);
        syncParent(lockPath);
      },
      async verify() {
        if (inspect(true).auditSha256 !== inspection.auditSha256 || accepted() !== controller)
          throw Error('Original qualification inputs changed');
      },
      async preserve() {
        stageDirectory(root, 'service/requalifications', true);
        syncParent(join(root, 'service/requalifications'));
        mkdirSync(archive, { mode: 0o700 });
        syncParent(archive);
        for (const [name] of Object.entries(inspection.snapshot.files)) {
          const out = join(archive, name);
          archiveDirectory(dirname(out));
          exclusive(out, readFileSync(join(root, name)));
        }
        exclusive(join(archive, 'original-receipt.json'), readFileSync(receiptPath));
        exclusive(join(archive, 'legacy-registration.plist'), readFileSync(legacyPath));
        exclusive(join(archive, 'audit.json'), JSON.stringify(inspection.snapshot, null, 2) + '\n');
      },
      async migrate() {
        if (inspect(true).auditSha256 !== inspection.auditSha256 || accepted() !== controller)
          throw Error('Original or accepted source changed before migration');
        const next = {
          ...inspection.receipt,
          dependencyFingerprint: inspection.snapshot.closureFingerprint,
        };
        const q = {
          ...inspection.snapshot,
          controllerSource: controller,
          auditSha256: inspection.auditSha256,
          archive,
          resultingReceiptSha256: hash(JSON.stringify(next, null, 2) + '\n'),
        };
        exclusive(qualificationPath, JSON.stringify(q, null, 2) + '\n');
        for (const n of names)
          atomic(join(root, 'bin', n), readFileSync(join(source, 'scripts', n)), id);
        for (const n of ['staging-files.mjs', 'staging-operations.mjs'])
          atomic(
            join(root, 'service/control-lib', n),
            readFileSync(join(source, 'scripts/lib', n)),
            id,
          );
        atomic(
          join(root, 'service/start.mjs'),
          readFileSync(join(source, 'scripts/lib/staging-launcher-template.mjs')),
          id,
        );
        replacePrivateJson(receiptPath, next);
      },
      async check() {
        const c = spawnSync(
          process.execPath,
          [join(root, 'bin/staging.mjs'), 'check', '--offline'],
          { encoding: 'utf8', timeout: 30000 },
        );
        if (c.status !== 1 || JSON.stringify(JSON.parse(c.stdout).issues) !== '["deployment-lock"]')
          throw Error('Migrated controller qualification failed');
        run(process.execPath, [join(root, 'service/start.mjs'), '--check']);
        if (
          JSON.stringify(originalJob(inspection.receipt)) !==
          JSON.stringify({
            original: inspection.snapshot.original,
            legacyRegistration: inspection.snapshot.legacyRegistration,
          })
        )
          throw Error('Original service changed during metadata migration');
      },
      async audit(phase) {
        appendAudit(join(root, 'service/deployment-audit.jsonl'), {
          id,
          mode: 'legacy-qualification',
          phase,
          controller,
          original: inspection.receipt.sourceCommit,
          auditSha256: inspection.auditSha256,
          archive,
          modelCalls: 0,
          productionActions: [],
        });
      },
      async unlock() {
        closeSync(fd);
        unlinkSync(lockPath);
        const parent = openSync(dirname(lockPath), 'r');
        try {
          fsyncSync(parent);
        } finally {
          closeSync(parent);
        }
      },
    });
    console.log(
      JSON.stringify({
        qualified: true,
        id,
        archive,
        controller,
        serviceControl: false,
        modelCalls: 0,
        productionActions: [],
      }),
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
