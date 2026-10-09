#!/usr/bin/env node
// Verification-only reconciliation of an exact completed metadata operation.
// Never reruns migration, restores old files or controls a service.
import process from 'node:process';
import console from 'node:console';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  fsyncSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  privateJson,
  stageDirectory,
  appendAudit,
  assertVisibleTrackedIndex,
} from './lib/staging-files.mjs';
import { verifyRetainedQualification } from './lib/staging-qualification-recovery.mjs';
import { auditLegacyClosure } from './lib/staging-legacy.mjs';
import { registrationDigest } from './lib/staging-registration.mjs';

const root = join(homedir(), '.local/share/mitzo-staging'),
  source = dirname(dirname(fileURLToPath(import.meta.url)));
const lockPath = join(root, 'service/deployment.lock'),
  qPath = join(root, 'service/legacy-qualification.json'),
  receiptPath = join(root, 'service/release-receipt.json');
const flags = {},
  args = process.argv.slice(2);
const hash = (b) => createHash('sha256').update(b).digest('hex');
const names = [
  'staging.mjs',
  'lib/staging-files.mjs',
  'lib/staging-operations.mjs',
  'lib/staging-job.mjs',
  'lib/staging-launcher-template.mjs',
  'lib/staging-registration.mjs',
  'lib/staging-dependency-source.mjs',
];
const env = {
  PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: homedir(),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
};
function run(program, argv, cwd = source) {
  const p = spawnSync(program, argv, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (p.status !== 0) throw Error('Qualification verification command refused: ' + program);
  return p.stdout.trim();
}
const git = (...argv) =>
  run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...argv]);
