import process from 'node:process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  realpathSync,
  readSync,
  chmodSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout, clearTimeout } from 'node:timers';
import { OFFLINE_CONTAINMENT_TARGET } from './staging-offline-containment-contract.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const absolute = (p) =>
  typeof p === 'string' && p.startsWith('/') && resolve(p) === p && !/\s/.test(p);
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason = 'fresh canonical VM qualification') => {
  throw Error('Refused ' + reason + '; retain uncertainty');
};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
const digest = (value) => hash(JSON.stringify(canonical(value)));
function fields(value, names) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== names.split(',').sort().join()
  )
    fail();
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function freshAppleHvConfiguration() {
  const directory = dirname(
    OFFLINE_CONTAINMENT_TARGET.nativeHelpers.find((h) => h.kind === 'vfkit').path,
  );
  return `[engine]\nhelper_binaries_dir = [${JSON.stringify(directory)}]\n[machine]\nprovider = "applehv"\nrosetta = false\n`;
}
/** Reviewable fixed provisioning facts. A plan does not authorize a native operation. */
export function createFreshAppleHvProvisionPlan(input) {
  const copy = globalThis.structuredClone(input);
  const previous = copy?.qualification;
  if (copy) delete copy.qualification;
  fields(
    copy,
    'version,allocationUUID,canonicalRoot,nativeRoot,sourceRoot,sourceCommit,sourceTree,sourceInventory,bootUUID,node,helpers,oldIdentities,budget,resourcePolicy,sourceImage',
  );
  if (
    Buffer.byteLength(JSON.stringify(copy)) > 262144 ||
    copy.version !== 1 ||
    !uuid.test(copy.allocationUUID) ||
    !absolute(copy.canonicalRoot) ||
    copy.nativeRoot !== join(copy.canonicalRoot, 'symposium/allocations', copy.allocationUUID) ||
    !commit.test(copy.sourceCommit) ||
    !commit.test(copy.sourceTree) ||
    copy.sourceRoot !== join(copy.canonicalRoot, 'releases', copy.sourceCommit.slice(0, 12)) ||
    typeof copy.bootUUID !== 'string' ||
    !uuid.test(copy.bootUUID.toLowerCase())
  )
    fail('provisioning identity');
  validateSourcePins(copy);
  fields(copy.sourceImage, 'path,dev,ino,uid,mode,nlink,size,sha256,expandedBytes,compression');
  const { expandedBytes, compression, ...imageIdentity } = copy.sourceImage;
  if (!['zstd', 'xz'].includes(compression)) fail('stock image compression');
  fileIdentity(
    imageIdentity,
    join(
      copy.canonicalRoot,
      'symposium/image-sources',
      copy.sourceImage?.sha256 + '-arm64.raw.' + (compression === 'zstd' ? 'zst' : 'xz'),
    ),
    0o600,
  );
  if (
    !integer(expandedBytes) ||
    expandedBytes < 1 ||
    expandedBytes > 16 * 1073741824 ||
    copy.sourceImage.size > 1073741824 ||
    copy.budget.candidateAllocatedGiB !== 0 ||
    copy.budget.scratchGrowthGiB < copy.sourceImage.size / 1073741824
  )
    fail('bounded fresh image');
  if (!Array.isArray(copy.oldIdentities) || copy.oldIdentities.length !== 3)
    fail('retained identity exclusion');
  for (const old of copy.oldIdentities) {
    fields(old, 'dev,ino');
    if (!integer(old.dev) || !integer(old.ino)) fail();
  }
  const machineName = 'mitzo-staging-' + copy.allocationUUID.replaceAll('-', '');
  const home = join(copy.nativeRoot, 'home');
  const qualification = {
    machineName,
    ...qualifyBudget(copy),
    environment: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'),
      XDG_CACHE_HOME: join(home, '.cache'),
      TMPDIR: '/private/tmp',
      LC_ALL: 'C',
      CONTAINERS_CONF: join(copy.nativeRoot, 'settings/containers.conf'),
      CONTAINERS_MACHINE_PROVIDER: 'applehv',
      CONTAINER_CONNECTION: machineName,
      NODE_OPTIONS: '--max-old-space-size=1024',
    },
    commandArguments: [
      'machine',
      'init',
      '--image',
      copy.sourceImage.path,
      '--cpus',
      '2',
      '--memory',
      '4096',
      '--disk-size',
      '16',
      '--rootful=false',
      '--volume',
      copy.canonicalRoot + ':' + copy.canonicalRoot,
      machineName,
    ],
  };
  if (previous && digest(previous) !== digest(qualification)) fail('provisioning tuple drift');
  const plan = canonical({ ...copy, qualification });
  // These public getters remain derived; normalization never accepts caller argv.
  Object.defineProperties(plan, {
    machineName: { value: machineName, enumerable: false },
    commandArguments: { value: qualification.commandArguments, enumerable: false },
  });
  return freeze({ plan, sha256: digest(plan) });
}
/** Runs only inside the original qualified canonical controller process. All
 * four authority assertions are live callbacks, never JSON declarations. */
