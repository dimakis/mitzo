import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { join, basename, relative, resolve } from 'node:path';
import {
  OFFLINE_CONTAINMENT_TARGET,
  createOfflineContainmentPlan,
} from './staging-offline-containment-contract.mjs';
import { stagingBoundary } from './staging-operations.mjs';
import { assertStageJob } from './staging-job.mjs';

const legacyKinds = ['home', 'workspace', 'state', 'settings'];
const requiredControls = [
  'service/start.mjs',
  'service/control-lib/staging-files.mjs',
  'service/control-lib/staging-operations.mjs',
  'service/release-receipt.json',
  'service/topology.json',
  'service/com.mitzo.staging.plist',
  'bin/mitzo-staging',
];
const sha = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
function requireRestore(condition) {
  if (!condition)
    throw Error('Exact qualified ordinary restoration required; retain staging guard');
}
function keys(value, names) {
  requireRestore(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join() === [...names].sort().join(),
  );
}
function freeze(value) {
  const copy = JSON.parse(JSON.stringify(value));
  const visit = (item) => {
    if (item && typeof item === 'object') {
      Object.values(item).forEach(visit);
      Object.freeze(item);
    }
  };
  visit(copy);
  return copy;
}

/** Reviewable proposal only. Legacy mutable directories and every overwritten
 * control file are bound BEFORE the higher-level MAC authentication prompt.
 * Service/bin and the existing same-operation lock remain continuously in place. */
