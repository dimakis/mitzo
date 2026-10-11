import process from 'node:process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  lstatSync,
  realpathSync,
  readdirSync,
} from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  OFFLINE_CONTAINMENT_TARGET,
  createOfflineContainmentPlan,
  offlineContainmentDigest,
} from './staging-offline-containment-contract.mjs';

/** Stock Homebrew bottle bytes independently measured by the operator. The
 * upstream v5.6.2 AppleHV device construction is part of this reviewed contract;
 * a version string or filename alone never selects a direct raw attachment. */
export const OFFLINE_CONTAINMENT_NATIVE_TARGET = Object.freeze({
  machineSha256: 'f1a65c06c279469d81ba86505da625cf6088c045e1731fefaa44429bc56c3705',
  appPlistSha256: OFFLINE_CONTAINMENT_TARGET.controls[0].sha256,
  vmPlistSha256: OFFLINE_CONTAINMENT_TARGET.controls[1].sha256,
  helpers: OFFLINE_CONTAINMENT_TARGET.nativeHelpers,
});

const digest = (value) => createHash('sha256').update(value).digest('hex');
const inside = (root, path) =>
  path === root || (path.startsWith(root + '/') && resolve(path) === path);
function exactKeys(value, names) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== names.sort().join()
  )
    throw Error('Unsupported private machine definition');
}
export function validateAppleHvContainmentMachine(m, root) {
  exactKeys(m, [
    'Created',
    'GvProxy',
    'HostUser',
    'LastUp',
    'Mounts',
    'Name',
    'Resources',
    'SSH',
    'Version',
    'Swap',
    'ImagePath',
    'AppleHypervisor',
    'Starting',
    'Rosetta',
    'Ansible',
  ]);
  exactKeys(m.GvProxy, ['Debug', 'MTU', 'LogFile', 'PidFile', 'SSHPort']);
  exactKeys(m.HostUser, ['Rootful', 'UID', 'HostUserModified']);
  exactKeys(m.Resources, ['CPUs', 'DiskSize', 'Memory', 'USBs']);
  exactKeys(m.SSH, ['IdentityPath', 'Port', 'RemoteUsername']);
  exactKeys(m.ImagePath, ['Path']);
  exactKeys(m.AppleHypervisor, ['Vfkit']);
  const vf = m.AppleHypervisor.Vfkit;
  exactKeys(vf, ['LogLevel', 'Endpoint', 'BinaryPath', 'VirtualMachine', 'Rosetta']);
  exactKeys(vf.VirtualMachine, ['vcpus', 'memoryBytes', 'bootloader']);
  const boot = vf.VirtualMachine.bootloader;
  exactKeys(boot, ['kind', 'efiVariableStorePath', 'createVariableStore']);
  if (m.Mounts?.length !== 1) throw Error('Unknown configured mount');
  const mount = m.Mounts[0];
  exactKeys(mount, ['OriginalInput', 'ReadOnly', 'Source', 'Tag', 'Target', 'Type', 'VSockNumber']);
  const home = join(root, 'symposium/home');
  const disk = join(
    home,
    '.local/share/containers/podman/machine/applehv/mitzo-symposium-staging-arm64.raw',
  );
  const efi = join(
    home,
    '.local/share/containers/podman/machine/applehv/efi-bl-mitzo-symposium-staging',
  );
  const ssh = join(home, '.local/share/containers/podman/machine/machine');
  if (
    m.Name !== 'mitzo-symposium-staging' ||
    m.Version !== 1 ||
    m.Starting !== false ||
    m.Swap !== 0 ||
    m.Rosetta !== false ||
    m.Ansible !== null ||
    m.HostUser.Rootful !== false ||
    m.HostUser.UID !== process.getuid() ||
    m.HostUser.HostUserModified !== false ||
    m.Resources.CPUs !== 2 ||
    m.Resources.Memory !== 4096 ||
    m.Resources.DiskSize !== 16 ||
    !Array.isArray(m.Resources.USBs) ||
    m.Resources.USBs.length ||
    m.ImagePath.Path !== disk ||
    m.SSH.IdentityPath !== ssh ||
    m.SSH.RemoteUsername !== 'core' ||
    m.SSH.Port !== 61408 ||
    vf.BinaryPath !== null ||
    vf.Rosetta !== true ||
    vf.VirtualMachine.vcpus !== 2 ||
    vf.VirtualMachine.memoryBytes !== 4294967296 ||
    vf.Endpoint !== 'http://localhost:62752' ||
    boot.kind !== 'efi' ||
    boot.efiVariableStorePath !== efi ||
    boot.createVariableStore !== true ||
    mount.Source !== root ||
    mount.Target !== root ||
    mount.ReadOnly !== false ||
    mount.Type !== 'virtiofs' ||
    mount.VSockNumber !== null ||
    mount.OriginalInput !== '' ||
    mount.Tag !== '9a7a5dfb0b8eeb3b7a76da1cd731f8174a54' ||
    m.GvProxy.Debug !== false ||
    m.GvProxy.MTU !== 0 ||
    m.GvProxy.LogFile !== '' ||
    m.GvProxy.PidFile !== '' ||
    m.GvProxy.SSHPort !== 0
  )
    throw Error('Unreviewed storage or helper scope');
  return { disk, efi, ssh };
}
export function assertDirectRawDiskHeader(first, last) {
  if (
    !Buffer.isBuffer(first) ||
    !Buffer.isBuffer(last) ||
    first.length < 4 ||
    last.length < 8 ||
    ['514649fb', '4b444d56'].some((magic) => first.subarray(0, 4).toString('hex') === magic) ||
    first.subarray(0, 8).toString() === 'vhdxfile' ||
    last.subarray(0, 8).toString() === 'conectix' ||
    first.subarray(0, 64).toString().includes('Oracle VM VirtualBox Disk Image')
  )
    throw Error('Unsupported disk container or backing format');
}

/** The selected machine definition and raw disk are public metadata, but their
 * containing operator HOME and opaque unit must remain private and unaliased. */
