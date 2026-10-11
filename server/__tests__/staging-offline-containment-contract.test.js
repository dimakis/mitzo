import { expect, it } from 'vitest';
import process from 'node:process';
import {
  OFFLINE_CONTAINMENT_TARGET,
  createOfflineContainmentPlan,
  offlineContainmentDigest,
} from '../../scripts/lib/staging-offline-containment-contract.mjs';

const sha = (digit) => digit.repeat(64);
it('canonicalizes persisted JSON with omitted undefined fields and null array slots', () => {
  const value = { mode: 'contained', missing: undefined, items: [undefined, 'retained'] };
  expect(offlineContainmentDigest(value)).toBe(
    offlineContainmentDigest(JSON.parse(JSON.stringify(value))),
  );
});
function facts() {
  const canonicalRoot = OFFLINE_CONTAINMENT_TARGET.canonicalRoot;
  const archiveRoot = canonicalRoot + '-quarantine/33333333-3333-4333-8333-333333333333';
  return {
    version: 1,
    operatorUid: process.getuid(),
    canonicalRoot,
    archiveRoot,
    controls: OFFLINE_CONTAINMENT_TARGET.controls.map((control) => ({
      ...control,
      archivePath: archiveRoot + '/controls/' + control.label + '.plist',
      uid: process.getuid(),
      mode: 0o600,
    })),
    nativeHelpers: OFFLINE_CONTAINMENT_TARGET.nativeHelpers.map((helper) => ({ ...helper })),
    futureRoots: [canonicalRoot, '/private/operator/future-provider'],
    original: {
      ...OFFLINE_CONTAINMENT_TARGET.original,
      ownerBirthAt: OFFLINE_CONTAINMENT_TARGET.original.createdAt - 1790,
      capturedAt: 1791596399384,
    },
    currentBoot: { ...OFFLINE_CONTAINMENT_TARGET.currentBoot },
    retained: {
      state: 'retirement_uncertain',
      rowSha256: sha('c'),
      intentSha256: sha('d'),
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
        path: `${canonicalRoot}/symposium`,
        archivePath: `${archiveRoot}/symposium`,
        manifestSha256: sha('e'),
        uid: process.getuid(),
        mode: 0o700,
        components: Object.fromEntries(
          ['machine', 'diskChain', 'home', 'workspace', 'gateway', 'settings', 'service'].map(
            (key) => [key, sha('e')],
          ),
        ),
      },
    ],
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
      ].map((name) => [name, { status: 'confirmed', evidenceSha256: sha('f') }]),
    ),
  };
}
it('binds deterministic plans to exact containment facts without retirement or capacity authority', () => {
  const f = facts();
  const plan = createOfflineContainmentPlan(f);
  expect(
    createOfflineContainmentPlan({
      ...f,
      proofs: Object.fromEntries(Object.entries(f.proofs).reverse()),
      controls: [...f.controls].reverse(),
      nativeHelpers: [...f.nativeHelpers].reverse(),
    }).sha256,
  ).toBe(plan.sha256);
  expect(plan.disposition).toBe('contained_offline_native_cleanup_unconfirmed');
  expect(plan.preserveOpaque).toBe(true);
  expect(plan.noDelete).toBe(true);
  expect(plan.nativeCleanupConfirmed).toBe(false);
  expect(plan.capacityGrant).toBe(false);
  expect(f.retained.state).toBe('retirement_uncertain');
  f.units[0].manifestSha256 = sha('f');
  expect(createOfflineContainmentPlan(f).sha256).not.toBe(plan.sha256);
});
it('describes unmet containment requirements without pretending pre-action absence proves a fence', () => {
  const f = facts();
  f.scope.hostOperations = 'unknown';
  for (const key of Object.keys(f.proofs))
    f.proofs[key] = { status: 'unknown', reason: 'Independent physical mechanism not reviewed' };
  const plan = createOfflineContainmentPlan(f);
  expect(plan.executable).toBe(false);
  expect(plan.requiredPostconditions).toEqual([
    'archiveVerified',
    'originalPathsUnavailable',
    'dispatchClosure',
    'archiveExcluded',
    'controlBindingsInvalidated',
  ]);
  expect(plan.fenced).toBe(false);
  expect(plan.physicalClosure).toBe('unproved');
});
it.each([
  'dispatchClosure',
  'vmStopped',
  'noOpenHandles',
  'noMountedAliases',
  'autostartDisabled',
  'archiveExcluded',
  'completeOpaqueState',
  'noStateAliases',
])('requires positive %s evidence rather than missing/unknown/false observations', (key) => {
  for (const proof of [
    undefined,
    false,
    { status: 'unknown', evidenceSha256: sha('a') },
    { status: 'confirmed' },
  ]) {
    const f = facts();
    f.proofs[key] = proof;
    expect(() => createOfflineContainmentPlan(f)).toThrow();
  }
});
it('refuses unrelated owners, same-boot observations, unknown host scope and malformed manifests', () => {
  const patches = [
    (f) => {
      f.original.sourceCommit = 'a'.repeat(40);
    },
    (f) => {
      f.original.instanceId = 'other-owner';
    },
    (f) => {
      f.original.controllerGeneration = 2;
    },
    (f) => {
      f.currentBoot.id = 'other-boot';
    },
    (f) => {
      f.currentBoot.startedAt = f.original.ownerBirthAt;
    },
    (f) => {
      f.scope.hostOperations = 'active';
    },
    (f) => {
      f.scope.nativeExecution = 'unknown';
    },
    (f) => {
      f.units.pop();
    },
    (f) => {
      f.units[0].uid = 0;
    },
    (f) => {
      f.units[0].mode = 0o755;
    },
    (f) => {
      f.units[0].manifestSha256 = '';
    },
    (f) => {
      f.retained.state = 'retired';
    },
    (f) => {
      f.original.credentials = 'secret';
    },
    (f) => {
      f.controls[0].path = '/other/job.plist';
    },
    (f) => {
      f.controls[0].sha256 = sha('f');
    },
    (f) => {
      f.controls[1].registrationState = 'running';
    },
    (f) => {
      f.nativeHelpers[0].path = '/other/podman';
    },
    (f) => {
      f.nativeHelpers[1].sha256 = sha('f');
    },
  ];
  for (const patch of patches) {
    const f = facts();
    patch(f);
    expect(() => createOfflineContainmentPlan(f)).toThrow();
  }
});
it('refuses archive/mount overlap and traversal or unbound archive unit paths', () => {
  for (const patch of [
    (f) => {
      f.futureRoots.push(f.archiveRoot);
    },
    (f) => {
      f.futureRoots.push(f.canonicalRoot + '-quarantine');
    },
    (f) => {
      f.archiveRoot = `${f.canonicalRoot}/retained`;
    },
    (f) => {
      f.units[0].path = `${f.canonicalRoot}/../production`;
    },
    (f) => {
      f.units[0].archivePath = '/private/elsewhere';
    },
    (f) => {
      f.units[0].path = '/outside';
    },
  ]) {
    const f = facts();
    patch(f);
    expect(() => createOfflineContainmentPlan(f)).toThrow();
  }
});
it('refuses authentication, response bodies, keys and credential fields at every proposal level', () => {
  for (const mutate of [
    (f) => {
      f.authorization = { token: 'secret' };
    },
    (f) => {
      f.retained.body = 'raw body';
    },
    (f) => {
      f.units[0].privateKey = 'key';
    },
    (f) => {
      f.proofs.dispatchClosure.responseBody = 'raw';
    },
    (f) => {
      f.units[0].components.credentials = 'credential';
    },
    (f) => {
      f.original.bootId = 'invented';
    },
    (f) => {
      f.original.capturedAt = f.currentBoot.startedAt;
    },
  ]) {
    const f = facts();
    mutate(f);
    expect(() => createOfflineContainmentPlan(f)).toThrow();
  }
});
