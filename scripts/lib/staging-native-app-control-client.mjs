import process from 'node:process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { verifyPreparedController } from './staging-cold-control.mjs';
import { createContainedNativeLauncherPlist } from './staging-contained-native-launcher-observation.mjs';
import { createFreshAppleHvProvisionPlan } from './staging-fresh-applehv.mjs';
import { createNativeAppCompatibilityInspector } from './staging-native-app-compatibility.mjs';
import { offlineContainmentDigest as digest } from './staging-offline-containment-contract.mjs';
import { assertStagingPipelineMutation } from './staging-pipeline-mutation-guard.mjs';
import { requestOriginalNativeAppControl } from './staging-native-app-control-transport.mjs';

const commit = /^[a-f0-9]{40}$/;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const refuse = () => Error('Original native app control client refused; preserve staging evidence');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function privateBytes(path, maximum = 262144) {
  const parent = lstatSync(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid() ||
    (parent.mode & 0o777) !== 0o700 ||
    realpathSync(dirname(path)) !== dirname(path)
  )
    throw refuse();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true }),
      bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true }),
      named = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid()) ||
      before.nlink !== 1n ||
      (before.mode & 0o777n) !== 0o600n ||
      before.size > BigInt(maximum) ||
      BigInt(bytes.length) !== before.size ||
      realpathSync(path) !== path ||
      ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].some(
        (key) => before[key] !== after[key] || before[key] !== named[key],
      )
    )
      throw refuse();
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function command(program, args, empty = false) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 65536,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (
    result.error ||
    result.signal ||
    result.stderr ||
    (result.status !== 0 && !(empty && result.status === 1 && !result.stdout))
  )
    throw refuse();
  return result.stdout.trim();
}
function portPids(port) {
  const text = command('/usr/sbin/lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], true);
  if (!text) return [];
  if (!/^[0-9]+(?:\n[0-9]+)*$/.test(text)) throw refuse();
  const pids = [...new Set(text.split('\n').map(Number))];
  if (pids.length > 16 || pids.some((pid) => !Number.isSafeInteger(pid) || pid < 2)) throw refuse();
  return pids;
}

/** Finite CLI grammar. Queue proof is accepted only from the private launch environment. */
export function parseNativeAppControlArguments(argv, environment) {
  if (
    argv.length !== 10 ||
    argv[0] !== '--allocation' ||
    argv[2] !== '--operation' ||
    argv[4] !== '--target' ||
    argv[6] !== '--expected-current' ||
    argv[8] !== '--plan-sha256' ||
    !uuid.test(argv[1]) ||
    !['resources', 'plan', 'apply'].includes(argv[3]) ||
    !commit.test(argv[5]) ||
    !commit.test(argv[7]) ||
    (argv[3] === 'apply' ? !/^[a-f0-9]{64}$/.test(argv[9]) : argv[9] !== 'none') ||
    typeof environment.MITZO_STAGING_PIPELINE_TOKEN !== 'string' ||
    !environment.MITZO_STAGING_PIPELINE_TOKEN.length ||
    environment.MITZO_STAGING_PIPELINE_TOKEN.length > 2048
  )
    throw refuse();
  return Object.freeze({
    allocation: argv[1],
    input: Object.freeze({
      version: 1,
      operation: argv[3],
      target: argv[5],
      expectedCurrent: argv[7],
      planSha256: argv[9] === 'none' ? null : argv[9],
      queueProof: environment.MITZO_STAGING_PIPELINE_TOKEN,
    }),
  });
}

/** Receipt consistency only. Owner fields must come from independent physical
 * checks; this function cannot restore native custody. */
export function assertNativeAppClientCompletion(input, nativeCommit, original, owner, context) {
  const selected = owner.acceptedAppSource?.acceptedAppCommit ?? owner.sourceCommit;
  if (!context || !['before-request', 'after-response'].includes(context.phase)) throw refuse();
  if (context.phase === 'before-request' || input.operation !== 'apply') {
    if (
      selected !== input.expectedCurrent ||
      (original &&
        (owner.instanceId !== original.instanceId ||
          owner.epoch !== original.epoch ||
          owner.app.pid !== original.app.pid))
    )
      throw refuse();
    return;
  }
  const output = context.output;
  if (
    !original ||
    !owner.acceptedAppSource ||
    selected !== input.target ||
    owner.instanceId !== original.instanceId ||
    owner.epoch <= original.epoch ||
    owner.app.pid === original.app.pid ||
    digest(owner.parent) !== digest(original.parent) ||
    !output ||
    Object.keys(output).sort().join() !==
      'acceptedAppSource,nativeAllocationChanged,nativeRetirementClaim,nativeSourceCommit,planSha256,version' ||
    output.version !== 1 ||
    output.nativeSourceCommit !== nativeCommit ||
    output.planSha256 !== input.planSha256 ||
    output.nativeAllocationChanged !== false ||
    output.nativeRetirementClaim !== false ||
    digest(output.acceptedAppSource) !== digest(owner.acceptedAppSource)
  )
    throw refuse();
}

/** Read-only historical selection. The original uncertain row is never changed
 * or inferred retired. This view grants no capacity or original-owner authority. */
export function selectNativeAppControlRow(rows, history, disposition) {
  const facts = disposition.facts,
    original = facts.original;
  const prior = rows.find((value) => value.launchId === original.launchId);
  if (!history || typeof history.recordJson !== 'string') throw refuse();
  const recorded = JSON.parse(history.recordJson);
  if (
    digest(prior) !== digest(original) ||
    digest(recorded) !== digest(original) ||
    JSON.stringify(recorded) !== history.recordJson ||
    history.launchId !== original.launchId ||
    history.classification !== 'contained_offline_native_cleanup_unconfirmed' ||
    history.proposalSha256 !== disposition.sha256 ||
    history.operationId !== facts.operation ||
    history.archive !== facts.archiveRoot ||
    history.registryBackupSha256 !== facts.registryBackupSha256 ||
    history.receiptSha256 !== facts.containmentReceiptSha256
  )
    throw refuse();
  const active = rows.filter((value) => value.launchId !== original.launchId);
  if (active.length !== 1 || active[0].state !== 'active') throw refuse();
  return active[0];
}

/** Read-only physical client qualification. A record routes observations; it
 * cannot recreate native custody. The original server independently checks its
 * retained VM/child/queue lifetime before every operation and authenticates its
 * response. This client never starts, retires, adopts or reconstructs a VM. */
export async function requestQualifiedNativeAppControl({ allocation, input }) {
  if (process.platform !== 'darwin' || !uuid.test(allocation)) throw refuse();
  const root = join(homedir(), '.local/share/mitzo-staging');
  const nativeSourceRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const prefix = join(root, 'releases') + '/';
  if (
    !nativeSourceRoot.startsWith(prefix) ||
    !/^[a-f0-9]{12}$/.test(nativeSourceRoot.slice(prefix.length))
  )
    throw refuse();
  const bootstrapPath = join(root, 'service/native-dispositions', allocation, 'bootstrap.json');
  const bootstrapBytes = privateBytes(bootstrapPath),
    bootstrap = JSON.parse(bootstrapBytes);
  if (
    bootstrap.version !== 1 ||
    bootstrap.allocation !== allocation ||
    !commit.test(bootstrap.sourceCommit) ||
    nativeSourceRoot !== join(root, 'releases', bootstrap.sourceCommit.slice(0, 12))
  )
    throw refuse();
  const nativeCommit = bootstrap.sourceCommit;
  const receipt = verifyPreparedController(root, nativeSourceRoot, nativeCommit);
  const provisioning = createFreshAppleHvProvisionPlan(bootstrap.provisioning?.plan);
  if (
    digest(provisioning) !== digest(bootstrap.provisioning) ||
    provisioning.plan.sourceRoot !== nativeSourceRoot ||
    provisioning.plan.sourceCommit !== nativeCommit ||
    provisioning.plan.allocationUUID !== allocation ||
    provisioning.plan.node.path !== process.execPath
  )
    throw refuse();
  const launcher = createContainedNativeLauncherPlist({
    root,
    allocation,
    sourceRoot: nativeSourceRoot,
    sourceCommit: nativeCommit,
    node: process.execPath,
    bootstrapSha256: sha(bootstrapBytes),
  });
  const service = join(root, 'symposium/allocations', allocation, 'service');
  const load = (name) => import(pathToFileURL(join(nativeSourceRoot, 'dist', name + '.js')).href);
  const [releases, owners, controls, files, native] = await Promise.all([
    load('symposium-owned-release'),
    load('symposium-canonical-owner-record'),
    load('symposium-canonical-control'),
    load('native-held-file-custody'),
    load('staging-contained-native-disposition'),
  ]);
  const disposition = native.createContainedNativeDispositionPlan(bootstrap.disposition.facts);
  if (digest(disposition) !== digest(bootstrap.disposition)) throw refuse();
  const plan = releases.readOwnedReleasePlan(join(service, 'owned-release.json'));
  if (
    plan.sourceCommit !== nativeCommit ||
    plan.releaseRoot !== nativeSourceRoot ||
    plan.planDirectory !== service ||
    digest(verifyPreparedController(root, nativeSourceRoot, nativeCommit)) !== digest(receipt) ||
    sha(privateBytes(bootstrapPath)) !== launcher.spec.bootstrapSha256
  )
    throw refuse();
  releases.verifyRetainedOwnedRelease(plan);
  const compatibility = createNativeAppCompatibilityInspector({
    canonicalRoot: root,
    nativeSourceRoot,
    nativeCommit,
  });
  const registryPath = join(root, 'registry/staging.db');
  const held = [];
  const capture = (path, expected, maximumBytes) => {
    const uid = lstatSync(path).uid;
    if (![0, process.getuid()].includes(uid)) throw refuse();
    const file = files.captureOriginalImmutableFile({
      path,
      sha256: expected,
      maximumBytes,
      uid,
      assertCurrent() {
        if (realpathSync(nativeSourceRoot) !== nativeSourceRoot) throw refuse();
      },
    });
    held.push(file);
  };
  let originalPeer, originalOwner;
  const assertServerCurrent = (peer, context) => {
    for (const file of held) file.assertCurrent();
    if (
      !peer ||
      peer.uid !== process.getuid() ||
      peer.ppid !== 1 ||
      peer.executable !== process.execPath ||
      (originalPeer && digest(peer) !== digest(originalPeer))
    )
      throw refuse();
    const owner = controls.CanonicalOwnerSchema.parse(
      JSON.parse(privateBytes(join(service, 'original-owner.json'))),
    );
    const plistPath = join(root, 'service/com.mitzo.staging.plist');
    if (
      owner.parent.pid !== peer.pid ||
      sha(privateBytes(plistPath, 32768)) !== launcher.sha256 ||
      sha(privateBytes(bootstrapPath)) !== launcher.spec.bootstrapSha256 ||
      digest(JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]))) !==
        digest(launcher.fields)
    )
      throw refuse();
    const text = command('/bin/launchctl', ['print', `gui/${process.getuid()}/com.mitzo.staging`]);
    const field = (name) => text.match(new RegExp('^\\s*' + name + ' = (.+)$', 'm'))?.[1]?.trim();
    if (
      field('path') !== plistPath ||
      field('state') !== 'running' ||
      field('runs') !== '1' ||
      Number(field('pid')) !== peer.pid ||
      command('/bin/ps', ['-p', String(peer.pid), '-o', 'command=']) !==
        launcher.fields.ProgramArguments.join(' ')
    )
      throw refuse();
    const registryParent = lstatSync(dirname(registryPath)),
      registry = lstatSync(registryPath);
    if (
      !registryParent.isDirectory() ||
      registryParent.uid !== process.getuid() ||
      (registryParent.mode & 0o777) !== 0o700 ||
      realpathSync(dirname(registryPath)) !== dirname(registryPath) ||
      !registry.isFile() ||
      registry.isSymbolicLink() ||
      registry.uid !== process.getuid() ||
      registry.nlink !== 1 ||
      (registry.mode & 0o777) !== 0o600
    )
      throw refuse();
    const db = new DatabaseSync(registryPath, { readOnly: true });
    let row;
    try {
      const rows = db.prepare('SELECT * FROM launches WHERE state != ?').all('retired');
      if (db.prepare('SELECT capacity FROM policy WHERE id=1').get()?.capacity !== 1)
        throw refuse();
      const history = db
        .prepare('SELECT * FROM contained_owned_launches WHERE launchId=?')
        .get(disposition.facts.original.launchId);
      row = selectNativeAppControlRow(rows, history, disposition);
      if (
        sha(privateBytes(join(disposition.facts.archiveRoot, 'containment-receipt.json'))) !==
        disposition.facts.containmentReceiptSha256
      )
        throw refuse();
    } finally {
      db.close();
    }
    const parent = owners.observeCanonicalProcess(owner.parent.pid),
      app = owners.observeCanonicalProcess(owner.app.pid);
    if (parent.parentPid !== 1) throw refuse();
    controls.assertCanonicalOwnerRuntime(
      plan,
      owner,
      row,
      {
        jobPid: peer.pid,
        parent,
        app,
        portPids: portPids(3190),
        protectedPids: [...portPids(3100), ...portPids(3101)],
      },
      (source) => {
        compatibility.inspect(source.acceptedAppCommit);
      },
    );
    assertNativeAppClientCompletion(input, nativeCommit, originalOwner, owner, context);
    assertStagingPipelineMutation({
      target: input.target,
      apply: input.operation === 'apply',
      proof: input.queueProof,
    });
    if (digest(verifyPreparedController(root, nativeSourceRoot, nativeCommit)) !== digest(receipt))
      throw refuse();
    originalPeer ??= Object.freeze({ ...peer });
    originalOwner ??= owner;
  };
  try {
    capture(
      join(disposition.facts.archiveRoot, 'original-registry.db'),
      disposition.facts.registryBackupSha256,
      64 * 1024 ** 2,
    );
    capture(process.execPath, provisioning.plan.node.sha256, 256 * 1024 ** 2);
    capture(
      provisioning.plan.peerInspector.path,
      provisioning.plan.peerInspector.sha256,
      1024 ** 2,
    );
    capture(
      join(nativeSourceRoot, 'scripts/native/staging-vm-peer.c'),
      provisioning.plan.peerInspector.sourceSha256,
      1024 ** 2,
    );
    capture(
      join(nativeSourceRoot, 'dist/staging-vm-peer/build.json'),
      provisioning.plan.peerInspector.buildReceiptSha256,
      8192,
    );
    return await requestOriginalNativeAppControl({
      root,
      allocation,
      input,
      approvedPeerInspector: provisioning.plan.peerInspector,
      assertServerCurrent,
    });
  } finally {
    for (const file of held) file.close();
  }
}