export async function provisionFreshAppleHvAllocation(options, effects) {
  const {
    allocation,
    canonicalRoot,
    sourceRoot,
    approvedProvisioningPlan,
    assertGuardCurrent,
    assertAcceptedSource,
    assertNativeAuthenticationCurrent,
    assertApprovedImage,
  } = options;
  if (
    [
      assertGuardCurrent,
      assertAcceptedSource,
      assertNativeAuthenticationCurrent,
      assertApprovedImage,
    ].some((fn) => typeof fn !== 'function')
  )
    fail('original provisioning authority');
  const approved = createFreshAppleHvProvisionPlan(approvedProvisioningPlan?.plan),
    p = approved.plan;
  if (
    approved.sha256 !== approvedProvisioningPlan.sha256 ||
    canonicalRoot !== p.canonicalRoot ||
    sourceRoot !== p.sourceRoot ||
    allocation?.allocationUUID !== p.allocationUUID ||
    allocation.nativeRoot !== p.nativeRoot
  )
    fail('original allocation provisioning');
  if (!effects && canonicalRoot !== OFFLINE_CONTAINMENT_TARGET.canonicalRoot)
    fail('actual canonical staging root');
  const synchronous = (fn) => {
    const result = fn();
    if (result === false || result instanceof Promise)
      fail('live synchronous provisioning authority');
  };
  const fence = async () => {
    synchronous(assertGuardCurrent);
    synchronous(assertNativeAuthenticationCurrent);
    if (
      (await assertAcceptedSource()) === false ||
      (await assertApprovedImage(p.sourceImage)) === false
    )
      fail('accepted source/image authority');
    synchronous(assertGuardCurrent);
    synchronous(assertNativeAuthenticationCurrent);
  };
  effects ??= freshAppleHvProvisionEffects(approved);
  await fence();
  await effects.verifyPrerequisites();
  await fence();
  await effects.initializeOnce({ assertCurrent: fence });
  await fence();
  const facts = await effects.capturePlan({ assertCurrent: fence });
  await fence();
  return facts;
}
function freshAppleHvProvisionEffects(approved) {
  const p = approved.plan,
    q = p.qualification,
    home = q.environment.HOME;
  const measuredFile = (path, mode, maxSize) => ({
    ...identity(path),
    sha256: checkedFile(path, { mode, maxSize }).sha256,
  });
  async function prerequisites() {
    const policy = await verifyFreshSource(p);
    for (const directory of [
      p.nativeRoot,
      home,
      join(p.nativeRoot, 'workspace'),
      join(p.nativeRoot, 'settings'),
      join(p.nativeRoot, 'service'),
    ]) {
      const s = lstatSync(directory);
      if (
        !s.isDirectory() ||
        s.isSymbolicLink() ||
        s.uid !== process.getuid() ||
        (s.mode & 0o777) !== 0o700 ||
        realpathSync(directory) !== directory
      )
        fail('fresh private allocation');
    }
    if (
      readdirSync(home).length ||
      lstatSync(q.environment.CONTAINERS_CONF, { throwIfNoEntry: false }) ||
      lstatSync(join(p.nativeRoot, 'service/fresh-vm-init-attempt.json'), { throwIfNoEntry: false })
    )
      fail('never initialized fresh allocation');
    const image = measuredFile(p.sourceImage.path, 0o600, 1073741824);
    if (!sameIdentity(image, p.sourceImage) || image.sha256 !== p.sourceImage.sha256)
      fail('independently qualified local image bytes');
    const usagePaths = [p.canonicalRoot, p.canonicalRoot + '-quarantine'];
    const usage = command('/usr/bin/du', ['-sk', ...usagePaths]).split('\n');
    if (
      usage.length !== 2 ||
      usage.some(
        (line, i) => !/^\d+\s+/.test(line) || line.replace(/^\d+\s+/, '') !== usagePaths[i],
      )
    )
      fail('provisioning aggregate observation');
    const aggregate = usage.reduce((n, line) => n + Number(line.match(/^\d+/)[0]) / 1048576, 0);
    const free = command('/bin/df', ['-kP', p.canonicalRoot])
      .split('\n')
      .at(-1)
      ?.trim()
      .split(/\s+/)[3];
    if (
      !/^\d+$/.test(free ?? '') ||
      aggregate + p.budget.inflightGiB + q.projectedGrowthGiB > policy.stagingGiB ||
      Number(free) / 1048576 - q.projectedGrowthGiB < policy.diskFreeGiB
    )
      fail('awaiting separate retention/operator plan');
    const oldJob = spawnSync(
      '/bin/launchctl',
      ['print', `gui/${process.getuid()}/com.mitzo.staging.vm`],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 1048576 },
    );
    // A removed original registration must be proved by launchd, not plan JSON.
    if (
      oldJob.error ||
      oldJob.signal ||
      oldJob.status === 0 ||
      !/Could not find service/.test(oldJob.stderr)
    )
      fail('original VM registration still present or uncertain');
  }
  return {
    verifyPrerequisites: prerequisites,
    initializeOnce: async ({ assertCurrent }) => {
      await prerequisites();
      await assertCurrent();
      // Exclusive intent is never deleted, including on failure or loss of authority.
      persistFreshVmInitializationAttempt(
        join(p.nativeRoot, 'service/fresh-vm-init-attempt.json'),
        {
          version: 1,
          planSha256: approved.sha256,
          controllerPid: process.pid,
          startedAt: Date.now(),
        },
      );
      await assertCurrent();
      writeFileSync(q.environment.CONTAINERS_CONF, freshAppleHvConfiguration(), {
        flag: 'wx',
        mode: 0o600,
      });
      await assertCurrent();
      await new Promise((resolvePromise, reject) => {
        const child = spawn(p.helpers.find((h) => h.kind === 'podman').path, q.commandArguments, {
          cwd: p.nativeRoot,
          env: q.environment,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let size = 0,
          settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          clearTimeout(tick);
          if (error) reject(error);
          else resolvePromise();
        };
        const deadline = setTimeout(
          () =>
            finish(Error('Refused uncertain one-shot VM initialization; retain files and process')),
          180000,
        );
        let tick;
        const observe = async () => {
          try {
            await assertCurrent();
            if (!settled) tick = setTimeout(observe, 1000);
          } catch (error) {
            finish(error);
          }
        };
        tick = setTimeout(observe, 1000);
        for (const stream of [child.stdout, child.stderr])
          stream.on('data', (bytes) => {
            size += bytes.length;
            if (size > 65536)
              finish(Error('Refused initialization output bound; retain uncertainty'));
          });
        child.once('error', finish);
        child.once('exit', (code, signal) =>
          finish(
            code === 0 && !signal
              ? undefined
              : Error('Refused stock initialization outcome; retain uncertainty'),
          ),
        );
      });
    },
    capturePlan: async ({ assertCurrent }) => {
      await verifyFreshSource(p);
      const name = q.machineName,
        data = join(home, '.local/share/containers/podman/machine/applehv'),
        machinePath = join(home, '.config/containers/podman/machine/applehv', name + '.json');
      const measuredMachine = machineDefinition({ ...p, machine: { path: machinePath } });
      const machine = measuredMachine.machine;
      privateParents(p, join(data, name + '-arm64.raw'));
      privateParents(p, join(home, '.local/share/containers/podman/machine/machine'));
      const disk = measuredFile(join(data, name + '-arm64.raw'), [0o600, 0o644], 16 * 1073741824);
      const ssh = measuredFile(
        join(home, '.local/share/containers/podman/machine/machine'),
        0o600,
        1048576,
      );
      const ignition = measuredFile(
        join(home, '.config/containers/podman/machine/applehv', name + '.ign'),
        [0o600, 0o644],
        1048576,
      );
      const configuration = measuredFile(q.environment.CONTAINERS_CONF, 0o600, 65536);
      const efiPath = join(data, 'efi-bl-' + name),
        parent = lstatSync(data);
      if (lstatSync(efiPath, { throwIfNoEntry: false }))
        fail('unexpected EFI store before first start');
      const efi = {
        path: efiPath,
        state: 'expected-absent',
        parent: {
          path: data,
          dev: parent.dev,
          ino: parent.ino,
          uid: parent.uid,
          mode: parent.mode & 0o777,
        },
      };
      const programArguments = [
        p.node.path,
        join(p.sourceRoot, 'scripts/start-staging-allocation-vm.mjs'),
        '--plan',
        join(p.nativeRoot, 'service/fresh-vm-plan.json'),
        '--guard',
        '/private/tmp/mitzo-vm-' + p.allocationUUID + '.sock',
      ];
      const xml = (value) =>
        String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;');
      const environment =
        '<dict>' +
        Object.entries(q.environment)
          .map(([k, v]) => '<key>' + xml(k) + '</key><string>' + xml(v) + '</string>')
          .join('') +
        '</dict>';
      const plist =
        '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.mitzo.staging.vm</string><key>ProgramArguments</key><array>' +
        programArguments.map((arg) => '<string>' + xml(arg) + '</string>').join('') +
        '</array><key>WorkingDirectory</key><string>' +
        xml(p.nativeRoot) +
        '</string><key>RunAtLoad</key><false/><key>KeepAlive</key><false/><key>EnvironmentVariables</key>' +
        environment +
        '</dict></plist>\n';
      const supervisor = {
        plistPath: join(p.nativeRoot, 'service/com.mitzo.staging.vm.plist'),
        plistSha256: hash(plist),
        programArguments,
        workingDirectory: p.nativeRoot,
        label: 'com.mitzo.staging.vm',
        keepAlive: false,
        runAtLoad: false,
        initialRuns: 0,
      };
      const { sourceImage, qualification, ...base } = p;
      void sourceImage;
      void qualification;
      // The original image/source callbacks must independently qualify the image's
      // expanded upper bound before init. Runtime disk identity is measured here.
      const vm = createFreshAppleHvPlan({
        ...base,
        machine: {
          path: machinePath,
          sha256: measuredMachine.sha256,
          definition: machine,
        },
        files: { disk, efi, ssh, configuration, ignition },
        supervisor,
      });
      privateParents(p, supervisor.plistPath);
      await assertCurrent();
      writeFileSync(supervisor.plistPath, plist, { flag: 'wx', mode: 0o600 });
      await assertCurrent();
      writeFileSync(
        join(p.nativeRoot, 'service/fresh-vm-plan.json'),
        JSON.stringify(vm.plan) + '\n',
        {
          flag: 'wx',
          mode: 0o600,
        },
      );
      return vm;
    },
  };
}
function fileIdentity(file, path, mode, size) {
  fields(file, 'path,dev,ino,uid,mode,nlink,size,sha256');
  if (
    file.path !== path ||
    !integer(file.dev) ||
    !integer(file.ino) ||
    file.ino < 1 ||
    file.uid !== process.getuid() ||
    !(Array.isArray(mode) ? mode.includes(file.mode) : file.mode === mode) ||
    file.nlink !== 1 ||
    !integer(file.size) ||
    file.size < 1 ||
    (size !== undefined && file.size !== size) ||
    !sha.test(file.sha256)
  )
    fail('fresh file identity');
}
function validateDefinition(m, plan) {
  fields(
    m,
    'Name,Version,Created,LastUp,Starting,Resources,Swap,Rosetta,Ansible,GvProxy,HostUser,SSH,ImagePath,Mounts,AppleHypervisor',
  );
  fields(m.Resources, 'CPUs,Memory,DiskSize,USBs');
  fields(m.HostUser, 'Rootful,UID,HostUserModified');
  fields(m.GvProxy, 'Debug,MTU,LogFile,PidFile,SSHPort');
  fields(m.SSH, 'IdentityPath,Port,RemoteUsername');
  fields(m.ImagePath, 'Path');
  fields(m.AppleHypervisor, 'Vfkit');
  const v = m.AppleHypervisor.Vfkit;
  fields(v, 'LogLevel,Endpoint,BinaryPath,Rosetta,VirtualMachine');
  fields(v.VirtualMachine, 'vcpus,memoryBytes,bootloader');
  fields(v.VirtualMachine.bootloader, 'kind,efiVariableStorePath,createVariableStore');
  if (!Array.isArray(m.Mounts) || m.Mounts.length !== 1) fail('fresh mount boundary');
  const mount = m.Mounts[0];
  fields(mount, 'OriginalInput,ReadOnly,Source,Target,Tag,Type,VSockNumber');
  const endpoint = v.Endpoint?.match(/^http:\/\/localhost:(\d+)$/),
    port = endpoint && Number(endpoint[1]);
  if (
    m.Name !== plan.machineName ||
    m.Version !== 1 ||
    !Number.isFinite(Date.parse(m.Created)) ||
    m.LastUp !== '0001-01-01T00:00:00Z' ||
    m.Starting !== false ||
    m.Resources.CPUs !== 2 ||
    m.Resources.Memory !== 4096 ||
    m.Resources.DiskSize !== 16 ||
    !Array.isArray(m.Resources.USBs) ||
    m.Resources.USBs.length ||
    m.Swap !== 0 ||
    m.Rosetta !== false ||
    m.Ansible !== null ||
    m.HostUser.Rootful !== false ||
    m.HostUser.HostUserModified !== false ||
    m.HostUser.UID !== process.getuid() ||
    m.GvProxy.Debug !== false ||
    m.GvProxy.MTU !== 0 ||
    m.GvProxy.LogFile !== '' ||
    m.GvProxy.PidFile !== '' ||
    m.GvProxy.SSHPort !== 0 ||
    m.SSH.IdentityPath !== plan.files.ssh.path ||
    !integer(m.SSH.Port) ||
    m.SSH.Port < 1024 ||
    m.SSH.Port > 65535 ||
    m.SSH.RemoteUsername !== 'core' ||
    m.ImagePath.Path !== plan.files.disk.path ||
    v.LogLevel !== '' ||
    v.BinaryPath !== null ||
    v.Rosetta !== false ||
    v.VirtualMachine.vcpus !== 2 ||
    v.VirtualMachine.memoryBytes !== 4294967296 ||
    v.VirtualMachine.bootloader.kind !== 'efiBootloader' ||
    v.VirtualMachine.bootloader.efiVariableStorePath !== plan.files.efi.path ||
    v.VirtualMachine.bootloader.createVariableStore !== true ||
    !port ||
    port < 1024 ||
    port > 65535 ||
    [3100, 3101, 3190, 62752, m.SSH.Port].includes(port) ||
    mount.Source !== plan.canonicalRoot ||
    mount.Target !== plan.canonicalRoot ||
    mount.ReadOnly !== false ||
    mount.Type !== 'virtiofs' ||
    mount.OriginalInput !== '' ||
    !/^[a-f0-9]{36}$/.test(mount.Tag) ||
    mount.VSockNumber !== null
  )
    fail('stock fresh AppleHV boundary');
}
function validateSourcePins(copy) {
  fields(copy.node, 'path,sha256');
  if (!absolute(copy.node.path) || !sha.test(copy.node.sha256)) fail('node executable pin');
  if (JSON.stringify(copy.helpers) !== JSON.stringify(OFFLINE_CONTAINMENT_TARGET.nativeHelpers))
    fail('stock helper pins');
  if (
    !Array.isArray(copy.sourceInventory) ||
    copy.sourceInventory.length < 3 ||
    copy.sourceInventory.length > 512
  )
    fail('source inventory');
  for (const file of copy.sourceInventory) {
    fields(file, 'path,sha256');
    if (
      !/^(scripts|dist|frontend\/dist|packages\/(protocol|harness|client)\/dist)\/[A-Za-z0-9._/-]+$/.test(
        file.path,
      ) ||
      file.path.split('/').some((p) => p === '..' || p === '.') ||
      !sha.test(file.sha256)
    )
      fail('source inventory');
  }
  const names = copy.sourceInventory.map((f) => f.path);
  if (
    new Set(names).size !== names.length ||
    [
      'scripts/start-staging-allocation-vm.mjs',
      'scripts/lib/staging-fresh-applehv.mjs',
      'scripts/lib/staging-offline-containment-contract.mjs',
    ].some((p) => !names.includes(p))
  )
    fail('supervisor source inventory');
  fields(copy.resourcePolicy, 'path,sha256,aggregateGiBLimit,minFreeGiB');
  if (
    copy.resourcePolicy.path !== 'scripts/lib/staging-resource-budget.mjs' ||
    !sha.test(copy.resourcePolicy.sha256) ||
    !Number.isFinite(copy.resourcePolicy.aggregateGiBLimit) ||
    copy.resourcePolicy.aggregateGiBLimit < 16 ||
    copy.resourcePolicy.minFreeGiB !== 20 ||
    !copy.sourceInventory.some(
      (f) => f.path === copy.resourcePolicy.path && f.sha256 === copy.resourcePolicy.sha256,
    )
  )
    fail('accepted source resource policy');
}
function qualifyBudget(copy) {
  fields(
    copy.budget,
    'aggregateGiBLimit,minFreeGiB,stageGiB,quarantineGiB,inflightGiB,candidateAllocatedGiB,releaseGrowthGiB,scratchGrowthGiB,additionalGrowthGiB,diskFreeGiB',
  );
  if (
    Object.values(copy.budget).some((n) => !Number.isFinite(n) || n < 0) ||
    copy.budget.aggregateGiBLimit !== copy.resourcePolicy.aggregateGiBLimit ||
    copy.budget.minFreeGiB !== copy.resourcePolicy.minFreeGiB ||
    copy.budget.candidateAllocatedGiB > 16
  )
    fail('reviewed resource policy');
  const projectedGrowthGiB =
    16 -
    copy.budget.candidateAllocatedGiB +
    copy.budget.releaseGrowthGiB +
    copy.budget.scratchGrowthGiB +
    copy.budget.additionalGrowthGiB;
  const projectedAggregateGiB =
    copy.budget.stageGiB + copy.budget.quarantineGiB + copy.budget.inflightGiB + projectedGrowthGiB;
  const remainingFreeGiB = copy.budget.diskFreeGiB - projectedGrowthGiB;
  if (projectedAggregateGiB > copy.budget.aggregateGiBLimit)
    fail('awaiting separate retention/operator plan');
  if (remainingFreeGiB < copy.budget.minFreeGiB) fail('host disk headroom');
  return { projectedGrowthGiB, projectedAggregateGiB, remainingFreeGiB };
}
/** Pure normalized facts for independent review. This JSON grants no ownership,
 * provisioning, native start, model authority or reopening capability. */
