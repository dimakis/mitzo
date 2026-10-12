import process from 'node:process';
import { userInfo } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { offlineContainmentDigest as digest } from './staging-offline-containment-contract.mjs';
import { createContainedNativeRegisteredLauncherObserver } from './staging-contained-native-launcher-observation.mjs';
import { createContainedNativeGuard } from './staging-native-disposition-guard.mjs';
import { createContainedNativeDispositionLedger } from './staging-native-disposition-ledger.mjs';
import { createCompletedOfflineContainmentInspector } from './staging-contained-archive.mjs';
import { createFreshStagingImageInspector } from './staging-fresh-image.mjs';
import { createStagingSourceAcceptanceWitness } from './staging-source-acceptance-witness.mjs';
import { qualifyOfflineContainmentController } from './staging-offline-containment-observation.mjs';
import { verifyPreparedController } from './staging-cold-control.mjs';
import { enrollPreparedOfflineOperatorHelper } from './staging-offline-auth-enrollment.mjs';
import { createStagingOfflineOperatorAuthorizer } from './staging-offline-operator-auth.mjs';
import { createUnmutatedNativeAllocationInspector } from './staging-native-unmutated.mjs';
import { createNativeOriginalOwnerHandoff } from './staging-native-owner-handoff.mjs';
const bootstrapInspections = new WeakMap();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refuse = (diagnostic) =>
  Object.assign(Error('Qualified canonical native bootstrap unavailable'), {
    nativeDiagnostic: diagnostic,
  });