function sourceBlob(commit, name) {
  const p = spawnSync(
    'git',
    ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'show', commit + ':' + name],
    { cwd: source, env, timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (p.status !== 0) throw Error('Original accepted source blob unavailable');
  return p.stdout;
}
function publicFile(p) {
  const s = lstatSync(p);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid() ||
    s.nlink !== 1 ||
    realpathSync(p) !== p ||
    s.mode & 0o022
  )
    throw Error('Original qualification file identity refused');
  return readFileSync(p);
}
try {
  if (process.platform !== 'darwin' || args.length !== 4)
    throw Error('Use --operation UUID --expected-audit SHA256');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--operation', '--expected-audit'].includes(args[i]) || flags[args[i]])
      throw Error('Exact operation arguments required');
    flags[args[i]] = args[i + 1];
  }
  for (const p of ['service', 'bin', 'service/requalifications', 'registry'])
    stageDirectory(root, p);
  function noOtherOperation() {
    if (
      readdirSync(join(root, 'registry')).length ||
      [
        'service/topology.json',
        'service/launch-permit.json',
        'symposium/service/transition.json',
        'symposium/service/launch.intent',
        'symposium/service/original-owner.json',
      ].some((p) => lstatSync(join(root, p), { throwIfNoEntry: false }))
    )
      throw Error('Other retained ownership or operation requires investigation');
  }
  noOtherOperation();
  const lock = privateJson(lockPath),
    q = privateJson(qPath);
  const archive = join(root, 'service/requalifications', flags['--operation']);
  stageDirectory(root, 'service/requalifications/' + flags['--operation']);
  const snapshot = privateJson(join(archive, 'audit.json')),
    priorBytes = publicFile(join(archive, 'original-receipt.json'));
  const prior = verifyRetainedQualification({
    root,
    operation: flags['--operation'],
    auditSha256: flags['--expected-audit'],
    lock,
    qualification: q,
    snapshot,
    priorBytes,
    currentBytes: publicFile(receiptPath),
  });
  const current = git('rev-parse', 'HEAD'),
    main = git('ls-remote', 'https://github.com/dimakis/mitzo.git', 'refs/heads/main').split(
      /\s+/,
    )[0];
  if (
    current !== main ||
    !/^[a-f0-9]{40}$/.test(current) ||
    git('status', '--porcelain', '--untracked-files=no') ||
    realpathSync(git('rev-parse', '--show-toplevel')) !== source ||
    git('remote', 'get-url', 'origin') !== 'https://github.com/dimakis/mitzo.git'
  )
    throw Error('Verification recovery requires exact clean accepted main');
  assertVisibleTrackedIndex(git('ls-files', '-v'));
  git('merge-base', '--is-ancestor', lock.controller, current);
  git(
    'ls-files',
    '--error-unmatch',
    'scripts/verify-staging-qualification.mjs',
    'scripts/lib/staging-qualification-recovery.mjs',
  );
  const expectedFiles = [
    ...names.slice(0, 5).map((n) => 'bin/' + n),
    'service/start.mjs',
    'service/control-lib/staging-files.mjs',
    'service/control-lib/staging-operations.mjs',
    'service/control-tool.json',
  ].sort();
  if (JSON.stringify(Object.keys(snapshot.files).sort()) !== JSON.stringify(expectedFiles))
    throw Error('Original controller archive incomplete');
  for (const name of expectedFiles)
    if (hash(publicFile(join(archive, name))) !== snapshot.files[name])
      throw Error('Original controller archive changed');
  if (
    hash(publicFile(join(archive, 'legacy-registration.plist'))) !==
      snapshot.legacyRegistration.sha256 ||
    registrationDigest(snapshot.legacyRegistration.path) !== snapshot.legacyRegistration.sha256
  )
    throw Error('Original registration changed');
  function verify() {
    noOtherOperation();
    if (
      JSON.stringify(privateJson(lockPath)) !== JSON.stringify(lock) ||
      JSON.stringify(privateJson(qPath)) !== JSON.stringify(q)
    )
      throw Error('Original retained operation changed');
    verifyRetainedQualification({
      root,
      operation: flags['--operation'],
      auditSha256: flags['--expected-audit'],
      lock,
      qualification: q,
      snapshot,
      priorBytes,
      currentBytes: publicFile(receiptPath),
    });
    const a = auditLegacyClosure(prior.release, prior);
    for (const k of ['legacyFingerprint', 'closureFingerprint', 'coverage', 'payloadSha256'])
      if (JSON.stringify(a[k]) !== JSON.stringify(snapshot[k]))
        throw Error('Original source/dependency proof changed');
    for (const n of names) {
      const expected = sourceBlob(lock.controller, 'scripts/' + n);
      if (!publicFile(join(root, 'bin', n)).equals(expected))
        throw Error('Installed controller differs from original accepted operation');
    }
    for (const [installed, original] of [
      ['service/start.mjs', 'scripts/lib/staging-launcher-template.mjs'],
      ['service/control-lib/staging-files.mjs', 'scripts/lib/staging-files.mjs'],
      ['service/control-lib/staging-operations.mjs', 'scripts/lib/staging-operations.mjs'],
    ]) {
      const expected = sourceBlob(lock.controller, original);
      if (!publicFile(join(root, installed)).equals(expected))
        throw Error('Installed startup guard differs from original accepted operation');
    }
    const c = spawnSync(process.execPath, [join(root, 'bin/staging.mjs'), 'check', '--offline'], {
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    const body = JSON.parse(c.stdout || '{}');
    if (
      c.status !== 1 ||
      body.expected !== prior.sourceCommit ||
      JSON.stringify(body.issues) !== '["deployment-lock"]'
    )
      throw Error('Retained stage has a non-lock qualification failure');
    run(process.execPath, [join(root, 'service/start.mjs'), '--check'], root);
  }
  verify();
  if (
    git('ls-remote', 'https://github.com/dimakis/mitzo.git', 'refs/heads/main').split(/\s+/)[0] !==
    current
  )
    throw Error('Accepted main changed during verification');
  verify();
  appendAudit(join(root, 'service/deployment-audit.jsonl'), {
    id: lock.id,
    mode: 'legacy-qualification',
    phase: 'verified-recovery',
    originalController: lock.controller,
    verificationSource: current,
    auditSha256: q.auditSha256,
    archive: q.archive,
    serviceControl: false,
    modelCalls: 0,
    productionActions: [],
  });
  if (JSON.stringify(privateJson(lockPath)) !== JSON.stringify(lock))
    throw Error('Original lock changed before verified release');
  unlinkSync(lockPath);
  const fd = openSync(dirname(lockPath), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  console.log(
    JSON.stringify({
      verifiedOriginalOperation: lock.id,
      metadataRewritten: false,
      serviceControl: false,
      lockReleased: true,
      modelCalls: 0,
      productionActions: [],
    }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