export function assertPublicVmMetadataPath(path, opaque) {
  const home = join(opaque, 'home');
  if (!inside(home, path) || realpathSync(path) !== path)
    throw Error('Public VM metadata escaped private unit');
  let parent = dirname(path);
  while (inside(opaque, parent)) {
    const stat = lstatSync(parent);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      stat.mode & 0o022 ||
      realpathSync(parent) !== parent ||
      ([opaque, home].includes(parent) && (stat.mode & 0o777) !== 0o700)
    )
      throw Error('Private VM metadata ancestors changed');
    if (parent === opaque) break;
    parent = dirname(parent);
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o644
  )
    throw Error('Public VM metadata mode or identity changed');
  return stat;
}
export function assertScopedNoOpenHandles(result) {
  if (result?.status !== 1 || result.stdout || result.stderr || result.error || result.signal)
    throw Error('Scoped open handles unavailable or present');
}
export function scopedLsofArguments(paths, recursive = false) {
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.some((path) => !path.startsWith('/')) ||
    (recursive && paths.length !== 1)
  )
    throw Error('Exact scoped lsof paths required');
  return ['-nP', '-Fpn', ...(recursive ? ['+D', paths[0]] : paths)];
}
export function assertNoScopedMountAliases(table, paths) {
  const lines = table.trim().split('\n');
  if (!table.trim() || paths.some((path) => resolve(path) !== path))
    throw Error('Mount scope unavailable');
  for (const line of lines) {
    const match = /^(.+) on (\/.*?) \([^\n]+\)$/.exec(line);
    if (!match) throw Error('Unknown mount table format');
    const source = match[1].replaceAll('\\040', ' '),
      target = match[2].replaceAll('\\040', ' '),
      sourcePath = source.startsWith('/') ? resolve(source) : undefined;
    if (source.includes('\\') || target.includes('\\')) throw Error('Unknown mount path escape');
    if (
      paths.some(
        (path) =>
          inside(path, target) ||
          (sourcePath &&
            (sourcePath === '/' || inside(path, sourcePath) || inside(sourcePath, path))),
      )
    )
      throw Error('Known mounted state alias');
  }
}
const actionRequirements = [
  'fresh_operator_authentication_bound_to_reviewed_proposal',
  'durable_intent_preserving_original_uncertain_row_and_launch_intent',
  'authenticated_move_and_invalidate_original_paths',
  'independently_verify_archive_exclusion_and_dispatch_fence',
  'distinct_containment_receipt_without_native_retirement_claim',
];
function report(status, blockedReasons, observations = {}) {
  const result = {
    version: 1,
    status,
    executable: false,
    fenced: false,
    nativeCleanupConfirmed: false,
    capacityGrant: false,
    blockedReasons,
    observations,
    unmetActions: actionRequirements,
  };
  return { ...result, assessmentSha256: digest(JSON.stringify(result)) };
}

/** Single public schema: only the shared proposal contract binds observations. */
export function assessOfflineContainment(facts) {
  try {
    const plan = createOfflineContainmentPlan(facts);
    return { status: 'proposal', ...plan };
  } catch {
    return report('blocked', ['proposal_facts_unverified']);
  }
}

/** Hash the complete opaque unit without dereferencing aliases or interpreting its contents. */
export function inspectOpaquePreservationTree(root, options) {
  return inspectPrivateTree(root, options);
}
function inspectPrivateTree(
  root,
  {
    uid = process.getuid(),
    maxEntries = 100000,
    maxBytes = 64 * 1024 ** 3,
    maxDurationMs = 30000,
  } = {},
  socketCommand,
) {
  const initial = lstatSync(root),
    identities = new Set(),
    hash = createHash('sha256'),
    components = Object.fromEntries(
      ['home', 'workspace', 'gateway', 'settings', 'service'].map((name) => [
        name,
        createHash('sha256'),
      ]),
    );
  const fileDigests = new Map();
  if (!initial.isDirectory() || (initial.mode & 0o777) !== 0o700)
    throw Error('Private opaque directory required');
  let entries = 0,
    bytes = 0;
  const deadline = performance.now() + maxDurationMs;
  const walk = (path) => {
    const stat = lstatSync(path),
      identity = `${stat.dev}:${stat.ino}`;
    if (
      performance.now() > deadline ||
      ++entries > maxEntries ||
      stat.uid !== uid ||
      stat.isSymbolicLink() ||
      realpathSync(path) !== path ||
      stat.dev !== initial.dev ||
      identities.has(identity)
    )
      throw Error('Opaque state alias or bounded inventory refused');
    identities.add(identity);
    const rel = relative(root, path);
    const component = rel.startsWith('state/gateway') ? 'gateway' : rel.split('/')[0];
    const record = JSON.stringify([rel, stat.mode & 0o777, stat.dev, stat.ino]) + '\n';
    hash.update(record);
    components[component]?.update(record);
    if (stat.isDirectory()) {
      const names = readdirSync(path).sort();
      for (const name of names) walk(join(path, name));
      if (
        JSON.stringify(names) !== JSON.stringify(readdirSync(path).sort()) ||
        lstatSync(path).mtimeMs !== stat.mtimeMs
      )
        throw Error('Opaque inventory changed');
    } else if (stat.isFile()) {
      if (stat.nlink !== 1 || (bytes += stat.size) > maxBytes)
        throw Error('Opaque state alias or byte bound refused');
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (
          opened.dev !== stat.dev ||
          opened.ino !== stat.ino ||
          opened.nlink !== 1 ||
          opened.size !== stat.size
        )
          throw Error('Opaque file identity changed');
        const content = createHash('sha256'),
          buffer = Buffer.alloc(1024 * 1024);
        let offset = 0;
        while (offset < stat.size) {
          if (performance.now() > deadline) throw Error('Opaque inventory deadline exceeded');
          const count = readSync(
            fd,
            buffer,
            0,
            Math.min(buffer.length, stat.size - offset),
            offset,
          );
          if (!count) throw Error('Opaque file changed');
          content.update(buffer.subarray(0, count));
          offset += count;
        }
        const after = fstatSync(fd);
        if (
          after.nlink !== 1 ||
          after.size !== stat.size ||
          after.mtimeMs !== stat.mtimeMs ||
          after.ctimeMs !== stat.ctimeMs
        )
          throw Error('Opaque file changed');
        const contentSha256 = content.digest('hex');
        fileDigests.set(path, contentSha256);
        hash.update(contentSha256 + '\n');
        components[component]?.update(contentSha256 + '\n');
      } finally {
        closeSync(fd);
      }
    } else if (
      socketCommand &&
      stat.isSocket() &&
      rel === 'home/.podman/mitzo-symposium-staging-ignition.sock'
    ) {
      if (stat.nlink !== 1 || stat.size !== 0 || (stat.mode & 0o777) !== 0o755)
        throw Error('Exact ignition socket metadata required');
      // Podman v5.6.2 StartGenericAppleVM creates this named first-boot socket.
      // Its present birth is measured, never interpreted as preboot or cleanup.
      assertScopedNoOpenHandles(
        socketCommand('/usr/sbin/lsof', scopedLsofArguments([path]), undefined, true),
      );
      const after = lstatSync(path);
      if (
        !after.isSocket() ||
        ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'birthtimeMs', 'mtimeMs', 'ctimeMs'].some(
          (key) => after[key] !== stat[key],
        )
      )
        throw Error('Ignition socket changed during observation');
      const socketRecord =
        JSON.stringify([
          'unix_socket_closed_now',
          stat.nlink,
          stat.size,
          stat.birthtimeMs,
          stat.mtimeMs,
          stat.ctimeMs,
        ]) + '\n';
      hash.update(socketRecord);
      components[component]?.update(socketRecord);
    } else throw Error('Opaque unsupported filesystem entry');
  };
  walk(root);
  return {
    sha256: hash.digest('hex'),
    aliasFree: true,
    entries,
    bytes,
    components: Object.fromEntries(
      Object.entries(components).map(([name, value]) => [name, value.digest('hex')]),
    ),
    fileDigests,
  };
}

