import { expect, it, vi } from 'vitest';
import process from 'node:process';
import { join } from 'node:path';
import {
  createOfflineOrdinaryRestorationPlan,
  createOfflineOrdinaryRestoration,
  createOfflineRecoveryProposal,
  createOfflineRecoveryAuthority,
} from '../../scripts/lib/staging-offline-ordinary-restore.mjs';
import {
  OFFLINE_CONTAINMENT_TARGET,
  createOfflineContainmentPlan,
} from '../../scripts/lib/staging-offline-containment-contract.mjs';
const sha = (digit) => digit.repeat(64);
function facts() {
  const canonicalRoot = OFFLINE_CONTAINMENT_TARGET.canonicalRoot;
  const archiveRoot = canonicalRoot + '-quarantine/33333333-3333-4333-8333-333333333333';
  return {
    version: 1,
    canonicalRoot,
    operatorUid: process.getuid(),
    archiveRoot,
    containment: {
      planSha256: sha('b'),
      classification: 'contained_offline_native_cleanup_unconfirmed',
      originalRegistryState: 'retirement_uncertain',
    },
    source: {
      sourceCommit: 'a'.repeat(40),
      acceptedMainBaseline: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40),
      release: join(canonicalRoot, 'releases', 'a'.repeat(12)),
      controllerReceiptSha256: sha('c'),
      compiledArtifactsSha256: sha('d'),
      dependencyFingerprint: sha('e'),
    },
    installation: {
      launcherSha256: sha('a'),
      controllerManifestSha256: sha('b'),
      registrationSha256: sha('c'),
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
        prior: { state: 'present', sha256: sha('e'), uid: process.getuid(), mode: 0o600 },
        nextSha256:
          name === 'service/start.mjs'
            ? sha('a')
            : name === 'service/com.mitzo.staging.plist'
              ? sha('c')
              : sha('d'),
      })),
    },
    preservation: ['home', 'workspace', 'state', 'settings'].map((kind) => ({
      kind,
      path: join(canonicalRoot, kind),
      archivePath: join(archiveRoot, 'ordinary-prior', kind),
      manifestSha256: sha('f'),
      uid: process.getuid(),
      mode: 0o700,
    })),
  };
}
function fixture() {
  const plan = createOfflineOrdinaryRestorationPlan(facts());
  const calls = [];
  const effects = Object.fromEntries(
    [
      'assertAcceptedPreparedSource',
      'assertNativeContained',
      'assertOriginalOrdinaryScope',
      'assertOriginalUnit',
      'writeDurableIntent',
      'assertGuardOwnership',
      'snapshotControl',
      'assertControlSnapshot',
      'preserveUnit',
      'assertPreservedUnit',
      'createFreshDirectory',
      'writeFreshSettings',
      'installOrdinaryController',
      'assertInstalledOrdinary',
      'writeStartAttempt',
      'writeLaunchPermit',
      'bootstrapCanonical',
      'kickstartCanonical',
      'writeCompletion',
      'completeGuard',
    ].map((name) => [
      name,
      vi.fn(async (...args) => {
        calls.push({ name, args });
      }),
    ]),
  );
  effects.verifyCanonical = vi.fn(async () => ({
    label: 'com.mitzo.staging',
    pid: 4321,
    birth: 'new exact birth',
    cwd: plan.facts.source.release,
    portPids: [4321],
    protectedPids: [],
    httpStatus: 200,
    registrationSha256: plan.facts.installation.registrationSha256,
    providerProfiles: 0,
    nativeEnabled: false,
    codexEnabled: false,
    connectionsEnabled: false,
  }));
  effects.kickstartCanonical.mockImplementation(async (...args) => {
    calls.push({ name: 'kickstartCanonical', args });
    return { pid: 4321, birth: 'new exact birth' };
  });
  effects.assertNativeContained.mockImplementation(async (...args) => {
    calls.push({ name: 'assertNativeContained', args });
    return { receiptSha256: sha('a') };
  });
  const lease = { assertCurrent: vi.fn(() => true), close: vi.fn() };
  const consumeAuthority = vi.fn(() => lease);
  const restore = createOfflineOrdinaryRestoration({ plan, consumeAuthority, effects });
  return { plan, effects, calls, lease, consumeAuthority, restore };
}
it('binds all old ordinary state preservation before authentication and keeps reboot repair explicit', () => {
  const f = facts(),
    plan = createOfflineOrdinaryRestorationPlan(f);
  expect(plan.executable).toBe(false);
  expect(plan.mode).toBe('ordinary');
  expect(plan.facts.preservation.map((unit) => unit.kind)).toEqual([
    'home',
    'settings',
    'state',
    'workspace',
  ]);
  expect(plan.registration).toMatchObject({
    label: 'com.mitzo.staging',
    RunAtLoad: false,
    KeepAlive: false,
  });
  expect(plan.rebootRecovery).toBe('requires_separately_reviewed_byte_bound_registration');
  expect(plan.providers).toEqual([]);
  f.preservation[0].manifestSha256 = sha('a');
  expect(createOfflineOrdinaryRestorationPlan(f).sha256).not.toBe(plan.sha256);
});
it('refuses incomplete preservation, native restoration, unbound paths and nonaccepted release', () => {
  for (const mutate of [
    (f) => {
      f.preservation.pop();
    },
    (f) => {
      f.preservation[0].path = '/production/home';
    },
    (f) => {
      f.preservation[0].archivePath = join(f.canonicalRoot, 'backup');
    },
    (f) => {
      f.preservation[0].mode = 0o755;
    },
    (f) => {
      f.source.acceptedMainBaseline = 'b'.repeat(40);
    },
    (f) => {
      f.source.release = '/other/release';
    },
    (f) => {
      f.containment.classification = 'retired';
    },
    (f) => {
      f.providerCredentials = 'secret';
    },
    (f) => {
      f.installation.controlFiles[0].path = join(f.canonicalRoot, 'service/deployment.lock');
    },
    (f) => {
      f.installation.controlFiles[0].nextSha256 = sha('e');
    },
    (f) => {
      f.installation.controlFiles[5].nextSha256 = sha('e');
    },
  ]) {
    const f = facts();
    mutate(f);
    expect(() => createOfflineOrdinaryRestorationPlan(f)).toThrow();
  }
});
it('preserves opaque data before creating fresh empty ordinary state and starts exactly once', async () => {
  const f = fixture();
  const result = await f.restore.apply({});
  expect(f.consumeAuthority).toHaveBeenCalledWith({}, f.plan.sha256);
  const names = f.calls.map(({ name }) => name);
  expect(names.indexOf('writeDurableIntent')).toBeLessThan(names.indexOf('preserveUnit'));
  expect(names.lastIndexOf('assertControlSnapshot')).toBeLessThan(
    names.indexOf('installOrdinaryController'),
  );
  expect(names.lastIndexOf('assertPreservedUnit')).toBeLessThan(
    names.indexOf('createFreshDirectory'),
  );
  expect(names.indexOf('assertInstalledOrdinary')).toBeLessThan(names.indexOf('writeStartAttempt'));
  expect(names.indexOf('writeStartAttempt')).toBeLessThan(names.indexOf('bootstrapCanonical'));
  expect(f.effects.bootstrapCanonical).toHaveBeenCalledTimes(1);
  expect(f.effects.kickstartCanonical).toHaveBeenCalledTimes(1);
  const settings = f.effects.writeFreshSettings.mock.calls[0][0];
  expect(settings.operator.AUTH_PASSPHRASE.length).toBeGreaterThanOrEqual(32);
  expect(settings.operator.AUTH_SECRET.length).toBeGreaterThanOrEqual(64);
  expect(settings.accountProfiles).toEqual([]);
  expect(settings.mode).toBe(0o600);
  expect(JSON.stringify(result)).not.toContain(settings.operator.AUTH_SECRET);
  expect(result).toMatchObject({
    mode: 'ordinary',
    port: 3190,
    providerProfiles: 0,
    nativeCleanupConfirmed: false,
    containmentSha256: sha('a'),
  });
  expect(f.lease.assertCurrent).toHaveBeenCalled();
  expect(f.lease.close).toHaveBeenCalledOnce();
  await expect(f.restore.apply({})).rejects.toThrow();
});
it('keeps the guard and refuses launch on containment/source/data/authorization uncertainty', async () => {
  for (const failure of [
    'assertNativeContained',
    'assertAcceptedPreparedSource',
    'preserveUnit',
    'assertInstalledOrdinary',
  ]) {
    const f = fixture();
    f.effects[failure].mockRejectedValueOnce(Error('unconfirmed'));
    await expect(f.restore.apply({})).rejects.toThrow();
    expect(f.effects.kickstartCanonical).not.toHaveBeenCalled();
    expect(f.effects.completeGuard).not.toHaveBeenCalled();
    expect(f.lease.close).toHaveBeenCalledOnce();
  }
  const expired = fixture();
  expired.lease.assertCurrent
    .mockImplementationOnce(() => true)
    .mockImplementation(() => {
      throw Error('expired');
    });
  await expect(expired.restore.apply({})).rejects.toThrow();
  expect(expired.effects.preserveUnit).not.toHaveBeenCalled();
});
it('cannot unlock or retry a dispatched start until exact job birth/cwd/HTTP proof', async () => {
  for (const patch of [
    { httpStatus: 503 },
    { cwd: '/other' },
    { birth: 'different born process' },
    { pid: 5000, portPids: [5000] },
    { registrationSha256: sha('f') },
    { portPids: [4321, 5000] },
    { nativeEnabled: true },
    { providerProfiles: 1 },
  ]) {
    const f = fixture();
    const original = await f.effects.verifyCanonical();
    f.effects.verifyCanonical.mockResolvedValue({ ...original, ...patch });
    await expect(f.restore.apply({})).rejects.toThrow();
    expect(f.effects.completeGuard).not.toHaveBeenCalled();
    expect(f.effects.writeCompletion).not.toHaveBeenCalled();
    await expect(f.restore.apply({})).rejects.toThrow();
  }
});
function combined() {
  const f = facts(),
    target = OFFLINE_CONTAINMENT_TARGET;
  const containmentPlan = createOfflineContainmentPlan({
    version: 1,
    operatorUid: process.getuid(),
    canonicalRoot: f.canonicalRoot,
    archiveRoot: f.archiveRoot,
    futureRoots: [f.canonicalRoot],
    original: { ...target.original, ownerBirthAt: target.original.createdAt - 1790 },
    currentBoot: target.currentBoot,
    retained: {
      state: 'retirement_uncertain',
      rowSha256: sha('a'),
      intentSha256: sha('b'),
      retirementReceipt: 'absent',
    },
    scope: {
      nativeExecution: 'selected_vm_only',
      hostOperations: 'unknown',
      inventory: 'configured_unit_manifest',
    },
    units: [
      {
        kind: 'opaque_symposium',
        path: join(f.canonicalRoot, 'symposium'),
        archivePath: join(f.archiveRoot, 'symposium'),
        manifestSha256: sha('c'),
        uid: process.getuid(),
        mode: 0o700,
        components: Object.fromEntries(
          ['machine', 'diskChain', 'home', 'workspace', 'gateway', 'settings', 'service'].map(
            (name) => [name, sha('d')],
          ),
        ),
      },
    ],
    controls: target.controls.map((control) => ({
      ...control,
      archivePath: join(f.archiveRoot, 'controls', control.label + '.plist'),
      uid: process.getuid(),
      mode: 0o600,
    })),
    nativeHelpers: target.nativeHelpers,
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
      ].map((name) => [name, { status: 'unknown', reason: 'Not an execution grant' }]),
    ),
  });
  f.containment.planSha256 = containmentPlan.sha256;
  return createOfflineRecoveryProposal({
    containmentPlan,
    ordinaryPlan: createOfflineOrdinaryRestorationPlan(f),
  });
}
it('binds containment and ordinary preservation scopes before one fresh prompt without predicting a receipt', async () => {
  const proposal = combined();
  expect(proposal.executable).toBe(false);
  expect(proposal.ordinaryPlan.facts.containment.receiptSha256).toBeUndefined();
  const base = { assertCurrent: vi.fn(() => true), close: vi.fn() },
    consumeAuthority = vi.fn(() => base),
    ready = vi.fn(async () => undefined);
  const authority = {},
    phases = createOfflineRecoveryAuthority({
      proposal,
      consumeAuthority,
      assertContainmentReady: ready,
    });
  const containment = phases.consumeContainment(authority, proposal.containmentPlan.sha256);
  expect(consumeAuthority).toHaveBeenCalledWith(authority, proposal.sha256);
  await expect(phases.consumeOrdinary(authority, proposal.ordinaryPlan.sha256)).rejects.toThrow();
  containment.close();
  expect(phases.assertCurrent()).toBe(true);
  const ordinary = await phases.consumeOrdinary(authority, proposal.ordinaryPlan.sha256);
  expect(ready).toHaveBeenCalledWith(proposal.containmentPlan);
  expect(ordinary.assertCurrent(proposal.ordinaryPlan.sha256)).toBe(true);
  expect(() => ordinary.assertCurrent(proposal.containmentPlan.sha256)).toThrow();
  expect(base.close).not.toHaveBeenCalled();
  ordinary.close();
  phases.close();
  expect(base.close).toHaveBeenCalledOnce();
  expect(() => phases.assertCurrent()).toThrow();
  expect(consumeAuthority).toHaveBeenCalledOnce();
});
it('cannot revive phase authority through a copied token, failed containment verification or replay', async () => {
  const proposal = combined(),
    token = {},
    base = { assertCurrent: vi.fn(() => true), close: vi.fn() };
  const phases = createOfflineRecoveryAuthority({
    proposal,
    consumeAuthority: () => base,
    assertContainmentReady: async () => {
      throw Error('unconfirmed');
    },
  });
  phases.consumeContainment(token, proposal.containmentPlan.sha256).close();
  await expect(phases.consumeOrdinary({}, proposal.ordinaryPlan.sha256)).rejects.toThrow();
  await expect(phases.consumeOrdinary(token, proposal.ordinaryPlan.sha256)).rejects.toThrow();
  expect(() => phases.consumeContainment(token, proposal.containmentPlan.sha256)).toThrow();
  phases.close();
});