export function createFreshAppleHvPlan(input) {
  const copy = globalThis.structuredClone(input),
    previousQualification = copy?.qualification,
    previousGrowth = copy?.projectedGrowthGiB,
    previousAggregate = copy?.projectedAggregateGiB;
  if (copy) {
    delete copy.qualification;
    delete copy.projectedGrowthGiB;
    delete copy.projectedAggregateGiB;
  }
  fields(
    copy,
    'version,allocationUUID,canonicalRoot,nativeRoot,sourceRoot,sourceCommit,sourceTree,sourceInventory,bootUUID,node,helpers,machine,files,oldIdentities,supervisor,budget,resourcePolicy',
  );
  if (
    Buffer.byteLength(JSON.stringify(copy)) > 262144 ||
    copy.version !== 1 ||
    !uuid.test(copy.allocationUUID) ||
    !absolute(copy.canonicalRoot) ||
    copy.nativeRoot !== join(copy.canonicalRoot, 'symposium/allocations', copy.allocationUUID) ||
    !commit.test(copy.sourceCommit) ||
    !commit.test(copy.sourceTree) ||
    copy.sourceRoot !== join(copy.canonicalRoot, 'releases', copy.sourceCommit.slice(0, 12)) ||
    !uuid.test(copy.bootUUID.toLowerCase())
  )
    fail();
  copy.machineName = 'mitzo-staging-' + copy.allocationUUID.replaceAll('-', '');
  const home = join(copy.nativeRoot, 'home'),
    data = join(home, '.local/share/containers/podman/machine/applehv');
  fields(copy.files, 'disk,efi,ssh,configuration,ignition');
  fileIdentity(
    copy.files.disk,
    join(data, copy.machineName + '-arm64.raw'),
    [0o600, 0o644],
    16 * 1073741824,
  );
  if (copy.files.efi?.state === 'expected-absent') {
    fields(copy.files.efi, 'path,state,parent');
    fields(copy.files.efi.parent, 'path,dev,ino,uid,mode');
    const parent = copy.files.efi.parent;
    if (
      copy.files.efi.path !== join(data, 'efi-bl-' + copy.machineName) ||
      parent.path !== data ||
      !integer(parent.dev) ||
      !integer(parent.ino) ||
      parent.ino < 1 ||
      parent.uid !== process.getuid() ||
      !integer(parent.mode) ||
      parent.mode & 0o022
    )
      fail('expected-absent fresh EFI parent');
  } else fileIdentity(copy.files.efi, join(data, 'efi-bl-' + copy.machineName), [0o600, 0o644]);
  fileIdentity(
    copy.files.ignition,
    join(home, '.config/containers/podman/machine/applehv', copy.machineName + '.ign'),
    [0o600, 0o644],
  );
  if (copy.files.ignition.size > 1048576) fail('bounded first-boot Ignition');
  fileIdentity(copy.files.ssh, join(home, '.local/share/containers/podman/machine/machine'), 0o600);
  fileIdentity(
    copy.files.configuration,
    join(copy.nativeRoot, 'settings/containers.conf'),
    0o600,
    Buffer.byteLength(freshAppleHvConfiguration()),
  );
  if (copy.files.configuration.sha256 !== hash(freshAppleHvConfiguration()))
    fail('stock helper configuration');
  if (!Array.isArray(copy.oldIdentities) || copy.oldIdentities.length !== 3)
    fail('retained identity exclusion');
  for (const old of copy.oldIdentities) {
    fields(old, 'dev,ino');
    if (!integer(old.dev) || !integer(old.ino)) fail();
  }
  if (
    Object.values(copy.files).some((file) =>
      copy.oldIdentities.some((old) => old.dev === file.dev && old.ino === file.ino),
    ) ||
    new Set(
      Object.values(copy.files)
        .filter((f) => f.state !== 'expected-absent')
        .map((f) => `${f.dev}:${f.ino}`),
    ).size !== (copy.files.efi.state === 'expected-absent' ? 4 : 5)
  )
    fail('reused retained identity');
  fields(copy.machine, 'path,sha256,definition');
  if (
    copy.machine.path !==
      join(home, '.config/containers/podman/machine/applehv', copy.machineName + '.json') ||
    !sha.test(copy.machine.sha256)
  )
    fail('fresh machine definition');
  validateDefinition(copy.machine.definition, copy);
  validateSourcePins(copy);
  fields(
    copy.supervisor,
    'plistPath,plistSha256,programArguments,workingDirectory,label,keepAlive,runAtLoad,initialRuns',
  );
  const guardSocket = '/private/tmp/mitzo-vm-' + copy.allocationUUID + '.sock';
  const args = [
    copy.node.path,
    join(copy.sourceRoot, 'scripts/start-staging-allocation-vm.mjs'),
    '--plan',
    join(copy.nativeRoot, 'service/fresh-vm-plan.json'),
    '--guard',
    guardSocket,
  ];
  if (
    copy.supervisor.plistPath !== join(copy.nativeRoot, 'service/com.mitzo.staging.vm.plist') ||
    !sha.test(copy.supervisor.plistSha256) ||
    JSON.stringify(copy.supervisor.programArguments) !== JSON.stringify(args) ||
    copy.supervisor.workingDirectory !== copy.nativeRoot ||
    copy.supervisor.label !== 'com.mitzo.staging.vm' ||
    copy.supervisor.keepAlive !== false ||
    copy.supervisor.runAtLoad !== false ||
    copy.supervisor.initialRuns !== 0
  )
    fail('canonical supervisor binding');
  const { projectedGrowthGiB, projectedAggregateGiB, remainingFreeGiB } = qualifyBudget(copy);
  const environment = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: '/private/tmp',
    LC_ALL: 'C',
    CONTAINERS_CONF: copy.files.configuration.path,
    CONTAINERS_MACHINE_PROVIDER: 'applehv',
    CONTAINER_CONNECTION: copy.machineName,
    NODE_OPTIONS: '--max-old-space-size=1024',
  };
  const qualification = {
    machineName: copy.machineName,
    environment,
    guardSocket,
    apiSocket: '/private/tmp/podman/' + copy.machineName + '-api.sock',
    policySha256: digest(copy.resourcePolicy),
    projectedGrowthGiB,
    projectedAggregateGiB,
    remainingFreeGiB,
  };
  delete copy.machineName;
  if (previousQualification && digest(previousQualification) !== digest(qualification))
    fail('derived qualification drift');
  if (
    (previousGrowth !== undefined && previousGrowth !== projectedGrowthGiB) ||
    (previousAggregate !== undefined && previousAggregate !== projectedAggregateGiB)
  )
    fail('derived resource accounting drift');
  const plan = canonical({ ...copy, qualification, projectedGrowthGiB, projectedAggregateGiB });
  return freeze({ plan, sha256: digest(plan) });
}