/** Native preservation additionally binds every configured machine attachment.
 * The optional command dependency is a constructor/test capability, never read
 * from proposal facts or CLI flags; production always uses the bounded runner. */
export function inspectOpaqueContainmentTree(
  root,
  options,
  { command: socketCommand = command } = {},
) {
  if (typeof socketCommand !== 'function') throw Error('Read-only socket observer required');
  const tree = inspectPrivateTree(root, options, socketCommand);
  const { fileDigests } = tree;
  const machine = fileDigests.get(
    join(root, 'home/.config/containers/podman/machine/applehv/mitzo-symposium-staging.json'),
  );
  const disk = fileDigests.get(
    join(
      root,
      'home/.local/share/containers/podman/machine/applehv/mitzo-symposium-staging-arm64.raw',
    ),
  );
  const efi = fileDigests.get(
    join(
      root,
      'home/.local/share/containers/podman/machine/applehv/efi-bl-mitzo-symposium-staging',
    ),
  );
  const ssh = fileDigests.get(join(root, 'home/.local/share/containers/podman/machine/machine'));
  if ([machine, disk, efi, ssh].some((sha256) => !sha256))
    throw Error('Configured opaque machine component missing');
  return {
    ...tree,
    components: {
      ...tree.components,
      machine,
      diskChain: digest(
        JSON.stringify({ disk, efi, ssh, nativeHelpers: OFFLINE_CONTAINMENT_TARGET.nativeHelpers }),
      ),
    },
  };
}