export function createOfflineOrdinaryRestorationPlan(facts) {
  requireRestore(Buffer.byteLength(JSON.stringify(facts) ?? '') <= 65536);
  keys(facts, [
    'version',
    'canonicalRoot',
    'operatorUid',
    'archiveRoot',
    'containment',
    'source',
    'installation',
    'preservation',
  ]);
  const root = facts.canonicalRoot;
  requireRestore(
    facts.version === 1 &&
      root === OFFLINE_CONTAINMENT_TARGET.canonicalRoot &&
      facts.operatorUid === process.getuid() &&
      facts.operatorUid > 0 &&
      typeof facts.archiveRoot === 'string' &&
      resolve(facts.archiveRoot) === facts.archiveRoot &&
      facts.archiveRoot === root + '-quarantine/' + basename(facts.archiveRoot) &&
      uuid.test(basename(facts.archiveRoot)),
  );
  keys(facts.containment, ['planSha256', 'classification', 'originalRegistryState']);
  requireRestore(
    sha.test(facts.containment.planSha256) &&
      facts.containment.classification === 'contained_offline_native_cleanup_unconfirmed' &&
      facts.containment.originalRegistryState === 'retirement_uncertain',
  );
  keys(facts.source, [
    'sourceCommit',
    'acceptedMainBaseline',
    'sourceTree',
    'release',
    'controllerReceiptSha256',
    'compiledArtifactsSha256',
    'dependencyFingerprint',
  ]);
  requireRestore(
    commit.test(facts.source.sourceCommit) &&
      facts.source.sourceCommit === facts.source.acceptedMainBaseline &&
      commit.test(facts.source.sourceTree) &&
      ['controllerReceiptSha256', 'compiledArtifactsSha256', 'dependencyFingerprint'].every(
        (name) => sha.test(facts.source[name]),
      ),
  );
  stagingBoundary({
    root,
    label: 'com.mitzo.staging',
    port: 3190,
    bind: '127.0.0.1',
    workspace: join(root, 'workspace'),
    release: facts.source.release,
    sourceCommit: facts.source.sourceCommit,
  });
  requireRestore(
    Array.isArray(facts.preservation) && facts.preservation.length === legacyKinds.length,
  );
  for (const kind of legacyKinds) {
    const unit = facts.preservation.find((item) => item.kind === kind);
    keys(unit, ['kind', 'path', 'archivePath', 'manifestSha256', 'uid', 'mode']);
    requireRestore(
      unit.path === join(root, kind) &&
        unit.archivePath === join(facts.archiveRoot, 'ordinary-prior', kind) &&
        sha.test(unit.manifestSha256) &&
        unit.uid === facts.operatorUid &&
        unit.mode === 0o700,
    );
  }
  keys(facts.installation, [
    'launcherSha256',
    'controllerManifestSha256',
    'registrationSha256',
    'controlFiles',
  ]);
  requireRestore(
    ['launcherSha256', 'controllerManifestSha256', 'registrationSha256'].every((name) =>
      sha.test(facts.installation[name]),
    ),
  );
  const files = facts.installation.controlFiles;
  requireRestore(
    Array.isArray(files) &&
      files.length >= requiredControls.length &&
      files.length <= 128 &&
      new Set(files.map((file) => file.path)).size === files.length,
  );
  for (const file of files) {
    keys(file, ['path', 'archivePath', 'prior', 'nextSha256']);
    const name = relative(root, file.path);
    requireRestore(
      resolve(file.path) === file.path &&
        (requiredControls.includes(name) || /^bin\/lib\/[A-Za-z0-9._-]+\.mjs$/.test(name)) &&
        file.archivePath === join(facts.archiveRoot, 'ordinary-prior-controls', name) &&
        (sha.test(file.nextSha256) ||
          (name === 'service/topology.json' && file.nextSha256 === 'derived_containment_topology')),
    );
    if (file.prior?.state === 'absent') keys(file.prior, ['state']);
    else {
      keys(file.prior, ['state', 'sha256', 'uid', 'mode']);
      requireRestore(
        file.prior.state === 'present' &&
          sha.test(file.prior.sha256) &&
          file.prior.uid === facts.operatorUid &&
          Number.isSafeInteger(file.prior.mode) &&
          file.prior.mode > 0 &&
          file.prior.mode <= 0o777 &&
          !(file.prior.mode & 0o022),
      );
    }
  }
  requireRestore(
    requiredControls.every((name) => files.some((file) => file.path === join(root, name))),
  );
  requireRestore(
    files.find((file) => file.path === join(root, 'service/start.mjs')).nextSha256 ===
      facts.installation.launcherSha256 &&
      files.find((file) => file.path === join(root, 'service/com.mitzo.staging.plist'))
        .nextSha256 === facts.installation.registrationSha256,
  );
  const normalized = {
    ...facts,
    preservation: [...facts.preservation].sort((a, b) => a.kind.localeCompare(b.kind)),
    installation: {
      ...facts.installation,
      controlFiles: [...files].sort((a, b) => a.path.localeCompare(b.path)),
    },
  };
  const proposal = {
    version: 1,
    mode: 'ordinary',
    executable: false,
    nativeCleanupConfirmed: false,
    capacityGrant: false,
    facts: normalized,
    providers: [],
    registration: {
      label: 'com.mitzo.staging',
      path: join(root, 'service/com.mitzo.staging.plist'),
      RunAtLoad: false,
      KeepAlive: false,
    },
    rebootRecovery: 'requires_separately_reviewed_byte_bound_registration',
    launch: {
      port: 3190,
      bind: '127.0.0.1',
      nativeEnabled: false,
      codexEnabled: false,
      connectionsEnabled: false,
      proxyPorts: [5191, 5192, 5193],
      launcherSource: 'scripts/lib/staging-launcher-template.mjs',
    },
  };
  return freeze({ ...proposal, sha256: digest(proposal) });
}

/** Both physical preservation scopes are visible and hashed before one OS prompt.
 * The future native receipt is deliberately absent; execution verifies it later. */