/** Physical capability exists only in this live closure. Constructor effects are
 * trusted synthetic test dependencies, never public plan or CLI inputs. */
export function createFreshAppleHvOwner(
  {
    allocation,
    canonicalRoot,
    sourceRoot,
    approvedVmPlan,
    assertGuardCurrent,
    assertAcceptedSource,
    assertNativeDrainCurrent,
  },
  effects,
) {
  const approved = createFreshAppleHvPlan(approvedVmPlan?.plan);
  if (
    approved.sha256 !== approvedVmPlan.sha256 ||
    canonicalRoot !== approved.plan.canonicalRoot ||
    sourceRoot !== approved.plan.sourceRoot ||
    allocation?.allocationUUID !== approved.plan.allocationUUID ||
    allocation.nativeRoot !== approved.plan.nativeRoot ||
    typeof assertGuardCurrent !== 'function' ||
    typeof assertAcceptedSource !== 'function'
  )
    fail('original allocation capability');
  if (!effects && canonicalRoot !== OFFLINE_CONTAINMENT_TARGET.canonicalRoot)
    fail('actual canonical staging root');
  effects ??= freshAppleHvPhysicalEffects(approved);
  let stopped = false,
    attempted = false,
    lineage,
    runningVerified = false,
    stopAttempted = false,
    stopUncertain = false,
    retained = false;
  const fence = async () => {
    const guard = assertGuardCurrent();
    if (guard instanceof Promise || guard === false) fail('original live guard');
    if ((await assertAcceptedSource()) === false) fail('accepted source');
    const again = assertGuardCurrent();
    if (again instanceof Promise || again === false) fail('original live guard');
  };
  return Object.freeze({
    verifyStopped: async () => {
      if (attempted || retained) fail('start once boundary');
      await fence();
      const observation = await effects.verifyStopped();
      await fence();
      stopped = true;
      return observation;
    },
    startOnce: async () => {
      if (attempted || retained || !stopped) fail('start once boundary');
      attempted = true; // Consume before any await; concurrent callers cannot start twice.
      await fence();
      await effects.verifyStopped();
      let authorizedSupervisor;
      const result = await effects.startSupervisor({
        assertCurrent: fence,
        authorize: async (supervisor) => {
          await fence();
          if (authorizedSupervisor) fail('start once authorization');
          authorizedSupervisor = { ...supervisor };
        },
      });
      if (
        !authorizedSupervisor ||
        result.supervisor.pid !== authorizedSupervisor.pid ||
        result.supervisor.birth !== authorizedSupervisor.birth
      )
        fail('original supervisor lineage');
      lineage = freeze(globalThis.structuredClone(result));
      await fence();
      const observation = await effects.verifyRunning(lineage);
      await fence();
      runningVerified = true;
      return observation;
    },
    verifyRunning: async () => {
      if (!lineage || retained || stopAttempted) fail('original running capability');
      runningVerified = false;
      await fence();
      const observation = await effects.verifyRunning(lineage);
      await fence();
      runningVerified = true;
      return observation;
    },
    assertRunningCurrent: () => {
      if (
        !lineage ||
        !runningVerified ||
        retained ||
        stopAttempted ||
        typeof effects.assertRunningCurrent !== 'function'
      )
        fail('original verified running capability');
      const guard = assertGuardCurrent();
      if (guard === false || guard instanceof Promise) fail('original live handoff fence');
      const facts = effects.assertRunningCurrent(lineage);
      if (facts instanceof Promise) fail('synchronous actual owner facts');
      const again = assertGuardCurrent();
      if (again === false || again instanceof Promise) fail('original live handoff fence');
      return facts;
    },
    stopOnce: async () => {
      if (
        !lineage ||
        !runningVerified ||
        retained ||
        stopAttempted ||
        typeof assertNativeDrainCurrent !== 'function'
      )
        fail('original one-shot drained VM owner');
      const drain = assertNativeDrainCurrent();
      if (drain === false || drain instanceof Promise) fail('original synchronous native drain');
      stopAttempted = true;
      runningVerified = false;
      try {
        await fence();
        await effects.verifyRunning(lineage, { admitResources: false });
        const again = assertNativeDrainCurrent();
        if (again === false || again instanceof Promise) fail('original synchronous native drain');
        await fence();
        await effects.stopOnce(lineage, {
          assertCurrent: fence,
          assertDrained: assertNativeDrainCurrent,
        });
        await fence();
        const facts = await effects.confirmStopped(lineage);
        await fence();
        stopUncertain = false;
        return facts;
      } catch (error) {
        stopUncertain = true;
        try {
          await effects.retain({ attempted, lineage, stopAttempted, stopUncertain });
        } catch {
          /* Retain refusal if recording fails. */
        }
        throw error;
      }
    },
    confirmStopped: async () => {
      if (!lineage || !stopAttempted || retained)
        fail('original stopped reconciliation capability');
      try {
        await fence();
        const facts = await effects.confirmStopped(lineage);
        await fence();
        stopUncertain = false;
        return facts;
      } catch (error) {
        stopUncertain = true;
        try {
          await effects.retain({ attempted, lineage, stopAttempted, stopUncertain });
        } catch {
          /* Physical uncertainty remains when recording fails. */
        }
        throw error;
      }
    },
    retain: async () => {
      if (!retained) {
        retained = true;
        await effects.retain({ attempted, lineage, stopAttempted, stopUncertain });
      }
      return { state: 'retained_uncertain', nativeRetirementClaim: false };
    },
  });
}
/** Pure invariant check only; it grants no running capability. The live owner
 * supplies an observed original-start interval, never a reopened JSON receipt. */
