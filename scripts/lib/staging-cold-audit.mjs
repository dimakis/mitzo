import process from 'node:process';
import { readFileSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { URL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  privateJson,
  assertVisibleTrackedIndex,
  fingerprintDirectory,
  artifacts,
} from './staging-files.mjs';
import { classifyColdRefusal } from './staging-cold-refusal.mjs';
import { validateHistoricalColdPlist } from './staging-cold-plist.mjs';
export const hash = (b) => createHash('sha256').update(b).digest('hex');
export function bytes(p) {
  const s = lstatSync(p);
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.nlink !== 1 ||
    s.uid !== process.getuid() ||
    s.mode & 0o022 ||
    realpathSync(p) !== p
  )
    throw Error('Owned unaliased evidence required');
  return readFileSync(p);
}
export function directory(p) {
  const s = lstatSync(p);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid() ||
    (s.mode & 0o777) !== 0o700 ||
    realpathSync(p) !== p
  )
    throw Error('Private canonical directory required');
}
export function run(
  program,
  args,
  cwd,
  env = {
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
  },
) {
  const p = spawnSync(program, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (p.status !== 0) throw Error('Read-only qualification refused: ' + program);
  return p.stdout.trim();
}
export const git = (cwd, ...args) =>
  run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], cwd);
export function inventory(root) {
  const out = {};
  function walk(p) {
    const s = lstatSync(p);
    if (s.uid !== process.getuid() || s.isSymbolicLink() || realpathSync(p) !== p)
      throw Error('Evidence tree alias refused');
    if (s.isDirectory()) {
      for (const n of readdirSync(p).sort()) walk(join(p, n));
    } else if (s.isFile()) {
      out[relative(root, p)] = { sha256: hash(bytes(p)), mode: s.mode & 0o777 };
    } else throw Error('Unsupported evidence payload');
  }
  walk(root);
  return out;
}
function counts(path, names, emptySchema = false) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (emptySchema)
      return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length === 0;
    return names.map((n) => db.prepare('SELECT COUNT(*) AS n FROM ' + n).get().n);
  } finally {
    db.close();
  }
}
export async function auditColdRefusal(root) {
  const { readOwnedReleasePlan, verifyRetainedOwnedRelease } =
    await import('../../dist/symposium-owned-release.js');
  const { readOwnedSymposiumHostConfig } =
    await import('../../dist/symposium-owned-config-schema.js');
  if (process.platform !== 'darwin') throw Error('Sealed macOS qualification required');
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
  const owned = join(root, 'symposium/service'),
    lock = privateJson(join(root, 'service/deployment.lock')),
    transition = privateJson(join(owned, 'transition.json'));
  if (!/^[a-f0-9-]{36}$/.test(lock.id)) throw Error('Exact original transition required');
  const uncertain = privateJson(join(owned, 'transition-' + lock.id + '-uncertain.json'));
  if (
    uncertain.id !== lock.id ||
    uncertain.state !== 'uncertain' ||
    uncertain.target !== lock.target ||
    uncertain.controllerSource !== lock.controllerSource
  )
    throw Error('Original transition failure receipt changed');
  const plan = readOwnedReleasePlan(join(owned, 'owned-release.json'));
  if (
    plan.planDirectory !== owned ||
    plan.repositoryPath !== join(root, 'symposium/workspace') ||
    plan.sourceCommit !== lock.target ||
    plan.releaseRoot !== join(root, 'releases', plan.sourceCommit.slice(0, 12))
  )
    throw Error('Exact original canonical plan required');
  verifyRetainedOwnedRelease(plan);
  const receipt = privateJson(join(plan.releaseRoot, 'staging-release.json'));
  if (
    receipt.sourceCommit !== plan.sourceCommit ||
    receipt.sourceTree !== plan.sourceTree ||
    JSON.stringify(artifacts(plan.releaseRoot)) !== JSON.stringify(receipt.compiledArtifacts) ||
    fingerprintDirectory(plan.releaseRoot, 'node_modules') !== receipt.dependencyFingerprint
  )
    throw Error('Original prepared build or dependency evidence changed');
  assertVisibleTrackedIndex(git(plan.releaseRoot, 'ls-files', '-v'));
  const contract = JSON.parse(
    readFileSync(new URL('./staging-cold-contract.json', import.meta.url)),
  );
  for (const [p, v] of Object.entries(contract.sourceBlobs))
    if (git(plan.releaseRoot, 'rev-parse', plan.sourceCommit + ':' + p) !== v)
      throw Error('Historical source has no recognized mandatory pre-native gate');
  for (const [p, v] of Object.entries(contract.compiledFiles))
    if (hash(bytes(join(plan.releaseRoot, p))) !== v)
      throw Error('Historical compiled gate is not recognized');
  const config = readOwnedSymposiumHostConfig(plan.configPath);
  if (
    config.personal.workProfiles.length ||
    config.artifacts.length ||
    JSON.stringify(privateJson(join(owned, 'empty-accounts.json'))) !== '[]'
  )
    throw Error('Only initial unconfigured staging may be qualified');
  const mounts = run('/sbin/mount', []),
    lines = mounts.split('\n');
  if (
    !lines.some((l) => / on \/ \(apfs, sealed, .*read-only/.test(l)) ||
    lines.some((l) => / on \/(?:usr|bin)(?:\/| )/.test(l))
  )
    throw Error('Original lookup paths are not on the sealed read-only root');
  for (const p of ['/usr/bin', '/bin'])
    if (realpathSync(p) !== p) throw Error('System lookup alias refused');
  for (const p of ['/usr/bin/lsof', '/bin/lsof'])
    if (lstatSync(p, { throwIfNoEntry: false }))
      throw Error('Original restricted lookup could have executed a listener probe');
  const probe = spawnSync('lsof', ['-nP', '-iTCP:' + config.gateway.port, '-sTCP:LISTEN', '-Fp'], {
    env: { PATH: contract.path },
    encoding: 'utf8',
    timeout: 3000,
  });
  const text = run('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/com.mitzo.staging']);
  const field = (name) => text.match(new RegExp('^\\s*' + name + ' = (.+)$', 'm'))?.[1]?.trim();
  const job = {
    pid: field('pid') ? Number(field('pid')) : null,
    state: field('state'),
    runs: Number(field('runs')),
    lastExitCode: Number(field('last exit code')),
  };
  const boot =
    Number(run('/usr/sbin/sysctl', ['-n', 'kern.boottime']).match(/sec = (\d+)/)?.[1]) * 1000;
  const plistPath = join(root, 'service/com.mitzo.staging.plist');
  if (
    field('path') !== plistPath ||
    !bytes(plistPath).equals(bytes(join(owned, 'staging-custodian.plist')))
  )
    throw Error('Original loaded registration changed');
  const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]));
  validateHistoricalColdPlist(root, plan, plist, process.execPath);
  if (
    plist.Label !== 'com.mitzo.staging' ||
    plist.KeepAlive !== false ||
    plist.RunAtLoad !== false ||
    plist.WorkingDirectory !== plan.releaseRoot ||
    JSON.stringify(plist.ProgramArguments) !==
      JSON.stringify([
        process.execPath,
        join(plan.releaseRoot, 'scripts/start-staging-custodian.mjs'),
        join(owned, 'owned-release.json'),
        join(root, 'symposium/settings/staging-registration.json'),
        join(owned, 'staging-operator.json'),
        '--canonical',
      ])
  )
    throw Error('Original launch environment changed');
  const db = new Database(join(root, 'registry/staging.db'), {
    readonly: true,
    fileMustExist: true,
  });
  let rows;
  try {
    if (
      db.prepare('SELECT capacity FROM policy WHERE id=1').get()?.capacity !== 1 ||
      db.prepare("SELECT name FROM sqlite_master WHERE name='qualified_cold_refusals'").get()
    )
      throw Error('Original singleton registry required');
    rows = db.prepare('SELECT * FROM launches').all();
  } finally {
    db.close();
  }
  if (rows.length !== 1 || !(boot < rows[0].createdAt) || lock.requestedAt > rows[0].createdAt)
    throw Error('Original same-boot launch record required');
  const absent = (p) => !lstatSync(p, { throwIfNoEntry: false });
  if (
    !absent(join(root, 'symposium/service/original-owner.json')) ||
    !absent(config.attestationPath) ||
    !absent(join(config.gateway.stateParent, 'session-artifacts.db'))
  )
    throw Error('Later owned-host startup evidence prohibits cold classification');
  const native = (args) =>
    JSON.parse(run(config.podman.executable, args, root, config.podman.environment));
  const vm = native(['machine', 'inspect', 'mitzo-symposium-staging'])[0];
  if (vm.Name !== 'mitzo-symposium-staging' || vm.State !== 'running' || vm.Rootful !== false)
    throw Error('Original private VM required');
  const vmConfigPath = join(
    config.podman.environment.XDG_CONFIG_HOME,
    'containers/podman/machine/applehv/mitzo-symposium-staging.json',
  );
  const vmConfig = JSON.parse(bytes(vmConfigPath));
  if (
    config.podman.environment.CONTAINER_CONNECTION !== 'mitzo-symposium-staging' ||
    vmConfig.Mounts?.length !== 1 ||
    vmConfig.Mounts[0].Source !== root ||
    vmConfig.Mounts[0].Target !== root ||
    vmConfig.Mounts[0].ReadOnly !== false
  )
    throw Error('Private VM scope changed');
  const topology = privateJson(join(root, 'service/topology.json'));
  if (
    topology.mode !== 'owned-custodian' ||
    topology.sourceCommit !== plan.sourceCommit ||
    topology.transitionId !== lock.id
  )
    throw Error('Original topology changed');
  const snapshot = {
    contract: contract.id,
    operation: lock.id,
    lock,
    transition,
    row: rows[0],
    plan,
    sourceContractVerified: true,
    sealedSystem: true,
    lookupPathsAbsent: true,
    restrictedProbeError: probe.error?.code ?? null,
    job,
    originalOwnerAbsent: true,
    gatewayDirectories: readdirSync(config.gateway.stateParent).filter((n) =>
      n.startsWith('gateway-'),
    ),
    attestationAbsent: true,
    sessionArtifactLedgerAbsent: true,
    eventCounts: counts(join(plan.repositoryPath, '.mitzo/events.db'), [
      'symposium_membership',
      'symposium_seat_sandboxes',
      'symposium_creation_recoveries',
      'symposium_seat_lifecycle_fences',
    ]),
    artifactSchemaEmpty: counts(join(config.gateway.stateParent, 'artifact-leases.db'), [], true),
    containers: native(['ps', '--all', '--format', 'json']),
    volumes: native(['volume', 'ls', '--format', 'json']),
    serviceFiles: inventory(owned),
    workspaceFiles: inventory(plan.repositoryPath),
    gatewayFiles: inventory(config.gateway.stateParent),
    registrationSha256: hash(bytes(plistPath)),
    topology,
    vmConfigSha256: hash(bytes(vmConfigPath)),
    boot,
    configSha256: hash(bytes(plan.configPath)),
    registrySha256: hash(bytes(join(root, 'registry/staging.db'))),
    registryFiles: inventory(join(root, 'registry')),
  };
  classifyColdRefusal(snapshot);
  return { snapshot, auditSha256: hash(JSON.stringify(snapshot)), config };
}
