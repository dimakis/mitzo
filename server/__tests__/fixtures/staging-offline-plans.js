import process from 'node:process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  OFFLINE_CONTAINMENT_TARGET,
  createOfflineContainmentPlan,
} from '../../../scripts/lib/staging-offline-containment-contract.mjs';
import { OFFLINE_CONTAINMENT_NATIVE_TARGET } from '../../../scripts/lib/staging-offline-containment-observation.mjs';
import {
  createOfflineOrdinaryRestorationPlan,
  createOfflineRecoveryProposal,
} from '../../../scripts/lib/staging-offline-ordinary-restore.mjs';
const sha = 'a'.repeat(64);
export function containmentFacts() {
  const root = OFFLINE_CONTAINMENT_TARGET.canonicalRoot;
  const archiveRoot = root + '-quarantine/33333333-3333-4333-8333-333333333333';
  return {
    version: 1,
    operatorUid: process.getuid(),
    canonicalRoot: root,
    archiveRoot,
    futureRoots: [root],
    original: {
      ...OFFLINE_CONTAINMENT_TARGET.original,
      ownerBirthAt: OFFLINE_CONTAINMENT_TARGET.original.createdAt - 1790,
    },
    currentBoot: { ...OFFLINE_CONTAINMENT_TARGET.currentBoot },
    retained: {
      state: 'retirement_uncertain',
      rowSha256: sha,
      intentSha256: sha,
      retirementReceipt: 'absent',
    },
    scope: {
      nativeExecution: 'selected_vm_only',
      hostOperations: 'none',
      inventory: 'configured_unit_manifest',
    },
    units: [
      {
        kind: 'opaque_symposium',
        path: root + '/symposium',
        archivePath: archiveRoot + '/symposium',
        manifestSha256: sha,
        uid: process.getuid(),
        mode: 0o700,
        components: Object.fromEntries(
          ['home', 'workspace', 'gateway', 'settings', 'service', 'machine', 'diskChain'].map(
            (key) => [key, sha],
          ),
        ),
      },
    ],
    controls: [
      {
        kind: 'app',
        path: root + '/service/com.mitzo.staging.plist',
        archivePath: archiveRoot + '/controls/com.mitzo.staging.plist',
        uid: process.getuid(),
        mode: 0o600,
        registrationState: 'absent',
        sha256: OFFLINE_CONTAINMENT_NATIVE_TARGET.appPlistSha256,
        label: 'com.mitzo.staging',
      },
      {
        kind: 'vm_supervisor',
        path: join(homedir(), 'Library/LaunchAgents/com.mitzo.staging.vm.plist'),
        archivePath: archiveRoot + '/controls/com.mitzo.staging.vm.plist',
        uid: process.getuid(),
        mode: 0o600,
        registrationState: 'loaded_stopped',
        sha256: OFFLINE_CONTAINMENT_NATIVE_TARGET.vmPlistSha256,
        label: 'com.mitzo.staging.vm',
      },
    ],
    nativeHelpers: OFFLINE_CONTAINMENT_NATIVE_TARGET.helpers.map((pin) => ({ ...pin })),
    proofs: Object.fromEntries(
      [
        'dispatchClosure',
        'vmStopped',
        'noOpenHandles',
        'noMountedAliases',
        'autostartDisabled',
        'archiveExcluded',
        'completeOpaqueState',
        'noStateAliases',
      ].map((key) => [
        key,
        ['dispatchClosure', 'autostartDisabled', 'archiveExcluded'].includes(key)
          ? { status: 'unknown', reason: 'Authenticated relocation remains required' }
          : { status: 'confirmed', evidenceSha256: sha },
      ]),
    ),
  };
}
export function ordinaryFacts() {
  const canonicalRoot = OFFLINE_CONTAINMENT_TARGET.canonicalRoot;
  const archiveRoot = canonicalRoot + '-quarantine/33333333-3333-4333-8333-333333333333';
  return {
    version: 1,
    canonicalRoot,
    operatorUid: process.getuid(),
    archiveRoot,
    containment: {
      planSha256: pin('b'),
      classification: 'contained_offline_native_cleanup_unconfirmed',
      originalRegistryState: 'retirement_uncertain',
    },
    source: {
      sourceCommit: 'a'.repeat(40),
      acceptedMainBaseline: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40),
      release: join(canonicalRoot, 'releases', 'a'.repeat(12)),
      controllerReceiptSha256: pin('c'),
      compiledArtifactsSha256: pin('d'),
      dependencyFingerprint: pin('e'),
    },
    installation: {
      launcherSha256: pin('a'),
      controllerManifestSha256: pin('b'),
      registrationSha256: pin('c'),
      controlFiles: [
        'service/start.mjs',
        'service/control-lib/staging-files.mjs',
        'service/control-lib/staging-operations.mjs',
        'service/release-receipt.json',
        'service/topology.json',
        'service/com.mitzo.staging.plist',
        'bin/mitzo-staging',
      ].map((name) => ({
        path: join(canonicalRoot, name),
        archivePath: join(archiveRoot, 'ordinary-prior-controls', name),
        prior: { state: 'present', sha256: pin('e'), uid: process.getuid(), mode: 0o600 },
        nextSha256:
          name === 'service/start.mjs'
            ? pin('a')
            : name === 'service/com.mitzo.staging.plist'
              ? pin('c')
              : pin('d'),
      })),
    },
    preservation: ['home', 'workspace', 'state', 'settings'].map((kind) => ({
      kind,
      path: join(canonicalRoot, kind),
      archivePath: join(archiveRoot, 'ordinary-prior', kind),
      manifestSha256: pin('f'),
      uid: process.getuid(),
      mode: 0o700,
    })),
  };
}

const pin = (digit) => digit.repeat(64);
export function recoveryProposal() {
  const containmentPlan = createOfflineContainmentPlan(containmentFacts());
  const facts = ordinaryFacts();
  facts.containment.planSha256 = containmentPlan.sha256;
  const ordinaryPlan = createOfflineOrdinaryRestorationPlan(facts);
  return createOfflineRecoveryProposal({ containmentPlan, ordinaryPlan });
}