function command(
  program,
  args,
  env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
  allowDiagnostic = false,
) {
  const result = spawnSync(program, args, {
    env,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.signal || (!allowDiagnostic && result.stderr?.trim()))
    throw Error('Read-only observation unavailable');
  return result;
}

export function classifyCanonicalJobAbsence(result, uid) {
  const expected = `Could not find service "com.mitzo.staging" in domain for user gui: ${uid}`;
  const diagnostic = result.stderr?.trim();
  return {
    status:
      result.status === 113 &&
      !result.stdout &&
      (diagnostic === expected || diagnostic === `Bad request.\n${expected}`)
        ? 'absent'
        : 'unknown',
  };
}
function successful(program, args, env) {
  const result = command(program, args, env);
  if (result.status !== 0) throw Error('Read-only observation unavailable');
  return result.stdout.trim();
}

/** Only the generated receipt may be untracked in an exact prepared release.
 * This path allowance is not qualification: the complete frozen receipt,
 * compiled artifacts and dependency closure must still be verified below. */
export function assertCleanPreparedControllerStatus(status, canonicalRoot, sourceRoot, current) {
  if (
    !/^[a-f0-9]{40}$/.test(current ?? '') ||
    sourceRoot !== join(canonicalRoot, 'releases', current.slice(0, 12)) ||
    (status !== '' && status !== '?? staging-release.json')
  )
    throw Error('Clean accepted prepared controller required');
}

export async function qualifyOfflineContainmentController({ canonicalRoot, sourceRoot }) {
  const { git } = await import('./staging-cold-audit.mjs');
  const { verifyPreparedController } = await import('./staging-cold-control.mjs');
  const current = git(sourceRoot, 'rev-parse', 'HEAD');
  const remote = git(
    sourceRoot,
    'ls-remote',
    'https://github.com/dimakis/mitzo.git',
    'refs/heads/main',
  ).split(/\s+/)[0];
  assertCleanPreparedControllerStatus(
    git(sourceRoot, 'status', '--porcelain'),
    canonicalRoot,
    sourceRoot,
    current,
  );
  if (
    current !== remote ||
    git(sourceRoot, 'remote', 'get-url', 'origin') !== 'https://github.com/dimakis/mitzo.git' ||
    realpathSync(git(sourceRoot, 'rev-parse', '--show-toplevel')) !== sourceRoot
  )
    throw Error('Clean accepted controller required');
  verifyPreparedController(canonicalRoot, sourceRoot, current);
}

/** Collect only stopped-machine metadata. No VM start, gateway request, native inventory or mutation. */
async function collectOriginal(options) {
  const root = options.canonicalRoot,
    opaque = join(root, 'symposium');
  if (
    process.platform !== 'darwin' ||
    root !== OFFLINE_CONTAINMENT_TARGET.canonicalRoot ||
    realpathSync(root) !== root
  )
    throw Error('Exact canonical macOS root required');
  const { privateJson } = await import('./staging-files.mjs');
  const { bytes, hash } = await import('./staging-cold-audit.mjs');
  const privateBytes = (path) => {
    const value = bytes(path);
    if ((lstatSync(path).mode & 0o777) !== 0o600)
      throw Error('Private authority evidence required');
    return value;
  };
  const { readOwnedReleasePlan, verifyRetainedOwnedRelease } =
    await import('../../dist/symposium-owned-release.js');
  const { readOwnedSymposiumHostConfig } =
    await import('../../dist/symposium-owned-config-schema.js');
  const { CanonicalOwnerSchema } = await import('../../dist/symposium-canonical-control.js');
  const plan = readOwnedReleasePlan(join(opaque, 'service/owned-release.json'));
  const target = OFFLINE_CONTAINMENT_TARGET.original;
  if (
    !['sourceCommit', 'sourceTree', 'buildSha256', 'configSha256', 'inputsSha256'].every(
      (key) => plan[key] === target[key],
    ) ||
    plan.configPath !== join(opaque, 'settings/owned-host.json') ||
    plan.repositoryPath !== join(opaque, 'workspace') ||
    plan.planDirectory !== join(opaque, 'service')
  )
    throw Error('Pinned original release mismatch');
  verifyRetainedOwnedRelease(plan);
  if (hash(privateBytes(plan.configPath)) !== target.configSha256)
    throw Error('Pinned configuration mismatch');
  const config = readOwnedSymposiumHostConfig(plan.configPath);
  privateBytes(join(opaque, 'service/original-owner.json'));
  const owner = CanonicalOwnerSchema.parse(
    privateJson(join(opaque, 'service/original-owner.json')),
  );
  if (
    owner.instanceId !== target.instanceId ||
    owner.epoch !== 1 ||
    owner.sourceCommit !== target.sourceCommit ||
    owner.configSha256 !== target.configSha256 ||
    owner.buildSha256 !== target.buildSha256 ||
    owner.capturedAt !== target.capturedAt
  )
    throw Error('Pinned original owner mismatch');
  const { default: Database } = await import('better-sqlite3');
  privateBytes(join(root, 'registry/staging.db'));
  const db = new Database(join(root, 'registry/staging.db'), {
    readonly: true,
    fileMustExist: true,
  });
  let rows;
  try {
    rows = db.prepare('SELECT * FROM launches').all();
  } finally {
    db.close();
  }
  if (rows.length !== 1) throw Error('Exact retained launch required');
  const row = rows[0];
  if (
    !Object.entries(target)
      .filter(([key]) => !['sourceTree', 'inputsSha256', 'capturedAt'].includes(key))
      .every(([key, value]) => row[key] === value)
  )
    throw Error('Retained launch changed');
  const intentPath = join(opaque, 'service/launch.intent');
  // Intent layout and external operation inventory require independent source review.
  // Refuse unavailable evidence rather than substituting an empty history.
  const intent = privateBytes(intentPath);
  const bootText = successful('/usr/sbin/sysctl', ['-n', 'kern.boottime']);
  const boot = {
    id: successful('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']),
    startedAt: Number(/sec = (\d+)/.exec(bootText)?.[1]) * 1000,
  };
  if (
    boot.id !== OFFLINE_CONTAINMENT_TARGET.currentBoot.id ||
    boot.startedAt !== OFFLINE_CONTAINMENT_TARGET.currentBoot.startedAt
  )
    throw Error('Selected post-owner boot changed');
  const app = command(
    '/bin/launchctl',
    ['print', `gui/${process.getuid()}/com.mitzo.staging`],
    undefined,
    true,
  );
  // launchctl's expected missing-service diagnostic is not inferred from any generic command failure.
  const appJob = classifyCanonicalJobAbsence(app, process.getuid());
  const plistPath = join(homedir(), 'Library/LaunchAgents/com.mitzo.staging.vm.plist');
  const plistSha256 = hash(privateBytes(plistPath));
  const plist = JSON.parse(
    successful('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]),
  );
  const supervisorText = successful('/bin/launchctl', [
    'print',
    `gui/${process.getuid()}/com.mitzo.staging.vm`,
  ]);
  const field = (name) =>
    supervisorText.match(new RegExp(`^\\s*${name} = (.+)$`, 'm'))?.[1]?.trim();
  if (field('path') !== plistPath || plist.Label !== 'com.mitzo.staging.vm')
    throw Error('VM supervisor registration changed');
  const vmSupervisor = {
    state: field('state'),
    runs: Number(field('runs')),
    pid: field('pid') ? Number(field('pid')) : null,
    plistSha256,
    expectedPlistSha256: '8803bebb71091f2b9094d8af5de641bc99e7f613e61ce96d171d7faff0b8a0da',
    automaticRestart: plist.KeepAlive !== false || plist.RunAtLoad !== false,
  };
  const listeners = [];
  for (const port of [3190, config.gateway.port]) {
    const result = command('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
    if (
      ![0, 1].includes(result.status) ||
      (result.status === 1 && result.stdout) ||
      (result.status === 0 && !/^p\d+(?:\np\d+)*\n?$/.test(result.stdout))
    )
      throw Error('Listener observation unavailable');
    listeners.push(
      ...result.stdout
        .split('\n')
        .filter((line) => /^p\d+$/.test(line))
        .map((line) => Number(line.slice(1))),
    );
  }
  if (
    !inside(opaque, config.podman.environment.HOME) ||
    !inside(opaque, config.podman.environment.XDG_CONFIG_HOME ?? '') ||
    config.podman.environment.CONTAINER_CONNECTION !== 'mitzo-symposium-staging'
  )
    throw Error('Private VM environment escaped unit');
  const machinePath = join(
    config.podman.environment.XDG_CONFIG_HOME,
    'containers/podman/machine/applehv/mitzo-symposium-staging.json',
  );
  assertPublicVmMetadataPath(machinePath, opaque);
  const machineBytes = bytes(machinePath);
  if (hash(machineBytes) !== OFFLINE_CONTAINMENT_NATIVE_TARGET.machineSha256)
    throw Error('Exact private machine definition changed');
  const machineConfig = JSON.parse(machineBytes);
  const references = validateAppleHvContainmentMachine(machineConfig, root);
  const nativeHelpers = OFFLINE_CONTAINMENT_NATIVE_TARGET.helpers.map((pin) => {
    if (
      realpathSync(pin.path) !== pin.path ||
      hash(bytes(pin.path)) !== pin.sha256 ||
      !(lstatSync(pin.path).mode & 0o111)
    )
      throw Error('Native helper fingerprint changed');
    return { ...pin };
  });
  if (
    realpathSync(config.podman.executable) !==
    offlineContainmentNativeHelper({ nativeHelpers }, 'podman').path
  )
    throw Error('Unreviewed Podman binary');
  // Podman helpers must resolve through the pinned stock directory. Refuse every
  // supported user/system override location; do not execute an extension parser.
  for (const base of [
    '/usr/share/containers',
    '/etc/containers',
    '/opt/homebrew/etc/containers',
    join(config.podman.environment.XDG_CONFIG_HOME, 'containers'),
    join(config.podman.environment.HOME, '.config/containers'),
  ])
    for (const name of ['containers.conf', 'containers.conf.d', 'storage.conf'])
      if (lstatSync(join(base, name), { throwIfNoEntry: false }))
        throw Error('Container runtime override scope unavailable');
  const machines = JSON.parse(
    successful(
      offlineContainmentNativeHelper({ nativeHelpers }, 'podman').path,
      ['machine', 'inspect', 'mitzo-symposium-staging'],
      {
        HOME: config.podman.environment.HOME,
        XDG_CONFIG_HOME: config.podman.environment.XDG_CONFIG_HOME,
        CONTAINER_CONNECTION: 'mitzo-symposium-staging',
        PATH: '/opt/homebrew/Cellar/podman/5.6.2/libexec/podman:/usr/bin:/bin:/usr/sbin:/sbin',
        LC_ALL: 'C',
      },
    ),
  );
  if (
    !Array.isArray(machines) ||
    machines.length !== 1 ||
    machines[0].Name !== machineConfig.Name ||
    machines[0].State !== 'stopped' ||
    machines[0].Rootful !== false
  )
    throw Error('Exact private stopped machine unavailable');
  if (
    appJob.status !== 'absent' ||
    listeners.length ||
    vmSupervisor.state !== 'not running' ||
    vmSupervisor.runs !== 0 ||
    vmSupervisor.pid !== null ||
    vmSupervisor.automaticRestart ||
    vmSupervisor.plistSha256 !== OFFLINE_CONTAINMENT_NATIVE_TARGET.vmPlistSha256
  )
    throw Error('Canonical dispatch inactivity unavailable');
  if (
    !Number.isFinite(Date.parse(owner.parent.birth)) ||
    !Number.isFinite(Date.parse(owner.app.birth)) ||
    boot.startedAt <=
      Math.max(Date.parse(owner.parent.birth), Date.parse(owner.app.birth), owner.capturedAt)
  )
    throw Error('Original process death across boot unavailable');
  const statePaths = [
    config.gateway.stateParent,
    config.podman.environment.HOME,
    config.podman.environment.XDG_CONFIG_HOME,
    config.runtime.policy,
    config.runtime.seed,
    config.attestationPath,
    ...Object.values(config.gateway.tls),
    ...Object.values(config.gateway.jwt),
    ...config.providerProfiles.map((profile) => profile.path),
  ];
  if (
    statePaths.some((path) => !inside(opaque, path)) ||
    config.personal.workProfiles.length ||
    config.artifacts.length ||
    config.personal.deviceLoginExecutable
  )
    throw Error('Configured external runtime or writable scope unavailable');
  const socket = machines[0].ConnectionInfo?.PodmanSocket?.Path;
  if (socket !== config.gateway.podmanSocket) throw Error('Private compute socket scope changed');
  const gatewayEntries = readdirSync(config.gateway.stateParent).filter((name) =>
    /^gateway-[A-Za-z0-9]+$/.test(name),
  );
  if (gatewayEntries.length !== 1) throw Error('Exact frozen gateway configuration unavailable');
  const { verifyFrozenGatewayToml } = await import('./staging-key-material.mjs');
  // The complete-source matcher refuses extra runtime/provider sections. Three
  // matching TOML lines cannot establish the absence of alternate drivers.
  const gatewayRoot = join(config.gateway.stateParent, gatewayEntries[0]);
  const toml = bytes(join(gatewayRoot, 'gateway.toml'));
  if (hash(toml) !== 'c4aa17e20e662d0e6a9f8141b7576f83819043c8d11c142a0cc7e01163cba5d1')
    throw Error('Original complete gateway TOML changed');
  verifyFrozenGatewayToml(config.gateway, gatewayRoot, toml.toString('utf8'));
  // The full original source/config hashes and fixed machine definition close the
  // supported compute route; secret-bearing gateway bodies are never reported.
  const diskStat = lstatSync(references.disk);
  assertPublicVmMetadataPath(references.disk, opaque);
  if (
    !diskStat.isFile() ||
    diskStat.isSymbolicLink() ||
    diskStat.nlink !== 1 ||
    diskStat.uid !== process.getuid() ||
    realpathSync(references.disk) !== references.disk ||
    diskStat.size !== 16 * 1024 ** 3
  )
    throw Error('Private raw disk identity unavailable');
  const diskFd = openSync(references.disk, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const first = Buffer.alloc(512),
      last = Buffer.alloc(512);
    if (
      readSync(diskFd, first, 0, 512, 0) !== 512 ||
      readSync(diskFd, last, 0, 512, diskStat.size - 512) !== 512
    )
      throw Error('Disk container header unavailable');
    assertDirectRawDiskHeader(first, last);
  } finally {
    closeSync(diskFd);
  }
  privateBytes(references.ssh);
  const efi = lstatSync(references.efi);
  if (
    !efi.isFile() ||
    efi.isSymbolicLink() ||
    efi.nlink !== 1 ||
    efi.uid !== process.getuid() ||
    realpathSync(references.efi) !== references.efi
  )
    throw Error('Private EFI state unavailable');
  const appPlistPath = join(root, 'service/com.mitzo.staging.plist');
  if (hash(privateBytes(appPlistPath)) !== OFFLINE_CONTAINMENT_NATIVE_TARGET.appPlistSha256)
    throw Error('Original application binding changed');
  const tree = inspectOpaqueContainmentTree(opaque);
  assertScopedNoOpenHandles(
    command('/usr/sbin/lsof', scopedLsofArguments([opaque], true), undefined, true),
  );
  assertScopedNoOpenHandles(
    command('/usr/sbin/lsof', scopedLsofArguments([appPlistPath, plistPath]), undefined, true),
  );
  const mountTable = successful('/sbin/mount', []);
  assertNoScopedMountAliases(mountTable, [opaque]);
  const archiveRoot = join(root + '-quarantine', options.operationId);
  if (lstatSync(archiveRoot, { throwIfNoEntry: false }))
    throw Error('Archive operation already exists');
  let ancestor = dirname(archiveRoot);
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor);
  const archiveParent = lstatSync(ancestor);
  if (
    !archiveParent.isDirectory() ||
    archiveParent.uid !== process.getuid() ||
    realpathSync(ancestor) !== ancestor ||
    archiveParent.mode & 0o022
  )
    throw Error('Private external archive parent unavailable');
  assertNoScopedMountAliases(mountTable, [dirname(archiveRoot)]);
  const confirmed = (value) => ({
    status: 'confirmed',
    evidenceSha256: hash(JSON.stringify(value)),
  });
  const unknown = (reason) => ({ status: 'unknown', reason });
  return {
    version: 1,
    operatorUid: process.getuid(),
    canonicalRoot: root,
    archiveRoot,
    futureRoots: [root],
    original: { ...target, ownerBirthAt: Date.parse(owner.parent.birth) },
    currentBoot: boot,
    retained: {
      state: row.state,
      rowSha256: offlineContainmentDigest(row),
      intentSha256: hash(intent),
      retirementReceipt: lstatSync(join(config.gateway.stateParent, 'custodian-retirement.json'), {
        throwIfNoEntry: false,
      })
        ? 'present'
        : 'absent',
    },
    scope: {
      nativeExecution: 'selected_vm_only',
      hostOperations: 'none',
      inventory: 'configured_unit_manifest',
    },
    units: [
      {
        kind: 'opaque_symposium',
        path: opaque,
        archivePath: join(archiveRoot, 'symposium'),
        manifestSha256: tree.sha256,
        uid: process.getuid(),
        mode: 0o700,
        components: tree.components,
      },
    ],
    controls: [
      {
        kind: 'app',
        path: appPlistPath,
        archivePath: join(archiveRoot, 'controls/com.mitzo.staging.plist'),
        uid: process.getuid(),
        mode: 0o600,
        registrationState: 'absent',
        sha256: OFFLINE_CONTAINMENT_NATIVE_TARGET.appPlistSha256,
        label: 'com.mitzo.staging',
      },
      {
        kind: 'vm_supervisor',
        path: plistPath,
        archivePath: join(archiveRoot, 'controls/com.mitzo.staging.vm.plist'),
        uid: process.getuid(),
        mode: 0o600,
        registrationState: 'loaded_stopped',
        sha256: OFFLINE_CONTAINMENT_NATIVE_TARGET.vmPlistSha256,
        label: 'com.mitzo.staging.vm',
      },
    ],
    nativeHelpers,
    proofs: {
      dispatchClosure: unknown('Original supported control paths require authenticated relocation'),
      vmStopped: confirmed({
        machineSha256: hash(machineBytes),
        state: 'stopped',
        supervisor: vmSupervisor,
      }),
      noOpenHandles: confirmed({
        scope: opaque,
        observation: 'scoped lsof empty without diagnostics',
      }),
      noMountedAliases: confirmed({ scope: opaque, mountTableSha256: hash(mountTable) }),
      autostartDisabled: unknown(
        'Loaded inactive VM registration still requires authenticated invalidation',
      ),
      archiveExcluded: unknown(
        'Archive relocation and independent future mount exclusion remain required',
      ),
      completeOpaqueState: confirmed({
        manifestSha256: tree.sha256,
        entries: tree.entries,
        bytes: tree.bytes,
      }),
      noStateAliases: confirmed({ manifestSha256: tree.sha256, privateReferences: references }),
    },
  };
}

export async function observeOfflineContainment(options, deps = {}) {
  try {
    await (deps.qualify ?? qualifyOfflineContainmentController)(options);
  } catch {
    return report('blocked', ['accepted_controller_unavailable']);
  }
  try {
    return assessOfflineContainment(await (deps.collect ?? collectOriginal)(options));
  } catch {
    return report('blocked', ['physical_observation_unavailable']);
  }
}

function assertBoundProposal(plan) {
  if (!plan?.facts || plan.sha256 !== createOfflineContainmentPlan(plan.facts).sha256)
    throw Error('Exact shared containment proposal required');
}
function invalidatedSet(kinds) {
  if (
    !Array.isArray(kinds) ||
    kinds.length > 2 ||
    new Set(kinds).size !== kinds.length ||
    kinds.some((kind) => !['app', 'vm_supervisor'].includes(kind))
  )
    throw Error('Unknown containment control phase');
  return new Set(kinds);
}
export function offlineContainmentNativeHelper(facts, kind) {
  const selected = facts.nativeHelpers.find((helper) => helper.kind === kind),
    expected = OFFLINE_CONTAINMENT_TARGET.nativeHelpers.find((helper) => helper.kind === kind);
  if (
    !selected ||
    !expected ||
    offlineContainmentDigest(selected) !== offlineContainmentDigest(expected)
  )
    throw Error('Exact selected native helper required');
  return selected;
}
export function assertOpaqueContainmentManifest(manifest, unit) {
  if (
    manifest.sha256 !== unit.manifestSha256 ||
    offlineContainmentDigest(manifest.components) !== offlineContainmentDigest(unit.components)
  )
    throw Error('Whole opaque unit manifest changed');
}
async function inspectPhysicalBoundary(plan, invalidatedControls, contained, replacementApp) {
  const facts = plan.facts,
    unit = facts.units[0],
    invalidated = invalidatedSet(invalidatedControls);
  await qualifyOfflineContainmentController({
    canonicalRoot: facts.canonicalRoot,
    sourceRoot: resolve(fileURLToPath(new URL('../..', import.meta.url))),
  });
  const { bytes, hash } = await import('./staging-cold-audit.mjs');
  const absent = (path) => !lstatSync(path, { throwIfNoEntry: false });
  const boot = successful('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
  if (boot !== facts.currentBoot.id) throw Error('Containment boot changed');
  if (replacementApp) {
    if (!contained) throw Error('Replacement app allowance requires archived containment');
    await inspectReplacementBinding(replacementApp);
  }
  for (const control of facts.controls) {
    const archived = invalidated.has(control.kind),
      path = archived ? control.archivePath : control.path;
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== facts.operatorUid ||
      (stat.mode & 0o777) !== control.mode ||
      realpathSync(path) !== path ||
      hash(bytes(path)) !== control.sha256 ||
      (archived && !absent(control.path) && !(replacementApp && control.kind === 'app'))
    )
      throw Error('Exact control relocation observation required');
    const result = command(
      '/bin/launchctl',
      ['print', `gui/${facts.operatorUid}/${control.label}`],
      undefined,
      true,
    );
    if (replacementApp && control.kind === 'app') continue;
    if (control.kind === 'app' || archived) {
      const diagnostic = result.stderr?.trim(),
        expected = `Could not find service "${control.label}" in domain for user gui: ${facts.operatorUid}`;
      if (
        result.status !== 113 ||
        result.stdout ||
        (diagnostic !== expected && diagnostic !== `Bad request.\n${expected}`)
      )
        throw Error('Original control registration still available or unknown');
    } else {
      if (result.status !== 0 || result.stderr)
        throw Error('VM supervisor observation unavailable');
      const field = (name) =>
        result.stdout.match(new RegExp(`^\\s*${name} = (.+)$`, 'm'))?.[1]?.trim();
      if (
        field('path') !== control.path ||
        field('state') !== 'not running' ||
        field('runs') !== '0' ||
        field('pid')
      )
        throw Error('Original VM supervisor changed');
    }
  }
  for (const pin of facts.nativeHelpers)
    if (realpathSync(pin.path) !== pin.path || hash(bytes(pin.path)) !== pin.sha256)
      throw Error('Native helper changed');
  const opaque = contained ? unit.archivePath : unit.path;
  if (contained && (!absent(unit.path) || invalidated.size !== 2))
    throw Error('Original opaque path remains available');
  if (lstatSync(join(opaque, 'state/gateway/custodian-retirement.json'), { throwIfNoEntry: false }))
    throw Error('Original native retirement receipt requires separate reconciliation');
  const tree = inspectOpaqueContainmentTree(opaque);
  assertOpaqueContainmentManifest(tree, unit);
  assertScopedNoOpenHandles(
    command('/usr/sbin/lsof', scopedLsofArguments([opaque], true), undefined, true),
  );
  assertScopedNoOpenHandles(
    command(
      '/usr/sbin/lsof',
      scopedLsofArguments(
        facts.controls.map((control) =>
          invalidated.has(control.kind) ? control.archivePath : control.path,
        ),
      ),
      undefined,
      true,
    ),
  );
  assertNoScopedMountAliases(successful('/sbin/mount', []), [opaque, dirname(facts.archiveRoot)]);
  if (!contained) {
    const home = join(opaque, 'home'),
      xdg = join(home, '.config');
    const machineFile = join(xdg, 'containers/podman/machine/applehv/mitzo-symposium-staging.json');
    assertPublicVmMetadataPath(machineFile, opaque);
    const definition = JSON.parse(bytes(machineFile));
    if (hash(bytes(machineFile)) !== OFFLINE_CONTAINMENT_NATIVE_TARGET.machineSha256)
      throw Error('Private machine definition changed');
    validateAppleHvContainmentMachine(definition, facts.canonicalRoot);
    const machines = JSON.parse(
      successful(
        offlineContainmentNativeHelper(facts, 'podman').path,
        ['machine', 'inspect', 'mitzo-symposium-staging'],
        {
          HOME: home,
          XDG_CONFIG_HOME: xdg,
          CONTAINER_CONNECTION: 'mitzo-symposium-staging',
          PATH: '/opt/homebrew/Cellar/podman/5.6.2/libexec/podman:/usr/bin:/bin:/usr/sbin:/sbin',
          LC_ALL: 'C',
        },
      ),
    );
    if (
      !Array.isArray(machines) ||
      machines.length !== 1 ||
      machines[0].Name !== 'mitzo-symposium-staging' ||
      machines[0].State !== 'stopped' ||
      machines[0].Rootful !== false
    )
      throw Error('Private VM resumed or observation unavailable');
  }
}

/** Inspection callbacks for the trusted transaction owner. These throw on drift;
 * successful return is not authentication, a receipt, or a capacity grant. */
export async function assertOfflineContainmentBeforeMove(
  plan,
  { invalidatedControls = [] } = {},
  deps = {},
) {
  assertBoundProposal(plan);
  invalidatedSet(invalidatedControls);
  await (deps.inspect ?? inspectPhysicalBoundary)(plan, invalidatedControls, false);
}
export async function assertOfflineContainmentContained(plan, intent, deps = {}) {
  assertBoundProposal(plan);
  if (intent?.planSha256 !== plan.sha256) throw Error('Exact durable containment intent required');
  await (deps.inspect ?? inspectPhysicalBoundary)(plan, ['app', 'vm_supervisor'], true);
}

function assertOrdinaryReplacementProof(proof) {
  exactKeys(proof, [
    'phase',
    'sourceCommit',
    'releaseRoot',
    'plistPath',
    'plistSha256',
    'launcherSha256',
    'expectedProgramArguments',
    'pid',
    'birth',
  ]);
  const root = OFFLINE_CONTAINMENT_TARGET.canonicalRoot;
  if (
    !['prepared', 'running'].includes(proof.phase) ||
    !/^[a-f0-9]{40}$/.test(proof.sourceCommit) ||
    proof.releaseRoot !== join(root, 'releases', proof.sourceCommit.slice(0, 12)) ||
    proof.plistPath !== join(root, 'service/com.mitzo.staging.plist') ||
    !/^[a-f0-9]{64}$/.test(proof.plistSha256) ||
    proof.plistSha256 === OFFLINE_CONTAINMENT_TARGET.controls[0].sha256 ||
    !/^[a-f0-9]{64}$/.test(proof.launcherSha256) ||
    !Array.isArray(proof.expectedProgramArguments) ||
    proof.expectedProgramArguments.length !== 2 ||
    proof.expectedProgramArguments[0] !== process.execPath ||
    proof.expectedProgramArguments[1] !== join(root, 'service/start.mjs')
  )
    throw Error('Exact reviewed ordinary replacement binding required');
  if (
    proof.phase === 'running'
      ? !Number.isSafeInteger(proof.pid) ||
        proof.pid < 2 ||
        typeof proof.birth !== 'string' ||
        !proof.birth.trim() ||
        proof.birth.length > 128
      : proof.pid !== null || proof.birth !== null
  )
    throw Error('Exact replacement launch phase required');
}
export function validateOrdinaryReplacementObservation(proof, observation) {
  assertOrdinaryReplacementProof(proof);
  if (
    observation.plistSha256 !== proof.plistSha256 ||
    observation.launcherSha256 !== proof.launcherSha256 ||
    JSON.stringify(observation.programArguments) !== JSON.stringify(proof.expectedProgramArguments)
  )
    throw Error('Ordinary replacement bytes or arguments changed');
  if (proof.phase === 'prepared') {
    if (observation.job?.state !== 'absent' || observation.process !== null)
      throw Error('Ordinary replacement launched before its bound phase');
  } else if (
    observation.job?.state !== 'running' ||
    observation.job.pid !== proof.pid ||
    observation.job.path !== proof.plistPath ||
    observation.process?.pid !== proof.pid ||
    observation.process.birth !== proof.birth ||
    observation.process.command !==
      proof.expectedProgramArguments[0] + ' ' + join(proof.releaseRoot, 'dist/index.js')
  )
    throw Error('Ordinary replacement process identity changed');
}
async function inspectReplacementBinding(proof) {
  const { bytes, hash } = await import('./staging-cold-audit.mjs');
  const plistStat = lstatSync(proof.plistPath);
  if ((plistStat.mode & 0o777) !== 0o600) throw Error('Replacement plist privacy changed');
  const plist = JSON.parse(
    successful('/usr/bin/plutil', ['-convert', 'json', '-o', '-', proof.plistPath]),
  );
  const result = command(
    '/bin/launchctl',
    ['print', `gui/${process.getuid()}/com.mitzo.staging`],
    undefined,
    true,
  );
  let job,
    processIdentity = null;
  if (proof.phase === 'prepared')
    job = { state: classifyCanonicalJobAbsence(result, process.getuid()).status };
  else {
    if (result.status !== 0 || result.stderr) throw Error('Replacement registration unavailable');
    const field = (name) =>
      result.stdout.match(new RegExp(`^\\s*${name} = (.+)$`, 'm'))?.[1]?.trim();
    job = { state: field('state'), pid: Number(field('pid')), path: field('path') };
    processIdentity = {
      pid: proof.pid,
      birth: successful('/bin/ps', ['-p', String(proof.pid), '-o', 'lstart=']),
      command: successful('/bin/ps', ['-p', String(proof.pid), '-o', 'command=']),
    };
  }
  validateOrdinaryReplacementObservation(proof, {
    plistSha256: hash(bytes(proof.plistPath)),
    launcherSha256: hash(bytes(proof.expectedProgramArguments[1])),
    programArguments: plist.ProgramArguments,
    job,
    process: processIdentity,
  });
}

/** Capture the independently reviewed replacement at construction. Changing a
 * caller record later cannot broaden the old-resource containment inspection. */
export function createOfflineContainmentInspectionOwner(
  { replacementApp, verifyCurrentSource } = {},
  deps = {},
) {
  if (replacementApp && typeof verifyCurrentSource !== 'function')
    throw Error('Trusted replacement source verifier required');
  if (replacementApp) assertOrdinaryReplacementProof(replacementApp);
  const captured = replacementApp ? JSON.parse(JSON.stringify(replacementApp)) : undefined;
  if (captured) {
    Object.freeze(captured.expectedProgramArguments);
    Object.freeze(captured);
  }
  return Object.freeze({
    assertBeforeMove: (plan, phase) => assertOfflineContainmentBeforeMove(plan, phase, deps),
    async assertContained(plan, intent) {
      assertBoundProposal(plan);
      if (intent?.planSha256 !== plan.sha256)
        throw Error('Exact durable containment intent required');
      if (captured) await verifyCurrentSource(captured);
      await (deps.inspect ?? inspectPhysicalBoundary)(
        plan,
        ['app', 'vm_supervisor'],
        true,
        captured,
      );
    },
  });
}
