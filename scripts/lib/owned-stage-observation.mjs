import { assertInitialStagingFacts } from './owned-stage-empty.mjs';
import process from 'node:process';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import Database from 'better-sqlite3';
import { privateJson } from './staging-files.mjs';
import { run, bytes, hash, counts, directory, inventory } from './staging-cold-audit.mjs';
import {
  validateKeyRefusalRegistration,
  validateLoadedHistoricalJob,
} from './staging-cold-plist.mjs';
export function stageJob(root) {
  const text = run('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/com.mitzo.staging']),
    field = (n) => text.match(new RegExp('^\\s*' + n + ' = (.+)$', 'm'))?.[1]?.trim();
  if (field('path') !== join(root, 'service/com.mitzo.staging.plist'))
    throw Error('Exact canonical registration required');
  return {
    text,
    pid: field('pid') ? Number(field('pid')) : null,
    state: field('state'),
    runs: Number(field('runs')),
    exitCode: field('last exit code') ? Number(field('last exit code')) : null,
  };
}
export function listeners(port) {
  const p = spawnSync('/usr/sbin/lsof', ['-t', '-iTCP:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  if (p.status === 1 && !p.stdout) return [];
  if (p.status !== 0) throw Error('Listener inventory uncertain');
  return [...new Set(p.stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
}
export function alive(pid) {
  const p = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid='], {
    encoding: 'utf8',
    timeout: 3000,
  });
  if (p.status === 1 && !p.stdout) return false;
  if (p.status !== 0) throw Error('Process inventory uncertain');
  return true;
}
export function stageRows(root) {
  const db = new Database(join(root, 'registry/staging.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    if (db.prepare('SELECT capacity FROM policy WHERE id=1').get()?.capacity !== 1)
      throw Error('Singleton capacity required');
    return db.prepare('SELECT * FROM launches').all();
  } finally {
    db.close();
  }
}
export async function observeLiveOwner(root) {
  const { readOwnedReleasePlan, verifyRetainedOwnedRelease } =
      await import('../../dist/symposium-owned-release.js'),
    { CanonicalOwnerSchema, assertCanonicalOwnerRuntime } =
      await import('../../dist/symposium-canonical-control.js'),
    { observeCanonicalProcess } = await import('../../dist/symposium-canonical-owner-record.js'),
    { readOwnedSymposiumHostConfig } = await import('../../dist/symposium-owned-config-schema.js');
  const owned = join(root, 'symposium/service'),
    plan = readOwnedReleasePlan(join(owned, 'owned-release.json'));
  verifyRetainedOwnedRelease(plan);
  if (
    plan.planDirectory !== owned ||
    plan.repositoryPath !== join(root, 'symposium/workspace') ||
    plan.configPath !== join(root, 'symposium/settings/owned-host.json') ||
    plan.releaseRoot !== join(root, 'releases', plan.sourceCommit.slice(0, 12))
  )
    throw Error('Canonical original source required');
  const owner = CanonicalOwnerSchema.parse(privateJson(join(owned, 'original-owner.json'))),
    rows = stageRows(root),
    job = stageJob(root),
    config = readOwnedSymposiumHostConfig(plan.configPath);
  if (rows.length !== 1) throw Error('Exactly one original owner required');
  const registered = bytes(join(root, 'service/com.mitzo.staging.plist')),
    prepared = bytes(join(owned, 'staging-custodian.plist')),
    plist = JSON.parse(
      run('/usr/bin/plutil', [
        '-convert',
        'json',
        '-o',
        '-',
        join(root, 'service/com.mitzo.staging.plist'),
      ]),
    );
  validateKeyRefusalRegistration(root, plan, registered, prepared, plist, process.execPath);
  validateLoadedHistoricalJob(job.text, plist);
  assertCanonicalOwnerRuntime(plan, owner, rows[0], {
    jobPid: job.pid,
    parent: observeCanonicalProcess(owner.parent.pid),
    app: observeCanonicalProcess(owner.app.pid),
    portPids: listeners(3190),
    protectedPids: [...listeners(3100), ...listeners(3101)],
  });
  return {
    plan,
    owner,
    row: rows[0],
    config,
    plist,
    job: { pid: job.pid, state: job.state, runs: job.runs },
    ownerSha256: hash(bytes(join(owned, 'original-owner.json'))),
    planSha256: hash(bytes(join(owned, 'owned-release.json'))),
    registrationSha256: hash(registered),
    configSha256: hash(bytes(plan.configPath)),
    topology: privateJson(join(root, 'service/topology.json')),
  };
}
/** Initial unconfigured stage only: no user conversation or native credential
 * migration is implied. Actual retirement remains separately mandatory. */
export function assertEmptyStagingUse(root, live) {
  const c = live.config;
  if (
    c.artifacts.length ||
    c.personal.workProfiles.length ||
    JSON.stringify(privateJson(join(root, 'symposium/service/empty-accounts.json'))) !== '[]' ||
    lstatSync(c.attestationPath, { throwIfNoEntry: false })
  )
    throw Error('Only initial unconfigured stage update is supported');
  assertInitialStagingFacts(
    counts(join(live.plan.repositoryPath, '.mitzo/events.db'), [
      'sessions',
      'events',
      'symposium_membership',
      'symposium_seat_sandboxes',
      'symposium_creation_recoveries',
      'symposium_seat_lifecycle_fences',
    ]),
    counts(join(live.plan.repositoryPath, '.mitzo/tasks.db'), ['tasks']),
    privateJson(join(c.gateway.stateParent, 'personal-connections.json')),
  );
  const native = (args) => JSON.parse(run(c.podman.executable, args, root, c.podman.environment));
  if (
    native(['ps', '--all', '--format', 'json']).length ||
    native(['volume', 'ls', '--format', 'json']).length
  )
    throw Error('Native workload resources prevent initial fresh update');
  const vm = native(['machine', 'inspect', 'mitzo-symposium-staging'])[0],
    vmPath = join(
      c.podman.environment.XDG_CONFIG_HOME,
      'containers/podman/machine/applehv/mitzo-symposium-staging.json',
    ),
    machine = JSON.parse(bytes(vmPath));
  if (
    vm.Name !== 'mitzo-symposium-staging' ||
    vm.State !== 'running' ||
    vm.Rootful !== false ||
    c.podman.environment.CONTAINER_CONNECTION !== 'mitzo-symposium-staging' ||
    machine.Mounts?.length !== 1 ||
    machine.Mounts[0].Source !== root ||
    machine.Mounts[0].Target !== root ||
    machine.Mounts[0].ReadOnly !== false
  )
    throw Error('Original private VM scope changed');
  directory(c.gateway.stateParent);
  return {
    vmConfigSha256: hash(bytes(vmPath)),
    workspaceFiles: inventory(live.plan.repositoryPath),
  };
}
export async function verifyOriginalRetirement(root, live, requestedAt) {
  const { assertCanonicalOwnerRetired } = await import('../../dist/symposium-canonical-control.js'),
    { readCustodianRetirementReceipt } =
      await import('../../dist/symposium-custodian-retirement.js');
  const job = stageJob(root),
    rows = stageRows(root);
  if (
    job.pid ||
    job.state !== 'not running' ||
    alive(live.owner.parent.pid) ||
    alive(live.owner.app.pid) ||
    listeners(3190).length ||
    listeners(live.config.gateway.port).length ||
    rows.length !== 1 ||
    rows[0].retirementStateParent !== live.config.gateway.stateParent
  )
    throw Error('Original owner retirement remains unproven');
  const receipt = readCustodianRetirementReceipt(live.config.gateway.stateParent);
  assertCanonicalOwnerRetired(live.owner, rows[0], receipt, requestedAt);
  return {
    row: rows[0],
    receipt,
    job: { pid: null, state: job.state, runs: job.runs, exitCode: job.exitCode },
  };
}