export function validateFreshAppleHvMutableMachine(plan, current, { startedAt, observedAt }) {
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(observedAt) ||
    observedAt < startedAt ||
    current?.Starting !== false
  )
    fail('original VM start interval');
  // Stock5.6.2 writes LastUp in stopLocked, never in Start. Our sole normal
  // retirement uses vfkit RequestStop, so even after retirement LastUp stays0.
  // Captured independent helper/guest boot evidence authorizes the lifecycle.
  if (digest(current) !== digest(plan.machine.definition)) fail('mutable machine invariant');
}

function command(program, args, env) {
  const result = spawnSync(program, args, {
    env,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1048576,
  });
  if (result.error || result.signal || result.status !== 0) fail('physical host observation');
  return result.stdout.trim();
}
function checkedFile(path, { mode, uid = process.getuid(), maxSize = 67108864 } = {}) {
  if (!absolute(path) || realpathSync(path) !== path) fail('unaliased input path');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.mode & 0o022 ||
      (mode !== undefined &&
        !(Array.isArray(mode) ? mode.includes(stat.mode & 0o777) : (stat.mode & 0o777) === mode)) ||
      (uid !== null && stat.uid !== uid) ||
      stat.size > maxSize
    )
      fail('input file mode or size');
    const sha = createHash('sha256'),
      buffer = Buffer.alloc(1048576);
    let offset = 0,
      count;
    while (
      (count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset)) > 0
    ) {
      sha.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(fd);
    if (
      offset !== stat.size ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      fail('concurrent input mutation');
    return { stat, sha256: sha.digest('hex') };
  } finally {
    closeSync(fd);
  }
}
function identity(path) {
  if (realpathSync(path) !== path) fail('unaliased runtime file');
  const s = lstatSync(path);
  if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid() || s.mode & 0o022)
    fail('runtime file identity');
  return {
    path,
    dev: s.dev,
    ino: s.ino,
    uid: s.uid,
    mode: s.mode & 0o777,
    nlink: s.nlink,
    size: s.size,
  };
}
const sameIdentity = (a, b) =>
  ['path', 'dev', 'ino', 'uid', 'mode', 'nlink', 'size'].every((key) => a[key] === b[key]);