const fields = (value, names) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join() !== names.split(',').sort().join()
  )
    throw refuse('Exact source-bound bootstrap fields required.');
};
function privateBytes(path, max = 512 * 1024) {
  const parent = lstatSync(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.uid !== process.getuid() ||
    (parent.mode & 0o777) !== 0o700 ||
    realpathSync(dirname(path)) !== dirname(path)
  )
    throw refuse('Private bootstrap directory changed.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid() ||
      (s.mode & 0o777) !== 0o600 ||
      s.nlink !== 1 ||
      s.size > max ||
      realpathSync(path) !== path
    )
      throw refuse('Private bootstrap bytes changed.');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Preflight only. A module's accepted reviewed implementation and prepared
 * inventory must exist before ordinary drain/installation; JSON cannot enable
 * the still unsupported native feature factory or model-call gate. */
export function assertNativeReplicaSourceProtocol(main) {
  if (
    main?.STAGING_NATIVE_FEATURE_BOOTSTRAP_PROTOCOL_VERSION !== 1 ||
    main?.STAGING_NATIVE_MODEL_ENFORCEMENT_PROTOCOL_VERSION !== 1 ||
    main?.CUSTODIAN_NATIVE_OWNER_LIFETIME_PROTOCOL_VERSION !== 1 ||
    typeof main.runSymposiumCustodian !== 'function'
  )
    throw refuse(
      'Missing reviewed original native feature/enrollment/model-call implementation (protocol1). No allocation authorized.',
    );
}
/** Namespace/source admission before reading any private bootstrap bytes. */
export function assertCanonicalNativeInvocation(
  { sourceRoot, bootstrapPath, expectedBootstrap },
  actualSourceRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
) {
  const root = join(userInfo().homedir, '.local/share/mitzo-staging');
  const releases = join(root, 'releases') + '/',
    prefix = join(root, 'service/native-dispositions') + '/';
  if (
    typeof sourceRoot !== 'string' ||
    sourceRoot !== actualSourceRoot ||
    !sourceRoot.startsWith(releases) ||
    !/^[a-f0-9]{12}$/.test(sourceRoot.slice(releases.length)) ||
    typeof bootstrapPath !== 'string' ||
    !bootstrapPath.startsWith(prefix) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/bootstrap\.json$/.test(
      bootstrapPath.slice(prefix.length),
    ) ||
    !/^[a-f0-9]{64}$/.test(expectedBootstrap ?? '')
  )
    throw refuse('Exact prepared source and private canonical bootstrap namespace required.');
  return root;
}
/** Actual registered actor only; no callbacks, leases or authority are decoded
 * from bootstrap JSON. Host installation must separately use reviewed normal
 * ordinary drain and exact one-shot registration before this fresh actor runs. */
export async function inspectContainedNativeBootstrap({
  sourceRoot,
  bootstrapPath,
  expectedBootstrap,
}) {
  const root = assertCanonicalNativeInvocation({ sourceRoot, bootstrapPath, expectedBootstrap });
  if (process.platform !== 'darwin')
    throw refuse('Exact prepared canonical actor source required.');
  const saved = privateBytes(bootstrapPath),
    bundle = JSON.parse(saved.toString('utf8'));
  fields(
    bundle,
    'version,allocation,sourceCommit,disposition,provisioning,recoveryPlanPath,recoveryPlanSha256',
  );
  if (
    bundle.version !== 1 ||
    hash(saved) !== expectedBootstrap ||
    sourceRoot !== join(root, 'releases', bundle.sourceCommit.slice(0, 12)) ||
    bootstrapPath !==
      join(root, 'service/native-dispositions', bundle.allocation, 'bootstrap.json') ||
    !isAbsolute(bundle.recoveryPlanPath) ||
    !/^[a-f0-9]{64}$/.test(bundle.recoveryPlanSha256 ?? '')
  )
    throw refuse('Exact allocation/bootstrap/recovery proposal binding required.');
  const load = (name) => import(pathToFileURL(join(sourceRoot, 'dist', name + '.js')).href);
  const [native, release, service, launch, ownerRecords, identity, environment] = await Promise.all(
    [
      load('staging-contained-native-disposition'),
      load('symposium-owned-release'),
      load('symposium-staging-service'),
      load('symposium-staging-launch'),
      load('symposium-canonical-owner-record'),
      load('symposium-staging-identity'),
      load('symposium-custodian-launch'),
    ],
  );
  const vm = await import('./staging-fresh-applehv.mjs');
  const allocationPaths = identity.canonicalNativeAllocationPaths(root, bundle.allocation),
    allocation = {
      allocationUUID: bundle.allocation,
      nativeRoot: dirname(allocationPaths.planDirectory),
    };
  const plan = release.readOwnedReleasePlan(
    join(allocationPaths.planDirectory, 'owned-release.json'),
  );
  const registration = service.assertCanonicalStagingService(
    plan,
    allocationPaths.registrationPath,
    root,
  );
  const disposition = native.createContainedNativeDispositionPlan(bundle.disposition.facts),
    provisioning = vm.createFreshAppleHvProvisionPlan(bundle.provisioning.plan);
  if (
    digest(disposition) !== digest(bundle.disposition) ||
    digest(provisioning) !== digest(bundle.provisioning) ||
    disposition.facts.allocation !== bundle.allocation ||
    disposition.facts.acceptedController !== bundle.sourceCommit ||
    disposition.facts.provisioningPlanSha256 !== provisioning.sha256 ||
    provisioning.plan.sourceRoot !== sourceRoot ||
    provisioning.plan.allocationUUID !== bundle.allocation ||
    provisioning.plan.budget.additionalGrowthGiB < 64 / 1024 ||
    plan.sourceCommit !== bundle.sourceCommit ||
    plan.releaseRoot !== sourceRoot ||
    disposition.facts.registration.planDirectory !== plan.planDirectory ||
    disposition.facts.runtimeConfigurationSha256 !== plan.configSha256
  )
    throw refuse(
      'Native purpose, provisioning, release and registration must bind one fresh allocation.',
    );
  const config = JSON.parse(privateBytes(plan.configPath).toString('utf8'));
  const connection = 'mitzo-staging-' + bundle.allocation.replaceAll('-', '');
  if (
    config.podman.environment.HOME !== allocationPaths.appHome ||
    config.podman.environment.XDG_CONFIG_HOME !== join(allocationPaths.appHome, '.config') ||
    config.podman.environment.CONTAINER_CONNECTION !== connection ||
    config.podman.environment.CONTAINERS_CONF !==
      join(allocation.nativeRoot, 'settings/containers.conf') ||
    config.gateway.podmanSocket !== '/private/tmp/podman/' + connection + '-api.sock'
  )
    throw refuse(
      'Fresh exact stock native configuration required; archived/production paths excluded.',
    );
  const privateRefs = [
    ...Object.values(config.gateway.tls),
    ...Object.values(config.gateway.jwt),
    ...config.providerProfiles.map((p) => p.path),
    ...config.personal.workProfiles
      .filter((p) => p.provider === 'anthropic-vertex')
      .map((p) => p.credentialRef),
  ];
  if (
    privateRefs.some(
      (path) =>
        !path.startsWith(allocation.nativeRoot + '/settings/') || realpathSync(path) !== path,
    )
  )
    throw refuse(
      'Independently provisioned fresh staging-only private provider/TLS references required.',
    );
  release.verifyOwnedRelease(plan);
  const value = {
    ownerChat: registration.ownerChat,
    purpose: registration.purpose,
    retentionReason: registration.retentionReason,
    reviewAfter: registration.reviewAfter,
    planDirectory: plan.planDirectory,
    sourceCommit: plan.sourceCommit,
    buildSha256: plan.buildSha256,
    configSha256: plan.configSha256,
  };
  if (digest(value) !== digest(disposition.facts.registration))
    throw refuse('Exact fresh registration changed.');
  const inspected = Object.freeze({
    root,
    saved,
    bundle,
    native,
    release,
    service,
    launch,
    ownerRecords,
    identity,
    environment,
    vm,
    allocationPaths,
    allocation,
    plan,
    registration,
    disposition,
    provisioning,
    config,
    sourceRoot,
    load,
  });
  const token = Object.freeze({});
  bootstrapInspections.set(token, inspected);
  return token;
}
/** Source/configuration preflight in this separate original process. No helper
 * authentication, guard, provider host, registry mutation or VM action occurs. */
export async function preflightContainedNativeReplica(token) {
  const inspected = bootstrapInspections.get(token);
  if (!inspected)
    throw refuse('Actual source/configuration preflight required; JSON cannot supply loaders.');
  const { root, plan, service, environment, sourceRoot, load, bundle, disposition } = inspected;
  await qualifyOfflineContainmentController({ canonicalRoot: root, sourceRoot });
  if (
    digest(verifyPreparedController(root, sourceRoot, bundle.sourceCommit)) !==
    disposition.facts.controllerInventorySha256
  )
    throw refuse('Actual prepared source inventory changed.');
  const env = environment.canonicalCustodianEnvironment(
    service.readStagingOperatorEnvironment(
      plan,
      join(plan.planDirectory, 'staging-operator.json'),
      {},
    ),
  );
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  process.chdir(sourceRoot);
  const main = await load('symposium-custodian-main');
  assertNativeReplicaSourceProtocol(main);
  return main;
}
/** Sanitized review data only. This observation cannot transfer the original
 * preflight token, source loaders or any native ownership/capacity capability. */
export function containedNativePreflightSummary(token) {
  const s = bootstrapInspections.get(token);
  if (!s) throw refuse('Actual private bootstrap inspection required.');
  return Object.freeze({
    version: 1,
    allocation: s.bundle.allocation,
    sourceCommit: s.bundle.sourceCommit,
    sourceRoot: s.sourceRoot,
    bootstrapSha256: hash(s.saved),
    dispositionPlanSha256: s.disposition.sha256,
    provisioningPlanSha256: s.provisioning.sha256,
    configSha256: s.plan.configSha256,
    buildSha256: s.plan.buildSha256,
    recoveryPlanSha256: s.bundle.recoveryPlanSha256,
    nativeAuthority: false,
    installed: false,
    modelCalls: 0,
  });
}
/** Actual registered original actor; metadata preflight grants no authority. */
export async function runContainedNativeCanonicalLauncher({
  sourceRoot,
  bootstrapPath,
  expectedBootstrap,
}) {
  const inspection = await inspectContainedNativeBootstrap({
    sourceRoot,
    bootstrapPath,
    expectedBootstrap,
  });
  const inspected = bootstrapInspections.get(inspection);
  // Stock Go/native init writes inherit this original actor's private mask.
  // Every measured generated mode is still independently pinned by the VM plan.
  process.umask(0o077);
  const {
    root,
    saved,
    bundle,
    native,
    release,
    launch,
    ownerRecords,
    vm,
    allocation,
    plan,
    registration,
    disposition,
    provisioning,
  } = inspected;
  const qualified = async () => {
    await qualifyOfflineContainmentController({ canonicalRoot: root, sourceRoot });
    return verifyPreparedController(root, sourceRoot, bundle.sourceCommit);
  };
  const sourceWitness = createStagingSourceAcceptanceWitness({
    canonicalRoot: root,
    sourceRoot,
    verifyFresh: qualified,
  });
  let token,
    auth,
    authLease,
    guard,
    imageInspector,
    vmOwner,
    ownerCurrent,
    ownerIdentity,
    custodianCurrent,
    custodianIdentity,
    assertNativeDrainCurrent,
    ready = false,
    vmStarted = false,
    claimed = false,
    archiveProof,
    ledger,
    verifyArchive,
    unmutatedInspector,
    guardAcquired = false,
    nativePreparationAttempted = false;
  const assertBootstrap = () => {
    if (!privateBytes(bootstrapPath).equals(saved))
      throw refuse('Original bootstrap bytes changed.');
  };
  const sourceCurrent = async () => {
    assertBootstrap();
    if (ready) {
      original();
      release.verifyRetainedOwnedRelease(plan);
      return;
    }
    const receipt = token ? await sourceWitness.assertCurrent(token) : await qualified();
    if (digest(receipt) !== disposition.facts.controllerInventorySha256)
      throw refuse('Exact prepared controller inventory changed.');
    assertBootstrap();
    return receipt;
  };
  const observer = createContainedNativeRegisteredLauncherObserver({
    root,
    allocation: bundle.allocation,
    sourceRoot,
    sourceCommit: bundle.sourceCommit,
    node: process.execPath,
    bootstrapSha256: expectedBootstrap,
  });
  const handoff = createNativeOriginalOwnerHandoff({
    assertRegisteredOriginal: () => {
      assertBootstrap();
      observer.observe();
    },
    assertInitialGuard: () => guard.assertCurrent(),
    assertInitialAuthentication() {
      if (!authLease) throw refuse('Consumed original native purpose authorization required.');
      authLease.assertCurrent(disposition.sha256);
    },
  });
  const original = handoff.assertCurrent;
  try {
    await sourceCurrent();
    const main = await preflightContainedNativeReplica(inspection);
    const helper = await enrollPreparedOfflineOperatorHelper(sourceRoot, sourceCurrent);
    auth = createStagingOfflineOperatorAuthorizer({
      ...helper,
      purpose: 'contained_native_allocation',
    });
    const archive = createCompletedOfflineContainmentInspector({
      recoveryPlanPath: bundle.recoveryPlanPath,
      expectedRecoveryPlan: bundle.recoveryPlanSha256,
      verifyExecutingController: sourceCurrent,
      async verifyReplacementBoundary() {
        observer.observe();
        if (vmStarted) await vmOwner.verifyRunning();
        else {
          const job = spawnSync(
            '/bin/launchctl',
            ['print', `gui/${process.getuid()}/com.mitzo.staging.vm`],
            { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 },
          );
          if (
            job.error ||
            job.signal ||
            job.status === 0 ||
            !/Could not find service/.test(job.stderr)
          )
            throw refuse('Old or unknown VM registration remains.');
        }
        if (ownerCurrent) ownerCurrent();
      },
    });
    verifyArchive = async () => {
      archiveProof = await archive.verify();
      const f = disposition.facts;
      if (
        digest(archiveProof) !== f.physicalEvidenceSha256 ||
        archiveProof.containmentReceiptSha256 !== f.containmentReceiptSha256 ||
        archiveProof.ordinaryCompletionSha256 !== f.recoveryCompletionSha256 ||
        archiveProof.registryBackupSha256 !== f.registryBackupSha256 ||
        archiveProof.archiveManifestSha256 !== f.archiveManifestSha256 ||
        archiveProof.originalRowSha256 !== disposition.originalRowSha256
      )
        throw refuse('Completed archive differs from reviewed new allocation.');
    };
    ledger = createContainedNativeDispositionLedger({
      root,
      assertOriginalGuard: () => guard.assertCurrent(),
      assertNativeAuthorityCurrent: () => authLease.assertCurrent(disposition.sha256),
    });
    const dispositionOwner = native.createContainedNativeDispositionOwner({
      assertAcceptedSource: sourceCurrent,
      async acquireGuard() {
        unmutatedInspector = createUnmutatedNativeAllocationInspector({
          allocation: bundle.allocation,
          canonicalRoot: root,
          nativeRoot: allocation.nativeRoot,
        });
        guard = createContainedNativeGuard({
          root,
          allocation: bundle.allocation,
          planSha256: disposition.sha256,
          sourceCommit: bundle.sourceCommit,
          sourceRoot,
          verifyRegisteredLauncher: observer.observe,
        });
        const acquired = guard.acquire();
        guardAcquired = true;
        unmutatedInspector.assertUnchanged();
        return acquired;
      },
      assertNoPriorDisposition: async (p) => ledger.assertAbsent(p),
      verifyCompletedContainment: verifyArchive,
      async authenticateNativeAllocation() {
        token = await sourceWitness.admit(bundle.sourceCommit);
        return auth.authenticate(disposition.sha256);
      },
      consumeOperatorAuthority(authority) {
        authLease = auth.consume(authority, disposition.sha256);
        return {
          assertCurrent: () => authLease.assertCurrent(disposition.sha256),
          close: () => authLease.close(),
        };
      },
      async prepareFreshAllocation(_p, { assertCurrent }) {
        // Consumed before the first await or native preparation dispatch. Even an
        // early unknown preparation failure retains the original guard.
        nativePreparationAttempted = true;
        imageInspector = createFreshStagingImageInspector({
          canonicalRoot: root,
          image: provisioning.plan.sourceImage,
          nodePin: provisioning.plan.node,
          assertOriginalGuard: () => guard.assertCurrent(),
          assertNativeAuthenticationCurrent: assertCurrent,
        });
        const approvedVmPlan = await vm.provisionFreshAppleHvAllocation({
          allocation,
          canonicalRoot: root,
          sourceRoot,
          approvedProvisioningPlan: provisioning,
          assertGuardCurrent: () => guard.assertCurrent(),
          assertAcceptedSource: sourceCurrent,
          assertNativeAuthenticationCurrent: assertCurrent,
          assertApprovedImage: imageInspector.assertApprovedImage,
        });
        vmOwner = vm.createFreshAppleHvOwner({
          allocation,
          canonicalRoot: root,
          sourceRoot,
          approvedVmPlan,
          assertGuardCurrent: original,
          assertAcceptedSource: sourceCurrent,
          assertNativeDrainCurrent() {
            if (!assertNativeDrainCurrent)
              throw refuse('Actual original native host drain has not completed.');
            assertNativeDrainCurrent();
          },
        });
        // The measured new plan remains in this original closure. No reopened plan,
        // parent JSON grant or old registration can supply the VM owner.
      },
      appendDisposition: async (p) => ledger.append(p),
    });
    const recordOwner = ownerRecords.createCanonicalOwnerRecorder(plan);
    const observeOriginalController = (identity, current) => {
      current();
      observer.observe();
      if (ownerIdentity && identity.epoch === ownerIdentity.epoch) {
        if (digest(identity) !== digest(ownerIdentity))
          throw refuse('Original controller identity changed within an epoch.');
      } else {
        recordOwner(identity, current);
        ownerIdentity = identity;
      }
      ownerCurrent = current;
      current();
    };
    await launch.launchStagingCustodian(plan, registration, {
      verify: release.verifyOwnedRelease,
      claim(p) {
        release.claimOwnedLaunch(p);
        claimed = true;
      },
      authorizeContainedNativeAllocation: async () => dispositionOwner.authorize(disposition),
      async beforeContainedNativeRun() {
        if (!claimed || !vmOwner) throw refuse('Original allocation claim required.');
        await vmOwner.verifyStopped();
        handoff.assertFreshStartCurrent();
        await vmOwner.startOnce();
        vmStarted = true;
        await vmOwner.verifyRunning();
      },
      observeContainedNativeController(identity, current) {
        observeOriginalController(identity, current);
      },
      observeContainedNativeCustodianLifetime(identity, current) {
        current();
        observer.observe();
        if (custodianCurrent || identity.custodianPid !== process.pid)
          throw refuse('One actual original native custodian lifetime required.');
        custodianCurrent = current;
        custodianIdentity = identity;
        current();
      },
      stagingFeatureBootstrap: {
        sourceCommit: bundle.sourceCommit,
        sourceRoot,
        fixtureRoot: plan.repositoryPath,
        assertOriginalOwnerCurrent() {
          original();
          if (ready) ownerCurrent();
        },
        observeResources: () => {
          original();
          return vmOwner.assertRunningCurrent();
        },
      },
      async beforeContainedNativeReady(identity, current) {
        current();
        observeOriginalController(identity, current);
        original();
        if (ready) {
          vmOwner.assertRunningCurrent();
          return;
        }
        await sourceCurrent();
        await vmOwner.verifyRunning();
        await verifyArchive();
        current();
        original();
        await guard.completeNative(
          async () => {
            current();
            const resource = vmOwner.assertRunningCurrent(),
              parent = ownerRecords.observeCanonicalProcess(process.pid),
              app = ownerRecords.observeCanonicalProcess(identity.controllerPid);
            if (
              app.parentPid !== process.pid ||
              app.cwd !== sourceRoot ||
              parent.cwd !== sourceRoot
            )
              throw refuse('Original fresh native app identity changed.');
            return {
              allocation: bundle.allocation,
              sourceCommit: bundle.sourceCommit,
              parentPid: process.pid,
              parentBirth: parent.birth,
              appPid: app.pid,
              appBirth: app.birth,
              instanceId: identity.instanceId,
              epoch: identity.epoch,
              vmObservationSha256: resource.observationSha256,
              archiveProofSha256: digest(archiveProof),
            };
          },
          () => {
            current();
            if (!custodianCurrent || custodianIdentity.instanceId !== identity.instanceId)
              throw refuse('Independent original native custodian lifetime required.');
            custodianCurrent();
            handoff.handoff(() => custodianCurrent());
            vmOwner.assertRunningCurrent();
          },
        );
        // Original custodian fence was synchronously installed before guard release.
        ready = true;
        current();
        vmOwner.assertRunningCurrent();
        authLease.close();
        auth.close();
        imageInspector.close();
        sourceWitness.close();
      },
      async beforeContainedNativeRetirement(identity, current, signal) {
        if (!ready || !vmOwner || !ownerCurrent || !claimed)
          throw refuse('Qualified original native retirement lifetime required.');
        current();
        signal.throwIfAborted();
        if (
          ownerIdentity.instanceId !== identity.instanceId ||
          ownerIdentity.epoch !== identity.controllerGeneration
        )
          throw refuse('Original native retirement identity changed.');
        await handoff.retire(current, async () => {
          assertNativeDrainCurrent = current;
          try {
            await sourceCurrent();
            await vmOwner.stopOnce();
            current();
            signal.throwIfAborted();
            await vmOwner.confirmStopped();
            current();
            signal.throwIfAborted();
          } finally {
            assertNativeDrainCurrent = undefined;
          }
        });
      },
      run: (hooks) => main.runSymposiumCustodian(hooks),
    });
  } catch (error) {
    if (guardAcquired && !nativePreparationAttempted && !claimed && !vmStarted && !vmOwner) {
      try {
        await guard.refuseBeforeNativeMutation(async () => {
          guard.assertCurrent();
          if (nativePreparationAttempted || claimed || vmStarted || vmOwner || !unmutatedInspector)
            throw refuse('A native mutation may have been attempted; retain the guard.');
          unmutatedInspector.assertUnchanged();
          ledger.assertAbsent(disposition);
          await sourceCurrent();
          await verifyArchive();
          await sourceCurrent();
          ledger.assertAbsent(disposition);
          const snapshot = unmutatedInspector.assertUnchanged(),
            originalLauncher = guard.observation().launcher;
          assertBootstrap();
          return {
            allocation: bundle.allocation,
            sourceCommit: bundle.sourceCommit,
            parentPid: originalLauncher.pid,
            parentBirth: originalLauncher.birth,
            originalRowSha256: disposition.originalRowSha256,
            archiveProofSha256: digest(archiveProof),
            preallocationSnapshotSha256: snapshot.preallocationSnapshotSha256,
          };
        });
      } catch {
        // An unknown/no-longer-current source, archive, row or physical absence
        // cannot acknowledge cancellation. Preserve the exact original guard.
        guard.retain();
      }
    }
    throw error;
  } finally {
    if (!ready) {
      await vmOwner?.retain();
      guard?.retain();
    }
    if (!ready) {
      authLease?.close();
      auth?.close();
      imageInspector?.close();
      sourceWitness.close();
    }
  }
}
