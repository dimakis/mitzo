import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { homedir } from 'node:os';
import { join, resolve, relative, sep, dirname, basename } from 'node:path';

const disposition = 'contained_offline_native_cleanup_unconfirmed';
export const OFFLINE_CONTAINMENT_TARGET = Object.freeze({
  canonicalRoot: join(homedir(), '.local/share/mitzo-staging'),
  controls: Object.freeze([
    Object.freeze({
      kind: 'app',
      path: join(homedir(), '.local/share/mitzo-staging/service/com.mitzo.staging.plist'),
      sha256: '6dfdc1ef1124964ac1d4ec8f14af80549647fb61977f1ff30cdf8314cb6dda29',
      label: 'com.mitzo.staging',
      registrationState: 'absent',
    }),
    Object.freeze({
      kind: 'vm_supervisor',
      path: join(homedir(), 'Library/LaunchAgents/com.mitzo.staging.vm.plist'),
      sha256: '8803bebb71091f2b9094d8af5de641bc99e7f613e61ce96d171d7faff0b8a0da',
      label: 'com.mitzo.staging.vm',
      registrationState: 'loaded_stopped',
    }),
  ]),
  nativeHelpers: Object.freeze([
    Object.freeze({
      kind: 'podman',
      path: '/opt/homebrew/Cellar/podman/5.6.2/bin/podman-remote',
      sha256: '4de77b27826a8b3fd35ed08037b35c34cb78d4c0fcf58733ac8d3c0661149996',
    }),
    Object.freeze({
      kind: 'vfkit',
      path: '/opt/homebrew/Cellar/podman/5.6.2/libexec/podman/vfkit',
      sha256: '5c81d202b521cbc1f67e8b79342b494a2c738f8dcc9e00c291a425f49174036f',
    }),
    Object.freeze({
      kind: 'gvproxy',
      path: '/opt/homebrew/Cellar/podman/5.6.2/libexec/podman/gvproxy',
      sha256: 'bff67aa2b7150768910fc8de3a9d988a717d778b3db318da5e23d51ec3dfcf75',
    }),
  ]),
  original: Object.freeze({
    launchId: '37e02cdb-068a-43fe-98e4-e51ed232ce3f',
    instanceId: 'c06d3fea-870a-45c5-9352-85359dd1a214',
    controllerGeneration: 1,
    sourceCommit: '9e301092e418307f772758e8bcab12db8dff65e5',
    sourceTree: 'd8ef3eb18b9b8576f6a2c61a9539dfaa38bc618e',
    buildSha256: '737850c423571ccb20f4e21ff904086023f3c02cff66e136aaba0eff21e5214f',
    configSha256: '81dc11b4e9d22e373c04a3d2a9af6201cd0619a38a699a16775973cc015b8151',
    inputsSha256: 'f41f94408e1e76b6ba2ee6c0d53eff7491971ccf43d02db00d3489e78b201ca0',
    createdAt: 1791596391790,
    capturedAt: 1791596399384,
  }),
  currentBoot: Object.freeze({
    id: '77C8989D-6420-42B0-BDC5-ACA8A065D98F',
    startedAt: 1791639605000,
  }),
});
const proofNames = [
  'dispatchClosure',
  'vmStopped',
  'noOpenHandles',
  'noMountedAliases',
  'autostartDisabled',
  'archiveExcluded',
  'completeOpaqueState',
  'noStateAliases',
];
const componentNames = [
  'machine',
  'diskChain',
  'home',
  'workspace',
  'gateway',
  'settings',
  'service',
];
const postconditions = [
  'archiveVerified',
  'originalPathsUnavailable',
  'dispatchClosure',
  'archiveExcluded',
  'controlBindingsInvalidated',
];
const shaPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function requireFact(condition, name) {
  if (!condition) throw Error(`Offline containment requires verified ${name}; retain uncertainty`);
}
function keys(value, names, name) {
  requireFact(value && typeof value === 'object' && !Array.isArray(value), name);
  requireFact(Object.keys(value).sort().join() === [...names].sort().join(), name);
}
function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function path(value) {
  return (
    typeof value === 'string' &&
    value.length <= 2048 &&
    value.startsWith('/') &&
    [...value].every(
      (character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
    ) &&
    resolve(value) === value &&
    value !== '/'
  );
}
function inside(parent, child) {
  return child === parent || child.startsWith(parent + sep);
}
function overlaps(a, b) {
  return inside(a, b) || inside(b, a);
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item) ?? 'null').join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value) => createHash('sha256').update(stable(value)).digest('hex');
export const offlineContainmentDigest = hash;
function frozen(value) {
  const copy = JSON.parse(JSON.stringify(value));
  const freeze = (item) => {
    if (item && typeof item === 'object') {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}
function proofs(value, names, allowUnknown = false) {
  keys(value, names, 'bounded proposal observations');
  for (const name of names) {
    if (allowUnknown && value[name]?.status === 'unknown') {
      keys(value[name], ['status', 'reason'], name);
      requireFact(
        typeof value[name].reason === 'string' &&
          /^[A-Za-z0-9 ._-]{1,200}$/.test(value[name].reason),
        name,
      );
      continue;
    }
    keys(value[name], ['status', 'evidenceSha256'], name);
    requireFact(
      value[name].status === 'confirmed' && shaPattern.test(value[name].evidenceSha256),
      name,
    );
  }
}

/** Pure proposal shape/binding verifier. The historically named `proofs` field
 * contains observations only, including explicit unknowns. Even confirmed status
 * and hashes are not authentication, physical closure or execution capabilities.
 * Plans themselves never authorize filesystem actions, native cleanup or capacity. */
export function createOfflineContainmentPlan(facts) {
  requireFact(Buffer.byteLength(JSON.stringify(facts) ?? '') <= 65536, 'bounded facts');
  keys(
    facts,
    [
      'version',
      'operatorUid',
      'canonicalRoot',
      'archiveRoot',
      'futureRoots',
      'original',
      'currentBoot',
      'retained',
      'scope',
      'units',
      'proofs',
      'controls',
      'nativeHelpers',
    ],
    'facts schema',
  );
  requireFact(
    facts.version === 1 &&
      integer(facts.operatorUid) &&
      facts.operatorUid > 0 &&
      facts.operatorUid === process.getuid?.(),
    'current operator UID',
  );
  const target = OFFLINE_CONTAINMENT_TARGET;
  keys(
    facts.original,
    [...Object.keys(target.original), 'ownerBirthAt'],
    'original owner identity',
  );
  requireFact(
    Object.entries(target.original).every(([key, value]) => facts.original[key] === value),
    'exact selected lost owner',
  );
  requireFact(
    integer(facts.original.ownerBirthAt) &&
      facts.original.ownerBirthAt > 0 &&
      facts.original.ownerBirthAt <= facts.original.createdAt,
    'original process birth',
  );
  keys(facts.currentBoot, ['id', 'startedAt'], 'current boot');
  requireFact(
    stable(facts.currentBoot) === stable(target.currentBoot) &&
      facts.original.capturedAt < facts.currentBoot.startedAt,
    'positive post-owner boot',
  );
  keys(
    facts.retained,
    ['state', 'rowSha256', 'intentSha256', 'retirementReceipt'],
    'retained owner evidence',
  );
  requireFact(
    facts.retained.state === 'retirement_uncertain' &&
      facts.retained.retirementReceipt === 'absent' &&
      shaPattern.test(facts.retained.rowSha256) &&
      shaPattern.test(facts.retained.intentSha256),
    'retained uncertainty',
  );
  keys(facts.scope, ['nativeExecution', 'hostOperations', 'inventory'], 'closed resource scope');
  requireFact(
    facts.scope.nativeExecution === 'selected_vm_only' &&
      ['none', 'unknown'].includes(facts.scope.hostOperations) &&
      facts.scope.inventory === 'configured_unit_manifest',
    'known resource scope',
  );
  requireFact(
    facts.canonicalRoot === target.canonicalRoot &&
      path(facts.archiveRoot) &&
      dirname(facts.archiveRoot) === facts.canonicalRoot + '-quarantine' &&
      uuidPattern.test(basename(facts.archiveRoot)) &&
      !overlaps(facts.canonicalRoot, facts.archiveRoot),
    'separate opaque archive',
  );
  requireFact(
    Array.isArray(facts.futureRoots) &&
      facts.futureRoots.length > 0 &&
      facts.futureRoots.length <= 32 &&
      facts.futureRoots.includes(facts.canonicalRoot) &&
      facts.futureRoots.every((root) => path(root) && !overlaps(root, facts.archiveRoot)),
    'archive exclusion from every future input and mount',
  );
  requireFact(Array.isArray(facts.units) && facts.units.length === 1, 'one complete opaque unit');
  const unit = facts.units[0];
  keys(
    unit,
    ['kind', 'path', 'archivePath', 'manifestSha256', 'uid', 'mode', 'components'],
    'opaque unit manifest',
  );
  requireFact(
    unit.kind === 'opaque_symposium' &&
      unit.path === join(facts.canonicalRoot, 'symposium') &&
      unit.archivePath === join(facts.archiveRoot, relative(facts.canonicalRoot, unit.path)) &&
      unit.uid === facts.operatorUid &&
      unit.mode === 0o700 &&
      shaPattern.test(unit.manifestSha256),
    'exact private opaque unit',
  );
  keys(unit.components, componentNames, 'complete opaque components');
  requireFact(
    componentNames.every((name) => shaPattern.test(unit.components[name])),
    'component manifests',
  );
  proofs(facts.proofs, proofNames, true);
  requireFact(
    Array.isArray(facts.controls) && facts.controls.length === 2,
    'exact two control bindings',
  );
  for (const expected of target.controls) {
    const control = facts.controls.find((entry) => entry.kind === expected.kind);
    keys(
      control,
      ['kind', 'path', 'archivePath', 'sha256', 'uid', 'mode', 'label', 'registrationState'],
      'bounded control binding',
    );
    requireFact(
      Object.entries(expected).every(([key, value]) => control[key] === value) &&
        control.uid === facts.operatorUid &&
        control.mode === 0o600 &&
        control.archivePath === join(facts.archiveRoot, 'controls', basename(expected.path)),
      'pinned control binding',
    );
  }
  requireFact(
    Array.isArray(facts.nativeHelpers) && facts.nativeHelpers.length === 3,
    'exact native helper tuple',
  );
  for (const expected of target.nativeHelpers) {
    const helper = facts.nativeHelpers.find((entry) => entry.kind === expected.kind);
    keys(helper, ['kind', 'path', 'sha256'], 'bounded native helper identity');
    requireFact(stable(helper) === stable(expected), 'pinned native helper identity');
  }
  const normalized = {
    ...facts,
    futureRoots: [...new Set(facts.futureRoots)].sort(),
    controls: [...facts.controls].sort((left, right) => left.kind.localeCompare(right.kind)),
    nativeHelpers: [...facts.nativeHelpers].sort((left, right) =>
      left.kind.localeCompare(right.kind),
    ),
  };
  const plan = {
    version: 1,
    disposition,
    preserveOpaque: true,
    noDelete: true,
    nativeCleanupConfirmed: false,
    capacityGrant: false,
    executable: false,
    fenced: false,
    physicalClosure: 'unproved',
    facts: normalized,
    requiredPostconditions: postconditions,
  };
  return frozen({ ...plan, sha256: hash(plan) });
}