export function createOfflineRecoveryProposal({ containmentPlan, ordinaryPlan }) {
  const containment = createOfflineContainmentPlan(containmentPlan.facts);
  const ordinary = createOfflineOrdinaryRestorationPlan(ordinaryPlan.facts);
  requireRestore(
    digest(containment) === digest(containmentPlan) &&
      digest(ordinary) === digest(ordinaryPlan) &&
      ordinary.facts.containment.planSha256 === containment.sha256 &&
      ordinary.facts.archiveRoot === containment.facts.archiveRoot &&
      ordinary.facts.canonicalRoot === containment.facts.canonicalRoot,
  );
  const proposal = {
    version: 1,
    mode: 'contain_then_restore_ordinary',
    executable: false,
    containmentPlan: containment,
    ordinaryPlan: ordinary,
  };
  return freeze({ ...proposal, sha256: digest(proposal) });
}

/** Private original-parent phase adapter. A token is consumed once against the
 * combined digest; phase closures preserve its original helper binding/deadline.
 * Serialized objects, phase close or JSON witnesses cannot authorize phase two. */
export function createOfflineRecoveryAuthority({
  proposal: selected,
  consumeAuthority,
  assertContainmentReady,
}) {
  const proposal = createOfflineRecoveryProposal(selected);
  requireRestore(
    digest(proposal) === digest(selected) &&
      typeof consumeAuthority === 'function' &&
      typeof assertContainmentReady === 'function',
  );
  let token,
    base,
    closed = false,
    containmentUsed = false,
    containmentClosed = false,
    ordinaryUsed = false;
  const current = () => {
    requireRestore(!closed && base);
    return base.assertCurrent(proposal.sha256);
  };
  const phase = (sha256, onClose) => {
    let phaseClosed = false;
    return Object.freeze({
      assertCurrent(expected) {
        requireRestore(!phaseClosed && expected === sha256);
        return current();
      },
      close() {
        if (!phaseClosed) {
          phaseClosed = true;
          onClose();
        }
      },
    });
  };
  return Object.freeze({
    consumeContainment(authority, expected) {
      requireRestore(!closed && !containmentUsed && expected === proposal.containmentPlan.sha256);
      base = consumeAuthority(authority, proposal.sha256);
      requireRestore(
        base && typeof base.assertCurrent === 'function' && typeof base.close === 'function',
      );
      current();
      token = authority;
      containmentUsed = true;
      return phase(expected, () => {
        containmentClosed = true;
      });
    },
    async consumeOrdinary(authority, expected) {
      requireRestore(
        !closed &&
          containmentClosed &&
          !ordinaryUsed &&
          authority === token &&
          expected === proposal.ordinaryPlan.sha256,
      );
      current();
      ordinaryUsed = true;
      await assertContainmentReady(proposal.containmentPlan);
      current();
      return phase(expected, () => {});
    },
    assertCurrent: current,
    close() {
      if (!closed) {
        closed = true;
        base?.close();
      }
    },
  });
}

/** Only constructor-supplied original controller capabilities perform effects.
 * No JSON flag authorizes restoration. An attempted operation never auto-retries,
 * restarts a VM/custodian, rolls back, clears a foreign lock or copies old settings. */
