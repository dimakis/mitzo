import {
  validateKeyRefusalRegistration,
  validateLoadedHistoricalJob,
} from './staging-cold-plist.mjs';
import { controlHashes, verifyHistoricalControls } from './staging-key-controls.mjs';
import process from 'node:process';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';
import Database from 'better-sqlite3';
import { bytes, hash, directory, inventory, git, run, counts } from './staging-cold-audit.mjs';
import {
  privateJson,
  artifacts,
  fingerprintDirectory,
  assertVisibleTrackedIndex,
} from './staging-files.mjs';
import { preparedCold, failedJob, validateColdActivationBinding } from './staging-cold-control.mjs';
import { classifyKeyRefusal } from './staging-key-refusal.mjs';
import { verifyFrozenKeyGateway } from './staging-key-material.mjs';
export async function auditKeyRefusal(root) {
  if (process.platform !== 'darwin') throw Error('Canonical macOS qualification required');
  const previous = await preparedCold(root, false);
  if (previous.recovery.version !== 1)
    throw Error('Only one exact first recovery attempt may be qualified');
  const owned = join(root, 'symposium/service');
  for (const p of [
    '',
    'service',
    'registry',
    'symposium',
    'symposium/service',
    'symposium/workspace',
    'symposium/state/gateway',
  ])
    directory(join(root, p));
  const { readOwnedReleasePlan, verifyRetainedOwnedRelease } =
    await import('../../dist/symposium-owned-release.js');
  const { readOwnedSymposiumHostConfig } =
    await import('../../dist/symposium-owned-config-schema.js');
  const plan = readOwnedReleasePlan(join(owned, 'owned-release.json')),
    contract = JSON.parse(readFileSync(new URL('./staging-key-contract.json', import.meta.url)));
  if (
    plan.sourceCommit !== contract.sourceCommit ||
    plan.planDirectory !== owned ||
    plan.repositoryPath !== join(root, 'symposium/workspace') ||
    plan.configPath !== join(root, 'symposium/settings/owned-host.json') ||
    plan.releaseRoot !== join(root, 'releases', plan.sourceCommit.slice(0, 12))
  )
    throw Error('Exact failed recovery source required');
  verifyRetainedOwnedRelease(plan);
  const receipt = privateJson(join(plan.releaseRoot, 'staging-release.json'));
  if (
    receipt.sourceCommit !== plan.sourceCommit ||
    receipt.sourceTree !== plan.sourceTree ||
    JSON.stringify(artifacts(plan.releaseRoot)) !== JSON.stringify(receipt.compiledArtifacts) ||
    fingerprintDirectory(plan.releaseRoot, 'node_modules') !== receipt.dependencyFingerprint ||
    git(plan.releaseRoot, 'status', '--porcelain', '--untracked-files=no')
  )
    throw Error('Original prepared build or dependency evidence changed');
  assertVisibleTrackedIndex(git(plan.releaseRoot, 'ls-files', '-v'));
  for (const [p, v] of Object.entries(contract.sourceBlobs))
    if (git(plan.releaseRoot, 'rev-parse', plan.sourceCommit + ':' + p) !== v)
      throw Error('Historical source mandatory gate changed');
  for (const [p, v] of Object.entries(contract.compiledFiles))
    if (hash(bytes(join(plan.releaseRoot, p))) !== v)
      throw Error('Historical compiled mandatory gate changed');
  const config = readOwnedSymposiumHostConfig(plan.configPath);
  if (
    config.gateway.executableSha256 !== contract.gatewaySha256 ||
    config.personal.workProfiles.length ||
    config.artifacts.length ||
    JSON.stringify(privateJson(join(owned, 'empty-accounts.json'))) !== '[]'
  )
    throw Error('Only exact initial native build/configuration qualifies');
  const activation = privateJson(join(root, 'service/cold-activation.json'));
  validateColdActivationBinding(root, previous.recovery, plan, plan.sourceCommit, activation);
  if (
    JSON.stringify(privateJson(join(previous.recovery.archive, 'activation-attempt.json'))) !==
    JSON.stringify(activation)
  )
    throw Error('Original recovery activation attempt changed');
  const registrationPath = join(root, 'service/com.mitzo.staging.plist'),
    registrationBytes = bytes(registrationPath),
    preparedBytes = bytes(join(owned, 'staging-custodian.plist'));
  const plist = JSON.parse(
    run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', registrationPath]),
  );
  validateKeyRefusalRegistration(
    root,
    plan,
    registrationBytes,
    preparedBytes,
    plist,
    process.execPath,
  );
  validateLoadedHistoricalJob(
    run('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/com.mitzo.staging']),
    plist,
  );
  const registrationSha256 = hash(registrationBytes);
  failedJob(root, { registrationSha256 });
  verifyHistoricalControls(previous.recovery.archive, previous.s);
  const entries = readdirSync(config.gateway.stateParent).sort(),
    gatewayNames = entries.filter((n) => /^gateway-[A-Za-z0-9]{6}$/.test(n));
  if (
    gatewayNames.length !== 1 ||
    JSON.stringify(entries) !== JSON.stringify(['artifact-leases.db', ...gatewayNames].sort())
  )
    throw Error('Unrecognized later native startup state');
  const material = verifyFrozenKeyGateway(
    config.gateway,
    join(config.gateway.stateParent, gatewayNames[0]),
  );
  const absent = (p) => !lstatSync(p, { throwIfNoEntry: false });
  if (
    !absent(join(owned, 'original-owner.json')) ||
    !absent(config.attestationPath) ||
    !absent(join(config.gateway.stateParent, 'session-artifacts.db'))
  )
    throw Error('Later owned-host evidence prohibits classification');
  const db = new Database(join(root, 'registry/staging.db'), {
    readonly: true,
    fileMustExist: true,
  });
  let rows, qualified;
  try {
    if (db.prepare('SELECT capacity FROM policy WHERE id=1').get()?.capacity !== 1)
      throw Error('Singleton capacity required');
    rows = db.prepare('SELECT * FROM launches').all();
    qualified = db.prepare('SELECT * FROM qualified_cold_refusals').all();
  } finally {
    db.close();
  }
  const boot =
    Number(run('/usr/sbin/sysctl', ['-n', 'kern.boottime']).match(/sec = (\d+)/)?.[1]) * 1000;
  if (
    rows.length !== 1 ||
    !Number.isFinite(boot) ||
    boot >= rows[0].createdAt ||
    previous.lock.requestedAt > rows[0].createdAt ||
    rows[0].launchId === previous.recovery.originalLaunchId
  )
    throw Error('Distinct same-boot failed recovery required');
  const native = (args) =>
      JSON.parse(run(config.podman.executable, args, root, config.podman.environment)),
    vm = native(['machine', 'inspect', 'mitzo-symposium-staging'])[0];
  const vmConfigPath = join(
      config.podman.environment.XDG_CONFIG_HOME,
      'containers/podman/machine/applehv/mitzo-symposium-staging.json',
    ),
    vmConfig = JSON.parse(bytes(vmConfigPath));
  if (
    vm.Name !== 'mitzo-symposium-staging' ||
    vm.State !== 'running' ||
    vm.Rootful !== false ||
    config.podman.environment.CONTAINER_CONNECTION !== 'mitzo-symposium-staging' ||
    vmConfig.Mounts?.length !== 1 ||
    vmConfig.Mounts[0].Source !== root ||
    vmConfig.Mounts[0].Target !== root ||
    vmConfig.Mounts[0].ReadOnly !== false
  )
    throw Error('Original private VM scope changed');
  const topology = privateJson(join(root, 'service/topology.json'));
  if (
    topology.mode !== 'owned-custodian' ||
    topology.sourceCommit !== plan.sourceCommit ||
    topology.transitionId !== previous.lock.id
  )
    throw Error('Failed recovery topology changed');
  const snapshot = {
    contract: contract.id,
    operation: previous.lock.id,
    lock: previous.lock,
    plan,
    row: rows[0],
    qualified,
    activation,
    previousRecovery: previous.recovery,
    previousAuditSha256: previous.recovery.auditSha256,
    sourceContractVerified: true,
    nativeMandatoryGateVerified: true,
    ...material,
    job: { pid: null, state: 'not running', runs: 1, lastExitCode: 1 },
    originalOwnerAbsent: true,
    attestationAbsent: true,
    sessionArtifactLedgerAbsent: true,
    artifactSchemaEmpty: counts(join(config.gateway.stateParent, 'artifact-leases.db'), [], true),
    eventCounts: counts(join(plan.repositoryPath, '.mitzo/events.db'), [
      'symposium_membership',
      'symposium_seat_sandboxes',
      'symposium_creation_recoveries',
      'symposium_seat_lifecycle_fences',
    ]),
    containers: native(['ps', '--all', '--format', 'json']),
    volumes: native(['volume', 'ls', '--format', 'json']),
    serviceFiles: inventory(owned),
    workspaceFiles: inventory(plan.repositoryPath),
    gatewayFiles: inventory(config.gateway.stateParent),
    registryFiles: inventory(join(root, 'registry')),
    registrationSha256,
    registration: plist,
    nodeExecutable: process.execPath,
    controlRecords: controlHashes(join(root, 'service')),
    previousControlRecords: controlHashes(previous.recovery.archive),
    configSha256: hash(bytes(plan.configPath)),
    topology,
    vmConfigSha256: hash(bytes(vmConfigPath)),
    boot,
  };
  classifyKeyRefusal(snapshot);
  return { snapshot, auditSha256: hash(JSON.stringify(snapshot)), config };
}
