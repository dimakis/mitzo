import process from 'node:process';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers';
import { lstatSync, renameSync, unlinkSync, cpSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  privateJson,
  fingerprintDirectory,
  artifacts,
  assertVisibleTrackedIndex,
} from './staging-files.mjs';
import { bytes, hash, directory, git, run, inventory } from './staging-cold-audit.mjs';
import { classifyColdRefusal } from './staging-cold-refusal.mjs';
import { exclusive, sync } from './staging-cold-prepare.mjs';
import { validateRecoveryPlist } from './staging-cold-plist.mjs';
import { recordOrVerifyFreshOwnerReceipt } from './staging-cold-receipt.mjs';
export function verifyPreparedController(root, source, current) {
  if (source !== join(root, 'releases', current.slice(0, 12)))
    throw Error('Independent canonical controller preparation required');
  const r = privateJson(join(source, 'staging-release.json'));
  assertVisibleTrackedIndex(git(source, 'ls-files', '-v'));
  if (
    r.sourceCommit !== current ||
    r.sourceTree !== git(source, 'rev-parse', 'HEAD^{tree}') ||
    JSON.stringify(artifacts(source)) !== JSON.stringify(r.compiledArtifacts) ||
    fingerprintDirectory(source, 'node_modules') !== r.dependencyFingerprint
  )
    throw Error('Executing prepared controller drift');
  return r;
}
export function failedJob(root, s) {
  const text = run('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/com.mitzo.staging']);
  const field = (n) => text.match(new RegExp('^\\s*' + n + ' = (.+)$', 'm'))?.[1]?.trim();
  if (
    field('path') !== join(root, 'service/com.mitzo.staging.plist') ||
    field('pid') ||
    field('state') !== 'not running' ||
    field('runs') !== '1' ||
    field('last exit code') !== '1' ||
    hash(bytes(join(root, 'service/com.mitzo.staging.plist'))) !== s.registrationSha256
  )
    throw Error('Exact failed service changed; refuse recovery control');
}
export async function preparedCold(root, vacant = true) {
  const recovery = privateJson(join(root, 'service/cold-recovery.json'));
  if (recovery.version === 2) {
    const { verifyKeyRecovery } = await import('./staging-key-recovery.mjs');
    return verifyKeyRecovery(root, recovery, vacant);
  }
  if (
    recovery.version !== 1 ||
    recovery.archive !== join(root, 'service/cold-refusals', recovery.operation) ||
    recovery.classification !== 'pre_native_refused'
  )
    throw Error('Exact prepared refusal required');
  directory(recovery.archive);
  const s = privateJson(join(recovery.archive, 'audit.json'));
  if (
    hash(JSON.stringify(s)) !== recovery.auditSha256 ||
    s.operation !== recovery.operation ||
    s.row.launchId !== recovery.originalLaunchId ||
    hash(bytes(join(s.plan.configPath))) !== s.configSha256
  )
    throw Error('Preserved proof or configuration changed');
  classifyColdRefusal(s);
  for (const [name, expected] of [
    ['service', s.serviceFiles],
    ['workspace', s.workspaceFiles],
    ['gateway-state', s.gatewayFiles],
    ['registry', s.registryFiles],
  ])
    if (JSON.stringify(inventory(join(recovery.archive, name))) !== JSON.stringify(expected))
      throw Error('Archived original evidence drift');
  const lock = privateJson(join(root, 'service/deployment.lock'));
  if (JSON.stringify(lock) !== JSON.stringify(s.lock))
    throw Error('Original deployment operation changed');
  const db = new Database(join(root, 'registry/staging.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const rows = db.prepare('SELECT * FROM qualified_cold_refusals').all();
    if (
      (vacant && db.prepare('SELECT COUNT(*) AS n FROM launches').get().n) ||
      rows.length !== 1 ||
      rows[0].launchId !== s.row.launchId ||
      rows[0].recordJson !== JSON.stringify(s.row) ||
      rows[0].auditSha256 !== recovery.auditSha256 ||
      rows[0].archive !== recovery.archive ||
      db.prepare('SELECT capacity FROM policy WHERE id=1').get()?.capacity !== 1
    )
      throw Error('Qualified reservation disposition changed');
  } finally {
    db.close();
  }
  if (vacant) failedJob(root, s);
  return { recovery, s, lock };
}
export async function prepareFreshRecovery(root, source, current, apply = false, testTools) {
  const { recovery, s } = await preparedCold(root);
  const releaseTools =
    testTools?.release ?? (await import('../../dist/symposium-owned-release.js'));
  const serviceTools =
    testTools?.service ?? (await import('../../dist/symposium-staging-service.js'));
  const { readOwnedReleasePlan, verifyOwnedRelease } = releaseTools;
  const { assertCanonicalStagingService, readStagingOperatorEnvironment } = serviceTools;
  const owned = join(root, 'symposium/service'),
    plan = readOwnedReleasePlan(join(owned, 'owned-release.json'));
  if (
    plan.releaseRoot !== source ||
    plan.sourceCommit !== current ||
    plan.acceptedMainBaseline !== current
  )
    throw Error('Fresh accepted canonical target required');
  verifyOwnedRelease(plan);
  readStagingOperatorEnvironment(plan, join(owned, 'staging-operator.json'), {});
  const plist = JSON.parse(
    run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(owned, 'staging-custodian.plist')]),
  );
  validateRecoveryPlist(root, plan, plist, process.execPath);
  assertCanonicalStagingService(
    plan,
    join(root, 'symposium/settings/staging-registration.json'),
    root,
  );
  if (
    lstatSync(join(owned, 'launch.intent'), { throwIfNoEntry: false }) ||
    lstatSync(join(owned, 'original-owner.json'), { throwIfNoEntry: false }) ||
    lstatSync(join(owned, 'owner.stdout.log'), { throwIfNoEntry: false }) ||
    lstatSync(join(owned, 'owner.stderr.log'), { throwIfNoEntry: false })
  )
    throw Error('Fresh owner input collision');
  const config = privateJson(plan.configPath);
  if (portPids(config.gateway.port).length || portPids(3190).length)
    throw Error('Required staging ports are occupied');
  const intent = coldActivationIntent(root, recovery, plan, current);
  if (!apply) {
    exclusive(join(root, 'service/cold-activation.json'), JSON.stringify(intent) + '\n');
    return { planned: true, ...intent, serviceControl: false, modelCalls: 0 };
  }
  if (
    JSON.stringify(privateJson(join(root, 'service/cold-activation.json'))) !==
    JSON.stringify(intent)
  )
    throw Error('Fresh activation plan changed');
  const job = 'gui/' + process.getuid() + '/com.mitzo.staging';
  // Only the original stopped registration is unloaded. No kill/restart/force.
  failedJob(root, s);
  if (
    git(source, 'ls-remote', 'https://github.com/dimakis/mitzo.git', 'refs/heads/main').split(
      /\s+/,
    )[0] !== current
  )
    throw Error('Accepted main changed before recovery control');
  exclusive(join(recovery.archive, 'activation-attempt.json'), JSON.stringify(intent) + '\n');
  run('/bin/launchctl', ['bootout', job]);
  const temporary = join(root, 'service/com.mitzo.staging.plist.recovery');
  exclusive(temporary, bytes(join(owned, 'staging-custodian.plist')));
  renameSync(temporary, join(root, 'service/com.mitzo.staging.plist'));
  sync(join(root, 'service'));
  const topology = join(root, 'service/topology.json');
  cpSync(topology, join(recovery.archive, 'original-topology-before-activation.json'), {
    errorOnExist: true,
    force: false,
  });
  exclusive(
    topology + '.recovery',
    JSON.stringify({
      mode: 'owned-custodian',
      sourceCommit: current,
      transitionId: recovery.operation,
    }) + '\n',
  );
  renameSync(topology + '.recovery', topology);
  sync(join(root, 'service'));
  run('/bin/launchctl', [
    'bootstrap',
    'gui/' + process.getuid(),
    join(root, 'service/com.mitzo.staging.plist'),
  ]);
  run('/bin/launchctl', ['kickstart', job]);
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    try {
      return await (testTools?.verify ?? verifyFreshRecovery)(root, source, current);
    } catch {
      /* One original start only; keep lock on unproven readiness. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Error('Fresh original owner readiness uncertain; retain lock, never restart');
}

function portPids(port) {
  const p = spawnSync('/usr/sbin/lsof', ['-t', '-iTCP:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  if (p.status === 1 && !p.stdout) return [];
  if (p.status !== 0) throw Error('Listener inventory uncertain');
  return [...new Set(p.stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
}
export async function verifyFreshRecovery(root, source, current) {
  const { recovery, lock } = await preparedCold(root, false);
  const { readOwnedReleasePlan, verifyRetainedOwnedRelease } =
    await import('../../dist/symposium-owned-release.js');
  const { assertCanonicalOwnerRuntime } = await import('../../dist/symposium-canonical-control.js');
  const { observeCanonicalProcess } =
    await import('../../dist/symposium-canonical-owner-record.js');
  const owned = join(root, 'symposium/service'),
    plan = readOwnedReleasePlan(join(owned, 'owned-release.json')),
    intent = privateJson(join(root, 'service/cold-activation.json'));
  if (plan.sourceCommit !== current || plan.releaseRoot !== source || intent.target !== current)
    throw Error('Exact fresh recovery target required');
  verifyRetainedOwnedRelease(plan);
  validateColdActivationBinding(root, recovery, plan, current, intent);
  if (
    JSON.stringify(privateJson(join(recovery.archive, 'activation-attempt.json'))) !==
    JSON.stringify(intent)
  )
    throw Error('Preserved activation attempt changed');
  const owner = privateJson(join(owned, 'original-owner.json'));
  const db = new Database(join(root, 'registry/staging.db'), {
    readonly: true,
    fileMustExist: true,
  });
  let row;
  try {
    const rows = db.prepare('SELECT * FROM launches').all();
    if (
      rows.length !== 1 ||
      db.prepare('SELECT capacity FROM policy WHERE id=1').get()?.capacity !== 1
    )
      throw Error('Original singleton launch required');
    row = rows[0];
  } finally {
    db.close();
  }
  const text = run('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/com.mitzo.staging']);
  if (
    text.match(/^\s*path = (.+)$/m)?.[1]?.trim() !== join(root, 'service/com.mitzo.staging.plist')
  )
    throw Error('Original registered control changed');
  assertCanonicalOwnerRuntime(plan, owner, row, {
    jobPid: Number(text.match(/^\s*pid = (\d+)$/m)?.[1]),
    parent: observeCanonicalProcess(owner.parent.pid),
    app: observeCanonicalProcess(owner.app.pid),
    portPids: portPids(3190),
    protectedPids: [...portPids(3100), ...portPids(3101)],
  });
  if (
    !(
      await globalThis.fetch('http://127.0.0.1:3190', {
        signal: globalThis.AbortSignal.timeout(2000),
      })
    ).ok
  )
    throw Error('HTTP readiness unavailable');
  recordOrVerifyFreshOwnerReceipt(join(recovery.archive, 'fresh-owner-verified.json'), {
    operation: recovery.operation,
    target: current,
    owner,
    nativeRetirement: false,
    oldRefusalPreserved: true,
    modelCalls: 0,
  });
  if (JSON.stringify(privateJson(join(root, 'service/deployment.lock'))) !== JSON.stringify(lock))
    throw Error('Retained lock changed');
  unlinkSync(join(root, 'service/deployment.lock'));
  sync(join(root, 'service'));
  return {
    verified: true,
    target: current,
    operation: recovery.operation,
    originalFailurePreserved: true,
    modelCalls: 0,
    productionActions: [],
  };
}

function coldActivationIntent(root, recovery, plan, current) {
  const owned = join(root, 'symposium/service');
  return {
    operation: recovery.operation,
    auditSha256: recovery.auditSha256,
    target: current,
    inputs: Object.fromEntries(
      [
        'owned-release.json',
        'staging-custodian.plist',
        'staging-operator.json',
        'empty-accounts.json',
      ].map((n) => [n, hash(bytes(join(owned, n)))]),
    ),
    registrationSha256: hash(bytes(join(root, 'symposium/settings/staging-registration.json'))),
    configSha256: plan.configSha256,
  };
}
export function validateColdActivationBinding(root, recovery, plan, current, intent) {
  if (
    JSON.stringify(coldActivationIntent(root, recovery, plan, current)) !== JSON.stringify(intent)
  )
    throw Error('Full activation intent or prepared inputs changed; retain lock');
}
