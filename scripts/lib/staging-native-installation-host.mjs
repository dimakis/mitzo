import process from 'node:process';
import { userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import * as fs from 'node:fs';
import {
  containedNativeInstallationInputs,
  preflightContainedNativeReplica,
} from './staging-contained-native-controller.mjs';
import { createContainedNativeLauncherPlist } from './staging-contained-native-launcher-observation.mjs';
import {
  createStagingSourceAcceptanceWitness,
  SOURCE_HISTORY_SCRATCH_BYTES,
} from './staging-source-acceptance-witness.mjs';
import {
  qualifyOfflineContainmentController,
  inspectOpaquePreservationTree,
  scopedLsofArguments,
  assertScopedNoOpenHandles,
  assertNoScopedMountAliases,
} from './staging-offline-containment-observation.mjs';
import { createCompletedOfflineContainmentInspector } from './staging-contained-archive.mjs';
import { verifyPreparedController } from './staging-cold-control.mjs';
import Database from 'better-sqlite3';
import { parseMacStagingResources } from './staging-pipeline-host.mjs';
import { assessStagingResources } from './staging-resource-budget.mjs';
import { offlineContainmentDigest as digest } from './staging-offline-containment-contract.mjs';
import { installContainedNativeRegistration } from './staging-native-installation.mjs';
import { createUnmutatedNativeAllocationInspector } from './staging-native-unmutated.mjs';
const fail = () =>
  Error('Exact original native installation unavailable; preserve operation evidence');
const need = (condition) => {
  if (!condition) throw fail();
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const env = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' });
function probe(program, args) {
  return spawnSync(program, args, {
    env,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 4 * 1024 ** 2,
    shell: false,
  });
}
function command(program, args) {
  const p = probe(program, args);
  need(p.status === 0 && !p.error && !p.signal && !p.stderr);
  return p.stdout.trim();
}
function privateDirectory(path) {
  const s = fs.lstatSync(path);
  need(
    s.isDirectory() &&
      !s.isSymbolicLink() &&
      s.uid === process.getuid() &&
      (s.mode & 0o777) === 0o700 &&
      fs.realpathSync(path) === path,
  );
  return s;
}
function bytes(path, privateMode = true) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    need(
      s.isFile() &&
        s.nlink === 1 &&
        s.uid === process.getuid() &&
        !(s.mode & (privateMode ? 0o077 : 0o022)) &&
        s.size <= 262144 &&
        fs.realpathSync(path) === path,
    );
    const body = fs.readFileSync(fd),
      after = fs.fstatSync(fd);
    need(
      after.dev === s.dev &&
        after.ino === s.ino &&
        after.size === s.size &&
        after.mtimeMs === s.mtimeMs &&
        after.ctimeMs === s.ctimeMs &&
        body.length === s.size,
    );
    return body;
  } finally {
    fs.closeSync(fd);
  }
}
function sync(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function exclusive(path, body, mode = 0o600) {
  privateDirectory(dirname(path));
  const fd = fs.openSync(
    path,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    mode,
  );
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  sync(dirname(path));
}
function identity(s) {
  return { dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode & 0o777, nlink: s.nlink };
}
function portPids(port) {
  const p = probe('/usr/sbin/lsof', ['-t', '-iTCP:' + port, '-sTCP:LISTEN']);
  need(!p.error && !p.signal && !p.stderr && [0, 1].includes(p.status));
  if (p.status === 1) {
    need(!p.stdout.trim());
    return [];
  }
  const ids = [...new Set(p.stdout.trim().split(/\s+/).map(Number))];
  need(ids.length > 0 && ids.every((pid) => Number.isSafeInteger(pid) && pid > 1));
  return ids;
}
function job(root) {
  const text = command('/bin/launchctl', ['print', `gui/${process.getuid()}/com.mitzo.staging`]);
  const field = (n) => text.match(new RegExp('^\\s*' + n + ' = (.+)$', 'm'))?.[1]?.trim();
  need(field('path') === join(root, 'service/com.mitzo.staging.plist'));
  return {
    pid: field('pid') ? Number(field('pid')) : null,
    state: field('state'),
    runs: Number(field('runs')),
  };
}
function processIdentity(pid) {
  const birth = command('/bin/ps', ['-p', String(pid), '-o', 'lstart=']),
    parentPid = Number(command('/bin/ps', ['-p', String(pid), '-o', 'ppid=']));
  const names = command('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    .split('\n')
    .filter((x) => x.startsWith('n'));
  need(birth && names.length === 1 && Number.isSafeInteger(parentPid) && parentPid > 0);
  return { pid, birth, parentPid, cwd: names[0].slice(1) };
}
function absentJob(label) {
  const p = probe('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]);
  need(
    !p.error &&
      !p.signal &&
      p.status !== 0 &&
      /Could not find service/.test(p.stderr) &&
      !p.stdout.trim(),
  );
}
function topologyAbsent() {
  absentJob('com.mitzo.staging.vm');
  const rows = command('/bin/ps', ['-axo', 'comm=']);
  need(!rows.split('\n').some((row) => /(?:^|\/)(?:vfkit|gvproxy)(?:$|\s)/.test(row.trim())));
}
function closedScope(paths) {
  for (const path of paths)
    assertScopedNoOpenHandles(
      probe('/usr/sbin/lsof', scopedLsofArguments([path], fs.lstatSync(path).isDirectory())),
    );
  assertNoScopedMountAliases(command('/sbin/mount', []), paths);
}
const encoded = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const shell = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
/** Concrete source-owned host adapter. The only input authority is an actual
 * opaque private bootstrap inspection; no injectable host effects/JSON grant.
 * Construction/preflight/plan are read-only. Apply is an explicit root action. */
export async function createContainedNativeInstallationHost({ inspection }) {
  const selected = containedNativeInstallationInputs(inspection);
  // Missing native model/source cannot even observe or stop ordinary staging.
  await preflightContainedNativeReplica(inspection);
  const { root, sourceRoot, bundle, plan, allocation, bootstrapPath, bootstrapSha256 } = selected;
  need(
    process.platform === 'darwin' &&
      root === join(userInfo().homedir, '.local/share/mitzo-staging') &&
      sourceRoot === join(root, 'releases', bundle.sourceCommit.slice(0, 12)) &&
      process.cwd() === sourceRoot &&
      !process.send,
  );
  privateDirectory(root);
  privateDirectory(join(root, 'service'));
  const archive = join(root, 'service/native-dispositions', bundle.allocation),
    preservation = join(archive, 'ordinary-installation');
  privateDirectory(archive);
  need(!fs.lstatSync(preservation, { throwIfNoEntry: false }));
  const expected = createContainedNativeLauncherPlist({
    root,
    allocation: bundle.allocation,
    sourceRoot,
    sourceCommit: bundle.sourceCommit,
    node: process.execPath,
    bootstrapSha256,
  });
  const ordinary = JSON.parse(bytes(join(root, 'service/release-receipt.json'))),
    topology = JSON.parse(bytes(join(root, 'service/topology.json')));
  need(
    topology.mode === 'ordinary' &&
      topology.sourceCommit === ordinary.sourceCommit &&
      ordinary.label === 'com.mitzo.staging' &&
      ordinary.port === 3190 &&
      ordinary.bind === '127.0.0.1' &&
      ordinary.workspace === join(root, 'workspace') &&
      ordinary.release === join(root, 'releases', ordinary.sourceCommit.slice(0, 12)),
  );
  verifyPreparedController(root, ordinary.release, ordinary.sourceCommit);
  const originalJob = job(root),
    original = processIdentity(originalJob.pid),
    self = processIdentity(process.pid);
  need(
    originalJob.state === 'running' &&
      originalJob.pid > 1 &&
      originalJob.runs >= 1 &&
      original.parentPid === 1 &&
      original.cwd === ordinary.release &&
      self.cwd === sourceRoot &&
      portPids(3190).join() === String(original.pid) &&
      ![...portPids(3100), ...portPids(3101)].includes(original.pid),
  );
  const oldPlist = JSON.parse(
    command('/usr/bin/plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      join(root, 'service/com.mitzo.staging.plist'),
    ]),
  );
  need(
    oldPlist.Label === 'com.mitzo.staging' &&
      digest(oldPlist.ProgramArguments) ===
        digest([process.execPath, join(root, 'service/start.mjs')]) &&
      oldPlist.WorkingDirectory === ordinary.release &&
      oldPlist.RunAtLoad === false &&
      oldPlist.KeepAlive === false &&
      oldPlist.StandardOutPath === join(root, 'state/server.stdout.log') &&
      oldPlist.StandardErrorPath === join(root, 'state/server.stderr.log'),
  );
  topologyAbsent();
  const unmutated = createUnmutatedNativeAllocationInspector({
    allocation: bundle.allocation,
    canonicalRoot: root,
    nativeRoot: allocation.nativeRoot,
  });
  const controlNames = [
    'service/start.mjs',
    'service/release-receipt.json',
    'service/topology.json',
    'service/com.mitzo.staging.plist',
    'service/control-lib',
    'bin',
  ];
  const controls = controlNames.map((name) => {
    const path = join(root, name),
      s = fs.lstatSync(path);
    need(fs.realpathSync(path) === path && s.uid === process.getuid() && !s.isSymbolicLink());
    return {
      name,
      identity: identity(s),
      sha256: s.isDirectory()
        ? inspectOpaquePreservationTree(path).sha256
        : hash(bytes(path, false)),
    };
  });
  const directories = ['home', 'workspace', 'state', 'settings'].map((name) => ({
    name,
    identity: identity(privateDirectory(join(root, name))),
  }));
  const nextTopology = {
    mode: 'owned-custodian',
    sourceCommit: bundle.sourceCommit,
    allocation: bundle.allocation,
  };
  const wrapper = Buffer.from(
    `#!/bin/sh\nexec ${shell(process.execPath)} ${shell(join(sourceRoot, 'scripts/symposium-staging.mjs'))} "$@"\n`,
  );
  const facts = {
    version: 1,
    mode: 'install-contained-native-registration',
    allocation: bundle.allocation,
    sourceCommit: bundle.sourceCommit,
    sourceRoot,
    bootstrapPath,
    bootstrapSha256,
    dispositionPlanSha256: bundle.disposition.sha256,
    provisioningPlanSha256: bundle.provisioning.sha256,
    original,
    originalJob,
    ordinaryReceiptSha256: hash(bytes(join(root, 'service/release-receipt.json'))),
    oldRegistrationSha256: hash(bytes(join(root, 'service/com.mitzo.staging.plist'))),
    controls,
    directories,
    preservation,
    sourceSharing: {
      nativeSourceRoot: sourceRoot,
      initialAppSourceRoot: sourceRoot,
      sourceCommit: bundle.sourceCommit,
      directory: identity(privateDirectory(sourceRoot)),
      preparedReceiptSha256: hash(bytes(join(sourceRoot, 'staging-release.json'))),
      planned: true,
      actualAppObserved: false,
    },
    nativeRegistrationSha256: expected.sha256,
    topologySha256: hash(encoded(nextTopology)),
    wrapperSha256: hash(wrapper),
    nativeAuthority: false,
    nativeCleanupConfirmed: false,
  };
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  const proposal = freeze(JSON.parse(JSON.stringify({ ...facts, sha256: digest(facts) })));
  let sourceToken,
    guardFd,
    guardBody,
    guardIdentity,
    stage = 'ordinary',
    used = false,
    completed = false,
    shutdownAttempted = false,
    parentReleased = false,
    startAttempted = false,
    newJob,
    preservedUnits = [];
  const qualified = async () => {
    await qualifyOfflineContainmentController({ canonicalRoot: root, sourceRoot });
    const receipt = verifyPreparedController(root, sourceRoot, bundle.sourceCommit);
    need(digest(receipt) === bundle.disposition.facts.controllerInventorySha256);
    return receipt;
  };
  const witness = createStagingSourceAcceptanceWitness({
    canonicalRoot: root,
    sourceRoot,
    verifyFresh: qualified,
  });
  const guardPath = join(root, 'service/deployment.lock');
  const guardCurrent = () => {
    need(guardFd !== undefined && !parentReleased);
    const live = fs.lstatSync(guardPath),
      held = fs.fstatSync(guardFd);
    need(
      digest(identity(live)) === digest(guardIdentity) &&
        digest(identity(held)) === digest(guardIdentity) &&
        held.size === guardBody.length &&
        fs.readFileSync(guardPath).equals(guardBody) &&
        digest(processIdentity(process.pid)) === digest(self),
    );
  };
  const sourceCurrent = async () => {
    need(hash(bytes(bootstrapPath)) === bootstrapSha256);
    need(digest(identity(privateDirectory(sourceRoot))) === digest(facts.sourceSharing.directory));
    need(
      hash(bytes(join(sourceRoot, 'staging-release.json'))) ===
        facts.sourceSharing.preparedReceiptSha256,
    );
    const receipt = sourceToken ? await witness.assertCurrent(sourceToken) : await qualified();
    need(digest(receipt) === bundle.disposition.facts.controllerInventorySha256);
    if (guardFd !== undefined && !parentReleased) guardCurrent();
    need(hash(bytes(bootstrapPath)) === bootstrapSha256);
  };
  const assertOrdinary = () => {
    need(
      digest(job(root)) === digest(originalJob) &&
        digest(processIdentity(original.pid)) === digest(original) &&
        portPids(3190).join() === String(original.pid),
    );
    need(
      hash(bytes(join(root, 'service/release-receipt.json'))) === facts.ordinaryReceiptSha256 &&
        hash(bytes(join(root, 'service/com.mitzo.staging.plist'))) === facts.oldRegistrationSha256,
    );
    for (const c of controls) {
      const path = join(root, c.name),
        s = fs.lstatSync(path);
      need(digest(identity(s)) === digest(c.identity));
      need(
        (s.isDirectory()
          ? inspectOpaquePreservationTree(path).sha256
          : hash(bytes(path, false))) === c.sha256,
      );
    }
  };
  const assertStopped = () => {
    const j = job(root),
      p = probe('/bin/ps', ['-p', String(original.pid), '-o', 'pid=']);
    need(
      !j.pid &&
        j.state === 'not running' &&
        j.runs === originalJob.runs &&
        p.status === 1 &&
        !p.error &&
        !p.signal &&
        !p.stdout.trim() &&
        portPids(3190).length === 0,
    );
  };
  const physical = createCompletedOfflineContainmentInspector({
    recoveryPlanPath: bundle.recoveryPlanPath,
    expectedRecoveryPlan: bundle.recoveryPlanSha256,
    verifyExecutingController: sourceCurrent,
    async verifyReplacementBoundary() {
      if (stage === 'ordinary') assertOrdinary();
      else if (stage === 'stopped') assertStopped();
      else if (stage === 'unregistered') absentJob('com.mitzo.staging');
      else if (stage === 'installed') {
        const j = job(root);
        need(
          !j.pid &&
            j.runs === 0 &&
            j.state === 'not running' &&
            hash(bytes(join(root, 'service/com.mitzo.staging.plist'))) === expected.sha256,
        );
      }
      topologyAbsent();
    },
  });
  const archiveCurrent = async () => {
    const observed = await physical.verify();
    need(digest(observed) === bundle.disposition.facts.physicalEvidenceSha256);
  };
  const assertSoleOriginalRow = () => {
    privateDirectory(join(root, 'registry'));
    const path = join(root, 'registry/staging.db'),
      s = fs.lstatSync(path);
    need(
      s.isFile() &&
        s.nlink === 1 &&
        s.uid === process.getuid() &&
        (s.mode & 0o777) === 0o600 &&
        fs.realpathSync(path) === path,
    );
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      need(
        db.prepare('SELECT capacity FROM policy WHERE id=1').get()?.capacity === 1 &&
          digest(db.prepare('SELECT * FROM launches').all()) ===
            digest([bundle.disposition.facts.original]),
      );
      need(
        !db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='native_capacity_dispositions'",
          )
          .get() ||
          db.prepare('SELECT COUNT(*) AS n FROM native_capacity_dispositions').get().n === 0,
      );
    } finally {
      db.close();
    }
  };
  const preservationCurrent = () => {
    for (const unit of preservedUnits) {
      const path = join(preservation, unit.name),
        s = fs.lstatSync(path);
      need(digest(identity(s)) === digest(unit.identity));
      closedScope([path]);
      need(
        (s.isDirectory()
          ? inspectOpaquePreservationTree(path).sha256
          : hash(bytes(path, false))) === unit.sha256,
      );
    }
  };
  const current = async () => {
    await sourceCurrent();
    await archiveCurrent();
    if (guardFd !== undefined && !parentReleased) guardCurrent();
    assertSoleOriginalRow();
    preservationCurrent();
  };
  const resourceAdmission = () => {
    topologyAbsent();
    const paths = [
      root,
      ...(fs.lstatSync(root + '-quarantine', { throwIfNoEntry: false })
        ? [root + '-quarantine']
        : []),
    ];
    const usage = command('/usr/bin/du', ['-sk', ...paths]);
    const observation = parseMacStagingResources({
      pressure: command('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
      free: command('/usr/bin/memory_pressure', ['-Q']),
      swap: command('/usr/sbin/sysctl', ['vm.swapusage']),
      disk: command('/bin/df', ['-kP', root]),
      usage,
      vm: { Resources: { Memory: 0, CPUs: 0 } },
    });
    const b = bundle.provisioning.plan.budget,
      extra = SOURCE_HISTORY_SCRATCH_BYTES / 1024 ** 3;
    need(
      [b.inflightGiB, b.releaseGrowthGiB, b.scratchGrowthGiB, b.additionalGrowthGiB].every(
        (n) => Number.isFinite(n) && n >= 0,
      ),
    );
    need(
      assessStagingResources(
        observation,
        16 +
          b.inflightGiB +
          b.releaseGrowthGiB +
          b.scratchGrowthGiB +
          b.additionalGrowthGiB +
          extra,
      ).admitted,
    );
  };
  await current();
  resourceAdmission();
  await current();
  return Object.freeze({
    proposal,
    async apply(expectedPlanSha256) {
      need(!used && expectedPlanSha256 === proposal.sha256);
      used = true;
      try {
        await installContainedNativeRegistration({
          async preflight() {
            await preflightContainedNativeReplica(inspection);
            await current();
            resourceAdmission();
            sourceToken = await witness.admit(bundle.sourceCommit);
            await current();
          },
          async acquireOriginalGuard() {
            await current();
            guardBody = encoded({
              version: 1,
              mode: 'native-registration-installation',
              allocation: bundle.allocation,
              proposalSha256: proposal.sha256,
              parent: self,
            });
            guardFd = fs.openSync(
              guardPath,
              fs.constants.O_CREAT |
                fs.constants.O_EXCL |
                fs.constants.O_RDWR |
                fs.constants.O_NOFOLLOW,
              0o600,
            );
            fs.writeFileSync(guardFd, guardBody);
            fs.fsyncSync(guardFd);
            guardIdentity = identity(fs.fstatSync(guardFd));
            sync(dirname(guardPath));
            guardCurrent();
            exclusive(join(archive, 'installation-intent.json'), encoded(proposal));
          },
          async verifyOriginalOrdinary() {
            await current();
            assertOrdinary();
            for (const unit of directories)
              need(
                digest(identity(privateDirectory(join(root, unit.name)))) === digest(unit.identity),
              );
            resourceAdmission();
            await current();
          },
          async stopOriginalOrdinary() {
            await current();
            assertOrdinary();
            unmutated.assertUnchanged();
            shutdownAttempted = true;
            command('/bin/launchctl', [
              'kill',
              'SIGTERM',
              `gui/${process.getuid()}/com.mitzo.staging`,
            ]);
            stage = 'stopped';
          },
          async verifyOriginalStopped() {
            const deadline = Date.now() + 180000;
            while (true) {
              await sourceCurrent();
              guardCurrent();
              try {
                assertStopped();
                break;
              } catch {
                if (Date.now() >= deadline) throw fail();
                await wait(250);
              }
            }
            await current();
          },
          async preserveOrdinaryInputs() {
            await current();
            const paths = [
              ...directories.map((x) => join(root, x.name)),
              ...controls.map((x) => join(root, x.name)),
            ];
            closedScope(paths);
            fs.mkdirSync(preservation, { mode: 0o700 });
            sync(dirname(preservation));
            fs.mkdirSync(join(preservation, 'service'), { mode: 0o700 });
            const captured = [];
            for (const unit of [...directories, ...controls]) {
              await current();
              const path = join(root, unit.name),
                s = fs.lstatSync(path);
              need(digest(identity(s)) === digest(unit.identity));
              closedScope([path]);
              const sha256 = s.isDirectory()
                ? inspectOpaquePreservationTree(path).sha256
                : hash(bytes(path, false));
              captured.push({ name: unit.name, identity: identity(s), sha256 });
            }
            exclusive(join(preservation, 'preservation-intent.json'), encoded(captured));
            await current();
            command('/bin/launchctl', ['bootout', `gui/${process.getuid()}/com.mitzo.staging`]);
            stage = 'unregistered';
            absentJob('com.mitzo.staging');
            for (const unit of captured) {
              await current();
              const path = join(root, unit.name),
                target = join(preservation, unit.name);
              need(digest(identity(fs.lstatSync(path))) === digest(unit.identity));
              closedScope([path]);
              need(
                (fs.lstatSync(path).isDirectory()
                  ? inspectOpaquePreservationTree(path).sha256
                  : hash(bytes(path, false))) === unit.sha256,
              );
              fs.renameSync(path, target);
              sync(dirname(path));
              sync(dirname(target));
              closedScope([target]);
              need(
                (fs.lstatSync(target).isDirectory()
                  ? inspectOpaquePreservationTree(target).sha256
                  : hash(bytes(target, false))) === unit.sha256,
              );
              preservedUnits.push(Object.freeze({ ...unit }));
            }
            exclusive(join(preservation, 'preservation-completed.json'), encoded(captured));
          },
          async installStoppedNativeRegistration() {
            await current();
            for (const name of ['bin', 'home', 'workspace', 'state', 'settings']) {
              need(!fs.lstatSync(join(root, name), { throwIfNoEntry: false }));
              fs.mkdirSync(join(root, name), { mode: 0o700 });
              sync(root);
            }
            exclusive(join(root, 'bin/mitzo-staging'), wrapper, 0o700);
            exclusive(join(root, 'service/topology.json'), encoded(nextTopology));
            exclusive(join(root, 'service/com.mitzo.staging.plist'), Buffer.from(expected.bytes));
            unmutated.assertUnchanged();
            for (const name of ['owner.stdout.log', 'owner.stderr.log'])
              exclusive(join(allocation.nativeRoot, 'service', name), Buffer.alloc(0));
            await current();
            command('/bin/launchctl', [
              'bootstrap',
              `gui/${process.getuid()}`,
              join(root, 'service/com.mitzo.staging.plist'),
            ]);
            stage = 'installed';
          },
          async verifyStoppedNativeRegistration() {
            await current();
            const fields = JSON.parse(
              command('/usr/bin/plutil', [
                '-convert',
                'json',
                '-o',
                '-',
                join(root, 'service/com.mitzo.staging.plist'),
              ]),
            );
            need(
              digest(fields) === digest(expected.fields) &&
                hash(bytes(join(root, 'bin/mitzo-staging'), false)) === hash(wrapper) &&
                hash(bytes(join(root, 'service/topology.json'))) === hash(encoded(nextTopology)) &&
                portPids(3190).length === 0,
            );
          },
          async recordCompletedInstallation() {
            await current();
            exclusive(
              join(archive, 'installation-completed.json'),
              encoded({
                version: 1,
                proposalSha256: proposal.sha256,
                allocation: bundle.allocation,
                sourceCommit: bundle.sourceCommit,
                registrationSha256: expected.sha256,
                stopped: true,
                nativeAuthority: false,
                nativeCleanupConfirmed: false,
              }),
            );
            completed = true;
          },
          async releaseOwnInstallationGuard() {
            await current();
            need(completed);
            guardCurrent();
            fs.unlinkSync(guardPath);
            sync(dirname(guardPath));
            fs.closeSync(guardFd);
            guardFd = undefined;
            parentReleased = true;
            witness.close();
          },
          async startOriginalNativeLauncherOnce() {
            need(
              parentReleased &&
                completed &&
                !startAttempted &&
                !fs.lstatSync(guardPath, { throwIfNoEntry: false }),
            );
            preservationCurrent();
            verifyPreparedController(root, sourceRoot, bundle.sourceCommit);
            const j = job(root);
            need(!j.pid && j.runs === 0);
            need(
              hash(bytes(join(root, 'service/com.mitzo.staging.plist'))) === expected.sha256 &&
                hash(bytes(bootstrapPath)) === bootstrapSha256,
            );
            exclusive(
              join(archive, 'installation-start-attempt.json'),
              encoded({
                proposalSha256: proposal.sha256,
                registrationSha256: expected.sha256,
                sourceCommit: bundle.sourceCommit,
              }),
            );
            startAttempted = true;
            command('/bin/launchctl', ['kickstart', `gui/${process.getuid()}/com.mitzo.staging`]);
          },
          async observeOriginalNativeLauncher() {
            const deadline = Date.now() + 15000;
            while (true) {
              const j = job(root);
              if (j.pid) {
                need(j.state === 'running' && j.runs === 1);
                const p = processIdentity(j.pid);
                need(
                  p.cwd === sourceRoot &&
                    p.parentPid === 1 &&
                    !portPids(3100).includes(p.pid) &&
                    !portPids(3101).includes(p.pid),
                );
                newJob = p;
                break;
              }
              need(j.runs === 0 && Date.now() < deadline);
              await wait(250);
            }
            exclusive(
              join(archive, 'installation-launcher-observed.json'),
              encoded({
                proposalSha256: proposal.sha256,
                launcher: newJob,
                nativeReady: false,
                nativeAuthority: false,
              }),
            );
          },
          async retainInstallationEvidence() {
            if (guardFd !== undefined) {
              try {
                guardCurrent();
                exclusive(
                  join(archive, 'installation-uncertain.json'),
                  encoded({
                    proposalSha256: proposal.sha256,
                    shutdownAttempted,
                    parentReleased,
                    startAttempted,
                    nativeCleanupConfirmed: false,
                  }),
                );
              } catch {
                /* Original guard remains; never delete or replay. */
              }
            }
          },
        });
        return Object.freeze({
          version: 1,
          proposalSha256: proposal.sha256,
          launcher: newJob,
          nativeReady: false,
          nativeAuthority: false,
        });
      } finally {
        witness.close();
      }
    },
    close() {
      need(!used);
      witness.close();
    },
  });
}
