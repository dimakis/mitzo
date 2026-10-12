import process from 'node:process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { join, resolve, dirname } from 'node:path';
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
function fileIdentity(file, path, mode, size) {
  fields(file, 'path,dev,ino,uid,mode,nlink,size,sha256');
  if (
    file.path !== path ||
    !integer(file.dev) ||
    !integer(file.ino) ||
    file.ino < 1 ||
    file.uid !== process.getuid() ||
    file.mode !== mode ||
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
    !/^[a-f0-9]{32}$/.test(mount.Tag) ||
    mount.VSockNumber !== null
  )
    fail('stock fresh AppleHV boundary');
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
  fields(copy.files, 'disk,efi,ssh,configuration');
  fileIdentity(
    copy.files.disk,
    join(data, copy.machineName + '-arm64.raw'),
    0o644,
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
  } else fileIdentity(copy.files.efi, join(data, 'efi-bl-' + copy.machineName), 0o644);
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
    ).size !== (copy.files.efi.state === 'expected-absent' ? 3 : 4)
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
  effects ??= freshAppleHvPhysicalEffects(approved);
  let stopped = false,
    attempted = false,
    lineage,
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
      await fence();
      await effects.verifyStopped();
      attempted = true;
      let authorizedSupervisor;
      const result = await effects.startSupervisor({
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
      return effects.verifyRunning(lineage);
    },
    verifyRunning: async () => {
      if (!lineage || retained) fail('original running capability');
      await fence();
      const observation = await effects.verifyRunning(lineage);
      await fence();
      return observation;
    },
    retain: async () => {
      if (!retained) {
        retained = true;
        await effects.retain({ attempted, lineage });
      }
      return { state: 'retained_uncertain', nativeRetirementClaim: false };
    },
  });
}
function freshAppleHvPhysicalEffects() {
  fail('physical adapter not yet qualified');
}