export function createOfflineOrdinaryRestoration({ plan: selected, consumeAuthority, effects }) {
  const plan = createOfflineOrdinaryRestorationPlan(selected.facts);
  requireRestore(digest(selected) === digest(plan) && typeof consumeAuthority === 'function');
  for (const name of [
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
    'bootstrapCanonical',
    'kickstartCanonical',
    'verifyCanonical',
    'writeCompletion',
    'completeGuard',
  ])
    requireRestore(typeof effects?.[name] === 'function');
  let used = false;
  return Object.freeze({
    async apply(authority) {
      requireRestore(!used);
      const lease = await consumeAuthority(authority, plan.sha256);
      requireRestore(
        lease && typeof lease.assertCurrent === 'function' && typeof lease.close === 'function',
      );
      used = true;
      const current = () => lease.assertCurrent(plan.sha256);
      let containmentSha256;
      const checked = async (name, ...args) => {
        current();
        const result = await effects[name](...args, { assertCurrent: current });
        current();
        if (name === 'assertNativeContained') {
          requireRestore(
            result &&
              sha.test(result.receiptSha256) &&
              (!containmentSha256 || containmentSha256 === result.receiptSha256),
          );
          containmentSha256 = result.receiptSha256;
        }
        return result;
      };
      try {
        current();
        await checked('assertAcceptedPreparedSource', plan);
        await checked('assertNativeContained', plan);
        await checked('assertOriginalOrdinaryScope', plan);
        await checked('assertGuardOwnership', plan);
        for (const unit of plan.facts.preservation) await checked('assertOriginalUnit', unit, plan);
        const intent = freeze({
          version: 1,
          mode: 'offline-ordinary-restoration',
          operation: basename(plan.facts.archiveRoot),
          planSha256: plan.sha256,
          containmentSha256: containmentSha256,
          target: plan.facts.source.sourceCommit,
        });
        await checked('writeDurableIntent', intent, plan);
        for (const file of plan.facts.installation.controlFiles) {
          await checked('snapshotControl', file, plan);
          await checked('assertControlSnapshot', file, plan);
        }
        for (const unit of plan.facts.preservation) {
          await checked('assertNativeContained', plan);
          await checked('assertGuardOwnership', plan);
          await checked('preserveUnit', unit, plan);
          await checked('assertPreservedUnit', unit, plan);
        }
        for (const kind of legacyKinds)
          await checked(
            'createFreshDirectory',
            { path: join(plan.facts.canonicalRoot, kind), mode: 0o700, empty: true },
            plan,
          );
        await checked(
          'writeFreshSettings',
          {
            operator: {
              AUTH_PASSPHRASE: randomBytes(32).toString('hex'),
              AUTH_SECRET: randomBytes(64).toString('hex'),
            },
            accountProfiles: [],
            mode: 0o600,
          },
          plan,
        );
        await checked('assertAcceptedPreparedSource', plan);
        await checked('installOrdinaryController', plan);
        await checked('assertInstalledOrdinary', plan);
        await checked('assertNativeContained', plan);
        await checked('assertGuardOwnership', plan);
        await checked('writeStartAttempt', intent, plan);
        await checked('bootstrapCanonical', plan.registration, plan);
        const originalJob = await checked(
          'kickstartCanonical',
          { label: 'com.mitzo.staging', force: false },
          plan,
        );
        requireRestore(
          originalJob &&
            Number.isSafeInteger(originalJob.pid) &&
            originalJob.pid > 1 &&
            typeof originalJob.birth === 'string' &&
            originalJob.birth.length > 0 &&
            originalJob.birth.length <= 128,
        );
        const observed = await checked('verifyCanonical', plan);
        assertStageJob(observed, { release: plan.facts.source.release }, originalJob);
        requireRestore(
          observed.label === 'com.mitzo.staging' &&
            observed.httpStatus === 200 &&
            observed.registrationSha256 === plan.facts.installation.registrationSha256 &&
            observed.providerProfiles === 0 &&
            observed.nativeEnabled === false &&
            observed.codexEnabled === false &&
            observed.connectionsEnabled === false,
        );
        await checked('assertAcceptedPreparedSource', plan);
        await checked('assertNativeContained', plan);
        await checked('assertGuardOwnership', plan);
        const receipt = freeze({
          version: 1,
          mode: 'ordinary',
          planSha256: plan.sha256,
          containmentSha256: containmentSha256,
          sourceCommit: plan.facts.source.sourceCommit,
          label: 'com.mitzo.staging',
          pid: observed.pid,
          birth: observed.birth,
          port: 3190,
          providerProfiles: 0,
          nativeCleanupConfirmed: false,
          rebootRecovery: plan.rebootRecovery,
        });
        await checked('writeCompletion', receipt, plan);
        await checked('completeGuard', receipt, plan);
        return receipt;
      } finally {
        lease.close();
      }
    },
  });
}