function privateParents(plan, path) {
  let current = dirname(path);
  while (current.startsWith(plan.nativeRoot + '/') || current === plan.nativeRoot) {
    const s = lstatSync(current);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      s.uid !== process.getuid() ||
      s.mode & 0o022 ||
      realpathSync(current) !== current ||
      ([plan.nativeRoot, plan.qualification.environment.HOME].includes(current) &&
        (s.mode & 0o777) !== 0o700)
    )
      fail('private allocation parent');
    if (current === plan.nativeRoot) break;
    current = dirname(current);
  }
}
function machineDefinition(plan) {
  privateParents(plan, plan.machine.path);
  const measured = checkedFile(plan.machine.path, { mode: 0o644, maxSize: 65536 });
  const fd = openSync(plan.machine.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(measured.stat.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || hash(bytes) !== measured.sha256)
      fail('machine changed while read');
    return { machine: JSON.parse(bytes), sha256: measured.sha256 };
  } finally {
    closeSync(fd);
  }
}
export function observeFreshAppleHvProcess(pid) {
  if (!integer(pid) || pid < 2) fail('original process identity');
  const birth = command('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
  const cmd = command('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command=']);
  const parentPid = Number(command('/bin/ps', ['-p', String(pid), '-o', 'ppid=']));
  if (!birth || !cmd || !integer(parentPid)) fail('original process observation');
  return { pid, birth, command: cmd, parentPid };
}
export function observeFreshAppleHvJob(plan) {
  const text = command('/bin/launchctl', ['print', `gui/${process.getuid()}/com.mitzo.staging.vm`]);
  const field = (name) => text.match(new RegExp(`^\\s*${name} = (.+)$`, 'm'))?.[1]?.trim();
  if (field('path') !== plan.supervisor.plistPath || !/^\d+$/.test(field('runs') ?? ''))
    fail('canonical VM registration');
  return {
    path: field('path'),
    runs: Number(field('runs')),
    pid: field('pid') ? Number(field('pid')) : null,
    state: field('state'),
  };
}
function assertSupervisor(plan, expected, runs) {
  const job = observeFreshAppleHvJob(plan);
  if (job.runs !== runs || (expected ? job.pid !== expected.pid : job.pid !== null))
    fail('original canonical supervisor runs');
  if (expected) {
    const actual = observeFreshAppleHvProcess(expected.pid);
    if (
      actual.birth !== expected.birth ||
      actual.command !== plan.supervisor.programArguments.join(' ')
    )
      fail('original supervisor process');
  }
  return job;
}
function scopedNoOpenHandles(paths) {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', '-FpfDn', ...paths], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 1048576,
  });
  if (result.status !== 1 || result.stdout || result.stderr || result.error || result.signal)
    fail('stopped fresh file handles');
}
function bootUUID() {
  return command('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
}
async function verifyFreshSource(p) {
  if (
    process.platform !== 'darwin' ||
    bootUUID() !== p.bootUUID ||
    realpathSync(p.canonicalRoot) !== p.canonicalRoot
  )
    fail('current macOS boot/root');
  for (const item of [...p.helpers, p.node])
    if (
      checkedFile(item.path, { uid: null }).sha256 !== item.sha256 ||
      !(lstatSync(item.path).mode & 0o111)
    )
      fail('stock executable bytes');
  for (const item of p.sourceInventory)
    if (checkedFile(join(p.sourceRoot, item.path), { uid: null }).sha256 !== item.sha256)
      fail('accepted source inventory');
  const { STAGING_RESOURCE_BUDGET: policy } = await import(
    pathToFileURL(join(p.sourceRoot, p.resourcePolicy.path)).href
  );
  if (
    policy.stagingGiB !== p.resourcePolicy.aggregateGiBLimit ||
    policy.diskFreeGiB !== p.resourcePolicy.minFreeGiB ||
    policy.vmMemoryMiB !== 4096 ||
    policy.vmCpus !== 2 ||
    policy.workers !== 1
  )
    fail('actual accepted resource policy');
  return policy;
}
/** Positive current bytes/identity check; this alone grants no VM authority. */
export function inspectFreshAppleHvImmutableInputs(p) {
  for (const file of [p.files.ssh, p.files.configuration, p.files.ignition]) {
    privateParents(p, file.path);
    if (
      !sameIdentity(identity(file.path), file) ||
      checkedFile(file.path, {
        mode: file.mode,
        maxSize: file === p.files.ignition ? 1048576 : 67108864,
      }).sha256 !== file.sha256
    )
      fail('original immutable input changed');
  }
}
export async function inspectFreshAppleHvInputs(
  approved,
  { running = false, admitResources = true } = {},
) {
  const p = approved.plan;
  const policy = await verifyFreshSource(p);
  privateParents(p, p.supervisor.plistPath);
  if (checkedFile(p.supervisor.plistPath, { mode: 0o600 }).sha256 !== p.supervisor.plistSha256)
    fail('supervisor plist bytes');
  const plist = JSON.parse(
    command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', p.supervisor.plistPath]),
  );
  if (
    plist.Label !== p.supervisor.label ||
    plist.KeepAlive !== false ||
    plist.RunAtLoad !== false ||
    plist.WorkingDirectory !== p.nativeRoot ||
    JSON.stringify(plist.ProgramArguments) !== JSON.stringify(p.supervisor.programArguments) ||
    digest(plist.EnvironmentVariables) !== digest(p.qualification.environment)
  )
    fail('exact fresh supervisor plist');
  inspectFreshAppleHvImmutableInputs(p);
  const current = machineDefinition(p);
  if (
    !running &&
    (current.sha256 !== p.machine.sha256 ||
      digest(current.machine) !== digest(p.machine.definition))
  )
    fail('prestart machine definition');
  privateParents(p, p.files.disk.path);
  const disk = identity(p.files.disk.path);
  if (!sameIdentity(disk, p.files.disk)) fail('original raw disk identity');
  if (!running) {
    scopedNoOpenHandles([
      p.files.disk.path,
      ...(p.files.efi.state === 'expected-absent' ? [] : [p.files.efi.path]),
    ]);
    if (
      checkedFile(p.files.disk.path, { mode: p.files.disk.mode, maxSize: 16 * 1073741824 })
        .sha256 !== p.files.disk.sha256
    )
      fail('prestart raw disk bytes');
    const fd = openSync(p.files.disk.path, constants.O_RDONLY | constants.O_NOFOLLOW),
      first = Buffer.alloc(64),
      last = Buffer.alloc(512);
    try {
      readSync(fd, first, 0, first.length, 0);
      readSync(fd, last, 0, last.length, disk.size - last.length);
    } finally {
      closeSync(fd);
    }
    if (
      ['514649fb', '4b444d56'].includes(first.subarray(0, 4).toString('hex')) ||
      first.subarray(0, 8).toString() === 'vhdxfile' ||
      last.subarray(0, 8).toString() === 'conectix' ||
      first.toString().includes('Oracle VM VirtualBox Disk Image')
    )
      fail('direct raw disk header');
  }
  let efi;
  if (p.files.efi.state === 'expected-absent' && !running) {
    const parent = lstatSync(p.files.efi.parent.path);
    if (
      parent.dev !== p.files.efi.parent.dev ||
      parent.ino !== p.files.efi.parent.ino ||
      parent.uid !== p.files.efi.parent.uid ||
      (parent.mode & 0o777) !== p.files.efi.parent.mode ||
      lstatSync(p.files.efi.path, { throwIfNoEntry: false })
    )
      fail('expected-absent EFI creation boundary');
    privateParents(p, p.files.efi.path);
  } else {
    privateParents(p, p.files.efi.path);
    efi = identity(p.files.efi.path);
    if (p.files.efi.state !== 'expected-absent' && !sameIdentity(efi, p.files.efi))
      fail('original EFI identity');
    if (
      !running &&
      checkedFile(p.files.efi.path, { mode: p.files.efi.mode }).sha256 !== p.files.efi.sha256
    )
      fail('prestart EFI bytes');
  }
  return { current, disk, efi, ...(admitResources ? observeFreshResources(p, policy) : {}) };
}
function observeFreshResources(p, policy) {
  const usagePaths = [p.canonicalRoot, p.canonicalRoot + '-quarantine'];
  const usage = command('/usr/bin/du', ['-sk', ...usagePaths]).split('\n');
  if (
    usage.length !== 2 ||
    usage.some((line, i) => !/^\d+\s+/.test(line) || line.replace(/^\d+\s+/, '') !== usagePaths[i])
  )
    fail('aggregate disk observation');
  const aggregate = usage.reduce((n, line) => n + Number(line.match(/^\d+/)[0]) / 1048576, 0);
  const diskFree = command('/bin/df', ['-kP', p.canonicalRoot])
    .split('\n')
    .at(-1)
    ?.trim()
    .split(/\s+/)[3];
  const pressure = command('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']);
  const free = command('/usr/bin/memory_pressure', ['-Q']).match(
    /System-wide memory free percentage: (\d+)%/,
  );
  const swap = command('/usr/sbin/sysctl', ['vm.swapusage']).match(/\bused = ([\d.]+)([MG])/);
  const allocated = (lstatSync(p.files.disk.path).blocks * 512) / 1073741824;
  const growth =
    Math.max(0, 16 - allocated) +
    p.budget.releaseGrowthGiB +
    p.budget.scratchGrowthGiB +
    p.budget.additionalGrowthGiB;
  if (
    !/^\d+$/.test(diskFree ?? '') ||
    pressure !== '1' ||
    !free ||
    Number(free[1]) < 25 ||
    !swap ||
    Number(swap[1]) * (swap[2] === 'G' ? 1024 : 1) > 2048 ||
    !Number.isFinite(allocated) ||
    allocated > 16 ||
    aggregate + p.budget.inflightGiB + growth > policy.stagingGiB ||
    Number(diskFree) / 1048576 - growth < policy.diskFreeGiB
  )
    fail('current conservative host resources');
  return {
    aggregateGiB: aggregate,
    growthGiB: growth,
    diskFreeGiB: Number(diskFree) / 1048576,
    vmMemoryMiB: p.machine.definition.Resources.Memory,
    vmCpus: p.machine.definition.Resources.CPUs,
  };
}
export function parseFreshAppleHvOpenFiles(text, pid) {
  const rows = text.trim().split('\n');
  if (rows.shift() !== 'p' + pid || rows.some((row) => row.startsWith('p')))
    fail('exact lsof original process');
  const files = [];
  let entry;
  for (const row of rows) {
    if (row.startsWith('f')) {
      entry = {};
      files.push(entry);
    } else if (entry && ['D', 'i', 'n'].includes(row[0])) entry[row[0]] = row.slice(1);
  }
  return files;
}
function openFileBindings(pid) {
  return parseFreshAppleHvOpenFiles(
    command('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-FpfDin']),
    pid,
  );
}
export function validateFreshAppleHvNativeArguments(p, cmd, kind) {
  const args = cmd.split(' '),
    helper = p.helpers.find((h) => h.kind === kind);
  if (!helper || args.shift() !== helper.path) fail('stock native executable arguments');
  if (kind === 'gvproxy') {
    if (!cmd.includes(p.qualification.machineName)) fail('fresh networking socket');
    return;
  }
  const values = (name) => args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : []));
  const devices = values('--device'),
    block = devices.filter((d) => d?.startsWith('virtio-blk,')),
    mounts = devices.filter((d) => d?.startsWith('virtio-fs,'));
  const parameter = (device, key) =>
    device
      ?.split(',')
      .find((part) => part.startsWith(key + '='))
      ?.slice(key.length + 1);
  if (
    JSON.stringify(values('--cpus')) !== JSON.stringify(['2']) ||
    JSON.stringify(values('--memory')) !== JSON.stringify(['4096']) ||
    block.length !== 1 ||
    parameter(block[0], 'path') !== p.files.disk.path ||
    mounts.length !== 1 ||
    parameter(mounts[0], 'sharedDir') !== p.canonicalRoot ||
    parameter(mounts[0], 'mountTag') !== p.machine.definition.Mounts[0].Tag ||
    values('--bootloader').length !== 1 ||
    parameter(values('--bootloader')[0], 'variable-store') !== p.files.efi.path ||
    JSON.stringify(values('--restful-uri')) !==
      JSON.stringify([
        'tcp://localhost:' + p.machine.definition.AppleHypervisor.Vfkit.Endpoint.split(':').at(-1),
      ])
  )
    fail('actual exact stock vfkit devices');
}
function assertOpenIdentity(pid, file) {
  if (
    !openFileBindings(pid).some(
      (record) =>
        record.n === file.path &&
        Number(record.i) === file.ino &&
        Number.parseInt(record.D, 16) === file.dev,
    )
  )
    fail('original vfkit open backing identity');
}
function assertNativeProcess(p, record, kind) {
  const current = observeFreshAppleHvProcess(record.pid),
    helper = p.helpers.find((h) => h.kind === kind);
  if (
    current.birth !== record.birth ||
    current.command !== record.command ||
    !current.command.startsWith(helper.path + ' ')
  )
    fail('original native process lineage');
  validateFreshAppleHvNativeArguments(p, current.command, kind);
}
function freshAppleHvPhysicalEffects(approved) {
  const p = approved.plan;
  let server,
    channelLost = false,
    normalStopRequested = false;
  const startAuthority = createFreshAppleHvStartRevocation(() => server?.close());
  const verifyStopped = async () => {
    assertSupervisor(p, null, 0);
    const inputs = await inspectFreshAppleHvInputs(approved);
    const processes = command('/bin/ps', ['-axo', 'command=']);
    if (
      processes
        .split('\n')
        .some(
          (line) =>
            line.includes(p.qualification.machineName) &&
            p.helpers.some((h) => line.startsWith(h.path + ' ')),
        )
    )
      fail('fresh VM already active');
    const port = p.machine.definition.AppleHypervisor.Vfkit.Endpoint.split(':').at(-1);
    const listeners = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    if (
      listeners.status !== 1 ||
      listeners.stdout ||
      listeners.stderr ||
      listeners.error ||
      listeners.signal ||
      lstatSync(p.qualification.apiSocket, { throwIfNoEntry: false })
    )
      fail('fresh endpoint already active');
    return {
      state: 'verified_stopped',
      planSha256: approved.sha256,
      observationSha256: digest(inputs),
      nativeRetirementClaim: false,
    };
  };
  const verifyRunning = async (lineage, { admitResources = true } = {}) => {
    if (channelLost) fail('original supervisor channel lost');
    assertSupervisor(p, lineage.supervisor, 1);
    const inputs = await inspectFreshAppleHvInputs(approved, { running: true, admitResources });
    validateFreshAppleHvMutableMachine(p, inputs.current.machine, {
      startedAt: lineage.startedAt,
      observedAt: Date.now(),
    });
    assertNativeProcess(p, lineage.vfkit, 'vfkit');
    assertNativeProcess(p, lineage.gvproxy, 'gvproxy');
    assertOpenIdentity(lineage.vfkit.pid, inputs.disk);
    assertOpenIdentity(lineage.vfkit.pid, inputs.efi);
    if (!sameIdentity(inputs.efi, lineage.efi)) fail('original newly created EFI identity');
    const port = p.machine.definition.AppleHypervisor.Vfkit.Endpoint.split(':').at(-1);
    const listeners = command('/usr/sbin/lsof', [
      '-nP',
      `-iTCP:${port}`,
      '-sTCP:LISTEN',
      '-Fp',
    ]).split('\n');
    if (listeners.some((row) => row !== 'p' + lineage.vfkit.pid))
      fail('original vfkit endpoint owner');
    const response = await globalThis.fetch('http://127.0.0.1:' + port + '/vm/state', {
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(2000),
    });
    const bytes = await response.text();
    if (
      !response.ok ||
      Buffer.byteLength(bytes) > 1024 ||
      JSON.parse(bytes).state !== 'VirtualMachineStateRunning'
    )
      fail('original vfkit running state');
    const socket = lstatSync(p.qualification.apiSocket);
    if (!socket.isSocket() || socket.uid !== process.getuid() || socket.mode & 0o077)
      fail('fresh rootless API socket');
    if (socket.dev !== lineage.apiSocket?.dev || socket.ino !== lineage.apiSocket?.ino)
      fail('original rootless API socket identity');
    const podman = p.helpers.find((helper) => helper.kind === 'podman');
    const guestBoot = command(
      podman.path,
      ['machine', 'ssh', p.qualification.machineName, 'cat', '/proc/sys/kernel/random/boot_id'],
      p.qualification.environment,
    );
    if (!uuid.test(guestBoot) || guestBoot !== lineage.guestBootUUID)
      fail('original guest boot identity');
    assertSupervisor(p, lineage.supervisor, 1);
    assertNativeProcess(p, lineage.vfkit, 'vfkit');
    assertNativeProcess(p, lineage.gvproxy, 'gvproxy');
    return {
      state: 'verified_running',
      planSha256: approved.sha256,
      supervisorPid: lineage.supervisor.pid,
      vfkitPid: lineage.vfkit.pid,
      observationSha256: digest({ inputs, lineage }),
      nativeRetirementClaim: false,
    };
  };
  return {
    verifyStopped,
    verifyRunning,
    stopOnce: async (lineage, { assertCurrent, assertDrained }) => {
      await assertCurrent();
      assertSupervisor(p, lineage.supervisor, 1);
      assertNativeProcess(p, lineage.vfkit, 'vfkit');
      assertNativeProcess(p, lineage.gvproxy, 'gvproxy');
      const drain = assertDrained();
      if (drain === false || drain instanceof Promise) fail('original synchronous native drain');
      const port = p.machine.definition.AppleHypervisor.Vfkit.Endpoint.split(':').at(-1);
      const owners = command('/usr/sbin/lsof', [
        '-nP',
        `-iTCP:${port}`,
        '-sTCP:LISTEN',
        '-Fp',
      ]).split('\n');
      if (owners.some((row) => row !== 'p' + lineage.vfkit.pid))
        fail('original graceful endpoint owner');
      normalStopRequested = true;
      // Podman Stop(false,true) escalates to HardStop after90s. Never invoke it.
      // Stock vfkit Stop is RequestStop only; no delayed force or retry exists here.
      const response = await globalThis.fetch('http://127.0.0.1:' + port + '/vm/state', {
        method: 'POST',
        body: '{"state":"Stop"}',
        headers: { 'content-type': 'application/json' },
        redirect: 'error',
        signal: globalThis.AbortSignal.timeout(3000),
      });
      if (!response.ok) fail('original graceful request unconfirmed');
      await response.body?.cancel();
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await assertCurrent();
        const current = assertDrained();
        if (current === false || current instanceof Promise)
          fail('original drain lost during graceful stop');
        const child = spawnSync('/bin/ps', ['-p', String(lineage.vfkit.pid), '-o', 'pid='], {
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 1024,
        });
        if (child.status === 1 && !child.error && !child.signal && !child.stdout && !child.stderr) {
          const disk = identity(p.files.disk.path),
            efi = identity(p.files.efi.path);
          if (!sameIdentity(disk, p.files.disk) || !sameIdentity(efi, lineage.efi))
            fail('original graceful backing identity');
          scopedNoOpenHandles([disk.path, efi.path]);
          const gone = (record) => {
            const result = spawnSync('/bin/ps', ['-p', String(record.pid), '-o', 'pid='], {
              encoding: 'utf8',
              timeout: 15000,
              maxBuffer: 1024,
            });
            if (
              result.status === 1 &&
              !result.error &&
              !result.signal &&
              !result.stdout &&
              !result.stderr
            )
              return true;
            if (result.status !== 0 || result.error || result.signal)
              fail('original helper closure uncertain');
            const actual = observeFreshAppleHvProcess(record.pid);
            if (actual.birth !== record.birth || actual.command !== record.command)
              fail('original helper PID reused');
            return false;
          };
          if (!gone(lineage.gvproxy)) {
            await assertCurrent();
            const drained = assertDrained();
            if (drained === false || drained instanceof Promise) fail('original networking drain');
            // Normal shutdown of this captured networking helper only. No escalation.
            assertNativeProcess(p, lineage.gvproxy, 'gvproxy');
            process.kill(lineage.gvproxy.pid, 'SIGTERM');
          }
          while (Date.now() < deadline) {
            await assertCurrent();
            const currentDrain = assertDrained();
            if (currentDrain === false || currentDrain instanceof Promise)
              fail('original drain lost during helper closure');
            if (gone(lineage.gvproxy) && gone(lineage.supervisor)) return;
            await new Promise((done) => setTimeout(done, 250));
          }
          fail('original helper graceful closure unconfirmed');
        }
        if (child.error || child.signal || child.status !== 0)
          fail('original graceful process outcome uncertain');
        assertNativeProcess(p, lineage.vfkit, 'vfkit');
        await new Promise((done) => setTimeout(done, 250));
      }
      fail('original guest graceful closure unconfirmed');
    },
    confirmStopped: async (lineage) => {
      await verifyFreshSource(p);
      const job = observeFreshAppleHvJob(p);
      if (job.runs !== 1 || job.pid !== null) fail('original supervisor has not exited normally');
      for (const processRecord of [lineage.supervisor, lineage.vfkit, lineage.gvproxy]) {
        const observed = spawnSync('/bin/ps', ['-p', String(processRecord.pid), '-o', 'pid='], {
          encoding: 'utf8',
          timeout: 15000,
          maxBuffer: 1024,
        });
        if (
          observed.status !== 1 ||
          observed.error ||
          observed.signal ||
          observed.stdout ||
          observed.stderr
        )
          fail('original process absent or PID reused is uncertain');
      }
      const disk = identity(p.files.disk.path),
        efi = identity(p.files.efi.path);
      if (!sameIdentity(disk, p.files.disk) || !sameIdentity(efi, lineage.efi))
        fail('original stopped backing identity');
      scopedNoOpenHandles([disk.path, efi.path]);
      inspectFreshAppleHvImmutableInputs(p);
      if (checkedFile(p.supervisor.plistPath, { mode: 0o600 }).sha256 !== p.supervisor.plistSha256)
        fail('original stopped registration bytes');
      const current = machineDefinition(p);
      validateFreshAppleHvMutableMachine(p, current.machine, {
        startedAt: lineage.startedAt,
        observedAt: Date.now(),
      });
      const processes = command('/bin/ps', ['-axo', 'command=']);
      if (
        processes
          .split('\n')
          .some(
            (cmd) =>
              cmd.includes(p.qualification.machineName) &&
              p.helpers.some((h) => cmd.startsWith(h.path + ' ')),
          )
      )
        fail('fresh native helper still present');
      const port = p.machine.definition.AppleHypervisor.Vfkit.Endpoint.split(':').at(-1);
      const listener = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 1048576,
      });
      if (
        listener.status !== 1 ||
        listener.error ||
        listener.signal ||
        listener.stdout ||
        listener.stderr
      )
        fail('original VM control endpoint still present or uncertain');
      const socket = lstatSync(p.qualification.apiSocket, { throwIfNoEntry: false });
      if (socket) {
        if (
          !socket.isSocket() ||
          socket.uid !== process.getuid() ||
          (socket.mode & 0o777) !== 0o600 ||
          socket.nlink !== 1 ||
          socket.dev !== lineage.apiSocket.dev ||
          socket.ino !== lineage.apiSocket.ino
        )
          fail('original stopped API socket drift');
        scopedNoOpenHandles([p.qualification.apiSocket]);
      }
      if (server) server.close();
      const facts = {
        job,
        current,
        disk,
        efi,
        supervisor: lineage.supervisor,
        vfkit: lineage.vfkit,
        gvproxy: lineage.gvproxy,
      };
      return freeze({
        state: 'verified_stopped',
        allocationUUID: p.allocationUUID,
        planSha256: approved.sha256,
        sourceCommit: p.sourceCommit,
        guestBootUUID: lineage.guestBootUUID,
        observationSha256: digest(facts),
        observedAt: Date.now(),
        nativeRetirementClaim: true,
        backingRetained: true,
      });
    },
    assertRunningCurrent: (lineage) => {
      if (channelLost || bootUUID() !== p.bootUUID) fail('original current native owner');
      assertSupervisor(p, lineage.supervisor, 1);
      assertNativeProcess(p, lineage.vfkit, 'vfkit');
      assertNativeProcess(p, lineage.gvproxy, 'gvproxy');
      const current = machineDefinition(p);
      validateFreshAppleHvMutableMachine(p, current.machine, {
        startedAt: lineage.startedAt,
        observedAt: Date.now(),
      });
      const disk = identity(p.files.disk.path),
        efi = identity(p.files.efi.path);
      if (!sameIdentity(disk, p.files.disk) || !sameIdentity(efi, lineage.efi))
        fail('original current backing identities');
      assertOpenIdentity(lineage.vfkit.pid, disk);
      assertOpenIdentity(lineage.vfkit.pid, efi);
      const socket = lstatSync(p.qualification.apiSocket);
      if (
        !socket.isSocket() ||
        socket.uid !== process.getuid() ||
        socket.mode & 0o077 ||
        socket.dev !== lineage.apiSocket.dev ||
        socket.ino !== lineage.apiSocket.ino
      )
        fail('original current rootless socket');
      for (const item of [...p.helpers, p.node])
        if (checkedFile(item.path, { uid: null }).sha256 !== item.sha256)
          fail('current executable bytes');
      for (const item of p.sourceInventory)
        if (checkedFile(join(p.sourceRoot, item.path), { uid: null }).sha256 !== item.sha256)
          fail('current accepted source bytes');
      inspectFreshAppleHvImmutableInputs(p);
      if (checkedFile(p.supervisor.plistPath, { mode: 0o600 }).sha256 !== p.supervisor.plistSha256)
        fail('current canonical registration bytes');
      const facts = observeFreshResources(p, {
        stagingGiB: p.resourcePolicy.aggregateGiBLimit,
        diskFreeGiB: p.resourcePolicy.minFreeGiB,
      });
      return freeze({
        ...facts,
        allocationUUID: p.allocationUUID,
        planSha256: approved.sha256,
        bootUUID: p.bootUUID,
        supervisorPid: lineage.supervisor.pid,
        vfkitPid: lineage.vfkit.pid,
        observationSha256: digest({ current, disk, efi, facts }),
        nativeRetirementClaim: false,
      });
    },
    startSupervisor: async ({ authorize, assertCurrent }) => {
      startAuthority.assertCurrent();
      if (lstatSync(p.qualification.guardSocket, { throwIfNoEntry: false }))
        fail('existing start guard endpoint');
      let authorized = false,
        capturedSupervisor,
        settled = false,
        timer;
      const result = new Promise((resolveStart, rejectStart) => {
        const failStart = () => {
          channelLost = true;
          startAuthority.revoke();
          if (!settled) {
            settled = true;
            rejectStart(Error('Fresh VM start uncertain; retain original state'));
          }
        };
        server = createServer((socket) => {
          startAuthority.track(socket);
          if (socket.destroyed) return;
          let buffer = '';
          socket.setEncoding('utf8');
          socket.on('error', () => {
            channelLost = true;
            failStart();
          });
          socket.on('close', () => {
            channelLost = true;
            failStart();
          });
          socket.on('data', async (chunk) => {
            buffer += chunk;
            if (Buffer.byteLength(buffer) > 65536) return failStart();
            let newline;
            while ((newline = buffer.indexOf('\n')) !== -1) {
              const row = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              try {
                startAuthority.assertCurrent();
                const message = JSON.parse(row);
                if (message.kind === 'authorize' && !authorized) {
                  if (message.planSha256 !== approved.sha256) fail();
                  const supervisor = observeFreshAppleHvProcess(message.pid);
                  assertSupervisor(p, supervisor, 1);
                  await inspectFreshAppleHvInputs(approved);
                  startAuthority.assertCurrent();
                  authorized = true;
                  await authorize(supervisor);
                  startAuthority.assertCurrent();
                  capturedSupervisor = supervisor;
                  socket.write(
                    JSON.stringify({ kind: 'authorized', planSha256: approved.sha256 }) + '\n',
                  );
                } else if (message.kind === 'running' && authorized && !settled) {
                  const lineage = message.lineage;
                  assertSupervisor(p, lineage.supervisor, 1);
                  assertNativeProcess(p, lineage.vfkit, 'vfkit');
                  assertNativeProcess(p, lineage.gvproxy, 'gvproxy');
                  lineage.efi = identity(p.files.efi.path);
                  await verifyRunning(lineage);
                  startAuthority.assertCurrent();
                  settled = true;
                  clearTimeout(timer);
                  resolveStart(lineage);
                  socket.write('{"kind":"recorded"}\n');
                } else if (message.kind === 'current' && authorized) {
                  if (
                    message.pid !== capturedSupervisor?.pid ||
                    message.birth !== capturedSupervisor.birth ||
                    message.planSha256 !== approved.sha256
                  )
                    fail('original supervisor current fence');
                  await assertCurrent();
                  startAuthority.assertCurrent();
                  assertSupervisor(p, { pid: message.pid, birth: message.birth }, 1);
                  socket.write(
                    JSON.stringify({ kind: 'current', normalRetirement: normalStopRequested }) +
                      '\n',
                  );
                } else fail();
              } catch {
                failStart();
                socket.destroy();
              }
            }
          });
        });
        server.on('error', failStart);
        server.listen(p.qualification.guardSocket, async () => {
          if (channelLost) return;
          chmodSync(p.qualification.guardSocket, 0o600);
          try {
            await assertCurrent();
            startAuthority.assertCurrent();
            command('/bin/launchctl', [
              'kickstart',
              `gui/${process.getuid()}/com.mitzo.staging.vm`,
            ]);
          } catch {
            failStart();
          }
        });
        timer = setTimeout(failStart, 180000);
      });
      return result.finally(() => clearTimeout(timer));
    },
    retain: async (state) => {
      channelLost = true;
      startAuthority.revoke();
      const path = join(p.nativeRoot, 'service/fresh-vm-retained-' + process.pid + '.json');
      const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(
          fd,
          JSON.stringify({
            version: 1,
            planSha256: approved.sha256,
            attempted: state.attempted,
            originalLineage: state.lineage ?? null,
            stopAttempted: state.stopAttempted ?? false,
            stopUncertain: state.stopUncertain ?? false,
            nativeRetirementClaim: false,
          }) + '\n',
        );
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** This latch only revokes; it grants no native authorization or replay. */
export function createFreshAppleHvStartRevocation(closeListener) {
  let revoked = false;
  const sockets = new Set();
  return Object.freeze({
    assertCurrent() {
      if (revoked) fail('start authorization permanently revoked');
    },
    track(socket) {
      if (revoked) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.once?.('close', () => sockets.delete(socket));
    },
    revoke() {
      if (revoked) return;
      revoked = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      try {
        closeListener();
      } catch {
        /* Revocation remains permanent even if listener closure is uncertain. */
      }
    },
  });
}
/** Persist the one-shot attempt before any native spawn. A failed fsync retains
 * the exclusive file and refuses dispatch; it never deletes or retries intent. */
export function persistFreshVmInitializationAttempt(
  path,
  receipt,
  fs = { openSync, writeFileSync, fsyncSync, closeSync },
) {
  const fd = fs.openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, JSON.stringify(receipt) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const parent = fs.openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
}
