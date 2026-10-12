import type { StagingNativeFeatureBootstrap } from './staging-native-feature-bootstrap.js';
import { captureOriginalStagingNativeBootstrap } from './staging-native-feature-bootstrap.js';
export { ORIGINAL_STAGING_NATIVE_BOOTSTRAP_PROTOCOL_VERSION } from './staging-native-feature-bootstrap.js';
import { createOriginalCustodianLifetime } from './symposium-original-custodian-lifetime.js';
import { createOriginalAppChildUpdateControl } from './symposium-original-app-child-update.js';
import { waitOriginalControllerExit } from './symposium-custodian-exit.js';
import type { OriginalProcessObserver } from './symposium-original-process-retention.js';
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BootstrapTools } from './symposium-owned-config.js';
import type { OwnedSymposiumHostOptions } from './symposium-owned-host.js';
import { custodianAppEnvironment } from './symposium-custodian-launch.js';
import { SymposiumCustodianController } from './symposium-custodian-controller.js';
import {
  serveCustodianController,
  CUSTODIAN_BEFORE_READY_PROTOCOL_VERSION,
  type CustodianChannel,
} from './symposium-custodian-ipc.js';
import {
  finishCustodianRetirement,
  writeCustodianRetirementReceipt,
} from './symposium-custodian-retirement.js';

export type { OriginalSymposiumControllerIdentity } from './symposium-canonical-owner-identity.js';
import type { OriginalSymposiumControllerIdentity } from './symposium-canonical-owner-identity.js';
/** Actual source-owned factory/executor/cleanup exists. Native model HTTP
 * qualification remains independently required before any feature plan/run. */
export const STAGING_NATIVE_FEATURE_BOOTSTRAP_PROTOCOL_VERSION = 1;
/** Independent original host lifetime; a child channel cannot recreate it. */
export const CUSTODIAN_NATIVE_OWNER_LIFETIME_PROTOCOL_VERSION = 1;
export const CUSTODIAN_ORIGINAL_APP_CHILD_UPDATE_PROTOCOL_VERSION = 2;
export { SYMPOSIUM_CUSTODIAN_SERVICE_PROTOCOL_VERSION } from './symposium-custodian-service.js';
/** Explicit fresh-owner entry point. No attach/reconstruct command exists. */
export interface SymposiumCustodianConstructorHooks {
  /** Passed by the same fresh canonical launcher; never environment or JSON authority. */
  stagingFeatureBootstrap?: StagingNativeFeatureBootstrap;
  observeOriginalCustodianLifetime?: (
    identity: Readonly<{ instanceId: string; custodianPid: number }>,
    assertCurrent: () => void,
  ) => void;
  /** Same original launcher only. The selection token is minted in this process
   * after physical source/queue qualification; JSON cannot request a fork. */
  observeOriginalAppChildControl?: (
    control: Pick<ReturnType<typeof createOriginalAppChildUpdateControl>, 'replace'>,
  ) => void;
  /** Original source/resource fence immediately before every actual fork. */
  beforeOriginalAppChildFork?: (
    sourceRoot: string,
    assertOriginalCustodianCurrent: () => void,
  ) => Promise<void>;
  /** Awaited original source/archive/VM fence before IPC ready or any request. */
  beforeControllerReady?: (
    identity: Readonly<OriginalSymposiumControllerIdentity>,
    assertCurrent: () => void,
    assertLoadedChildCurrent: () => void,
  ) => Promise<void>;
  /** After original host/native closure, before any retirement receipt. */
  beforeRetirementReceipt?: (
    identity: Readonly<{ instanceId: string; controllerGeneration: number }>,
    assertOriginalRetirementCurrent: () => void,
    signal: AbortSignal,
  ) => Promise<void>;
  observeRetirement?: (
    state: 'retiring' | 'retired' | 'uncertain',
    stateParent: string,
    identity?: Readonly<{ instanceId: string; controllerGeneration: number }>,
  ) => void;
  observeOriginalProcess?: OriginalProcessObserver;
  admissionBuildSelection?: OwnedSymposiumHostOptions['admissionBuildSelection'];
  bootstrapTools?: BootstrapTools;
  observeDurableReviewToolResult?: OwnedSymposiumHostOptions['observeDurableReviewToolResult'];
  observeStartupConfig?: OwnedSymposiumHostOptions['observeStartupConfig'];
  observePrelaunch?: OwnedSymposiumHostOptions['observePrelaunch'];
  observeRuntime?: OwnedSymposiumHostOptions['observeRuntime'];
  /** Fresh-owner constructor only; never read from environment or persisted config. */
  readonly observeNativeTurnInput?: OwnedSymposiumHostOptions['observeNativeTurnInput'];
  observeController?: (
    identity: Readonly<OriginalSymposiumControllerIdentity>,
    assertCurrent: () => void,
  ) => void;
}
export async function runSymposiumCustodian(hooks: SymposiumCustodianConstructorHooks = {}) {
  const {
    observeRetirement,
    beforeRetirementReceipt,
    stagingFeatureBootstrap,
    observeOriginalCustodianLifetime,
    observeOriginalAppChildControl,
    beforeOriginalAppChildFork,
    beforeControllerReady,
    bootstrapTools,
    observeOriginalProcess,
    observeDurableReviewToolResult,
    observeStartupConfig,
    observePrelaunch,
    observeRuntime,
    observeNativeTurnInput,
    observeController,
    admissionBuildSelection,
  } = hooks;
  if (
    observeOriginalAppChildControl !== undefined &&
    (typeof observeOriginalAppChildControl !== 'function' ||
      !beforeControllerReady ||
      !observeOriginalCustodianLifetime ||
      typeof beforeOriginalAppChildFork !== 'function')
  )
    throw Error('Original accepted app-child constructor fences required');
  if (
    beforeOriginalAppChildFork !== undefined &&
    (typeof beforeOriginalAppChildFork !== 'function' || !observeOriginalAppChildControl)
  )
    throw Error('Original app child pre-fork fence requires its actual retained control');
  if (
    observeOriginalCustodianLifetime !== undefined &&
    typeof observeOriginalCustodianLifetime !== 'function'
  )
    throw Error('Original custodian lifetime observer must be a trusted constructor callback');
  if (
    beforeControllerReady !== undefined &&
    (typeof beforeControllerReady !== 'function' || CUSTODIAN_BEFORE_READY_PROTOCOL_VERSION !== 1)
  )
    throw Error('Awaited original controller fence implementation unavailable');
  if (stagingFeatureBootstrap !== undefined) {
    // Recognize the fresh launcher capability rather than silently ignoring it.
    // A native allocation alone cannot grant provider enrollment, auxiliary model
    // qualification or original per-run physical cleanup. Do not build an owner
    // from public context or substitute the local feature factory here.
    if (
      typeof stagingFeatureBootstrap.assertOriginalOwnerCurrent !== 'function' ||
      typeof stagingFeatureBootstrap.observeResources !== 'function' ||
      !beforeControllerReady
    )
      throw Error('Original staging feature constructor capabilities required');
    // Admission stays closed until the awaited original launcher fence succeeds.
    captureOriginalStagingNativeBootstrap(stagingFeatureBootstrap).assertCurrent();
  }
  if (observeNativeTurnInput !== undefined && typeof observeNativeTurnInput !== 'boolean')
    throw Error('Native input diagnostic must be a trusted constructor boolean');
  if (beforeRetirementReceipt !== undefined && typeof beforeRetirementReceipt !== 'function')
    throw Error('Original retirement hook must be a trusted constructor capability');
  if (observeRetirement !== undefined && typeof observeRetirement !== 'function')
    throw Error('Retirement observer must be a trusted constructor callback');
  if (observeOriginalProcess !== undefined && typeof observeOriginalProcess !== 'function')
    throw Error('Process observer must be a trusted constructor callback');
  if (
    observeDurableReviewToolResult !== undefined &&
    typeof observeDurableReviewToolResult !== 'function'
  )
    throw Error('Custodian observer must be a trusted constructor callback');
  if (observeStartupConfig !== undefined && typeof observeStartupConfig !== 'function')
    throw Error('Startup observer must be a trusted constructor callback');
  if (observePrelaunch !== undefined && typeof observePrelaunch !== 'function')
    throw Error('Prelaunch observer must be a trusted constructor callback');
  if (observeRuntime !== undefined && typeof observeRuntime !== 'function')
    throw Error('Runtime observer must be a trusted constructor callback');
  if (observeController !== undefined && typeof observeController !== 'function')
    throw Error('Controller observer must be a trusted constructor callback');
  if (
    admissionBuildSelection !== undefined &&
    admissionBuildSelection !== 'local-854b-b20-v1' &&
    admissionBuildSelection !== 'local-854b-routing-v1' &&
    admissionBuildSelection !== 'local-854b-routing-v2'
  )
    throw Error('Owned full-build selection is not reviewed');
  if (process.env.MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER || process.send)
    throw Error('Custodian must be launched as the independent owner');
  const filename = process.env.MITZO_SYMPOSIUM_OWNED_HOST_CONFIG;
  if (!filename) throw Error('A fresh owned Symposium configuration is required');
  process.env.MITZO_SYMPOSIUM_CUSTODIAN_OWNER = '1';
  // Mode is established before constructing the actual native stores. The
  // ordinary Express backend belongs exclusively to its separate app child.
  const service = await import('./symposium-custodian-service.js');
  if (service.SYMPOSIUM_CUSTODIAN_SERVICE_PROTOCOL_VERSION !== 1)
    throw Error('Actual native custodian service implementation unavailable');
  const workspaceRoot = process.env.REPO_PATH;
  if (!workspaceRoot) throw Error('Explicit original custodian workspace required');
  const engine = service.createSymposiumCustodianService({ workspaceRoot });
  const { bootstrapConfiguredSymposiumHost } = await import('./symposium-owned-config.js');
  const { revokeAuthSession, registerAuthSession } = await import('./operator-session.js');
  const identity = randomUUID();
  const host = await bootstrapConfiguredSymposiumHost(
    filename,
    {
      ...engine.getSymposiumBootstrapDependencies(),
      observeDurableReviewToolResult,
      observeStartupConfig,
      observePrelaunch,
      ...(observeRuntime === undefined ? {} : { observeRuntime }),
      ...(observeNativeTurnInput === undefined ? {} : { observeNativeTurnInput }),
      ...(admissionBuildSelection === undefined ? {} : { admissionBuildSelection }),
      ...(stagingFeatureBootstrap
        ? { stagingInference: { bootstrap: stagingFeatureBootstrap, ownerInstance: identity } }
        : {}),
    },
    bootstrapTools,
    ...(observeOriginalProcess === undefined ? [] : ([observeOriginalProcess] as const)),
  );
  engine.installSymposiumProductionHost(host);
  let controllerGeneration = 0;
  let child: ChildProcess | undefined;
  let stopping = false;
  const originalCustodianLifetime = createOriginalCustodianLifetime({
    instanceId: identity,
    assertHostCurrent: () => {
      host.currentProfiles();
    },
  });
  const observedLifetime: unknown = observeOriginalCustodianLifetime?.(
    originalCustodianLifetime.identity,
    originalCustodianLifetime.assertCurrent,
  );
  if (observedLifetime !== undefined) {
    void Promise.resolve(observedLifetime).catch(() => {});
    throw Error('Original custodian lifetime observer must be synchronous');
  }
  originalCustodianLifetime.assertCurrent();
  const nativeSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const appChildControl = observeOriginalAppChildControl
    ? createOriginalAppChildUpdateControl({
        nativeSourceRoot,
        assertOriginalCustodianCurrent: originalCustodianLifetime.assertCurrent,
      })
    : undefined;
  if (appChildControl) {
    const result: unknown = observeOriginalAppChildControl!(
      Object.freeze({
        replace: appChildControl.replace,
      }),
    );
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      throw Error('Original app-child control observer must be synchronous');
    }
  }
  let originalFeatureControllerCurrent: (() => void) | undefined;
  if (stagingFeatureBootstrap) {
    engine.configureStagingNativeFeatureOwner(host, stagingFeatureBootstrap, identity, () => {
      if (!originalFeatureControllerCurrent || stopping)
        throw Error('Awaited original native feature readiness unavailable');
      originalFeatureControllerCurrent();
    });
  }
  const controller = new SymposiumCustodianController({
    pause() {
      engine.pauseSymposiumController();
      host.pauseController();
    },
    async drain(signal) {
      const results = await Promise.allSettled([
        engine.drainSymposiumController(`${identity}-${controllerGeneration}`, signal),
        host.quiesceController(signal),
      ]);
      signal.throwIfAborted();
      if (results.some((result) => result.status === 'rejected'))
        throw Error('Retained controller cleanup requires recovery');
    },
    resume() {
      engine.resumeSymposiumController();
      host.resumeController();
      controllerGeneration++;
    },
    invalidate(id) {
      revokeAuthSession({ id, expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 });
    },
    async dispatch(command, assertCurrent, approval, signal) {
      let invalidated = false;
      const unregister = registerAuthSession(command.authorization, () => {
        invalidated = true;
      });
      const authorize = () => {
        assertCurrent();
        if (invalidated) throw Error('Operator authorization expired or revoked');
      };
      try {
        authorize();
        if (command.operation === 'custody.status') {
          host.currentProfiles(); // Recheck the original gateway owner, never discover/adopt a PID.
          if (!child?.pid || !child.connected) throw Error('Controller child unavailable');
          return {
            status: 200,
            body: {
              instanceId: identity,
              epoch: command.epoch,
              custodianPid: process.pid,
              controllerPid: child.pid,
              state: 'active',
              scope: 'fresh-retained-sessions',
            },
          };
        }
        if (command.sessionId && !engine.hasRetainedCustodianSession(command.sessionId))
          throw Error('This session is not held by the current custodian');
        const result = await engine.dispatchCustodianRequest(command, authorize, approval, signal);
        if (command.operation === 'session.create' && result.status < 300) {
          const sessionId = (result.body as { sessionId?: unknown } | null)?.sessionId;
          if (typeof sessionId !== 'string' || !engine.hasRetainedCustodianSession(sessionId))
            throw Error('Historical session allocation cannot transfer custodian authority');
        }
        authorize();
        return result;
      } finally {
        unregister();
      }
    },
  });
  engine.setSymposiumCustodianBroadcast((sessionId, event) => {
    if (!child?.connected || stopping) return;
    const frame = { kind: 'event', sessionId, event };
    if (Buffer.byteLength(JSON.stringify(frame)) > 1_048_576) return; // Durable replay remains authoritative.
    child.send(frame, () => {});
  });
  const stop = () => {
    stopping = true;
    appChildControl?.fence(Error('Original custodian is entering native retirement'));
    originalCustodianLifetime.close();
    originalFeatureControllerCurrent = undefined;
    if (child?.connected) child.disconnect();
    child?.kill('SIGTERM');
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    while (!stopping) {
      const selectedRoot = appChildControl ? await appChildControl.nextSource() : nativeSourceRoot;
      if (appChildControl) {
        if (!beforeOriginalAppChildFork)
          throw Error('Original app child pre-fork fence unavailable');
        originalCustodianLifetime.assertCurrent();
        await beforeOriginalAppChildFork(selectedRoot, originalCustodianLifetime.assertCurrent);
        originalCustodianLifetime.assertCurrent();
      }
      const childOptions: ForkOptions = {
        env: custodianAppEnvironment(
          process.env,
          beforeControllerReady ? { awaitOriginalReadiness: true } : undefined,
        ),
        execArgv: [],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        cwd: selectedRoot,
      };
      child = appChildControl
        ? fork(resolve(selectedRoot, 'dist/index.js'), [], childOptions)
        : fork(new URL('./index.js', import.meta.url), [], childOptions);
      const exactChild = child;
      appChildControl?.created(exactChild, selectedRoot);
      const exited = new Promise<void>((resolve) => exactChild.once('exit', () => resolve()));
      try {
        const observed: unknown = observeOriginalProcess?.('controller', exactChild, () => {
          if (
            stopping ||
            child !== exactChild ||
            exactChild.exitCode !== null ||
            exactChild.signalCode !== null
          )
            throw Error('Original controller creation lost');
          host.currentProfiles();
        });
        if (observed !== undefined) {
          void Promise.resolve(observed).catch(() => {});
          throw Error('Process observer must be synchronous');
        }
        const loadedChildCurrent = (connectionCurrent: () => void) => () => {
          connectionCurrent();
          if (
            stopping ||
            child !== exactChild ||
            !exactChild.connected ||
            exactChild.exitCode !== null ||
            exactChild.signalCode !== null ||
            !Number.isSafeInteger(exactChild.pid) ||
            exactChild.pid! <= 0
          )
            throw Error('Original controller child unavailable');
          connectionCurrent();
        };
        const originalCurrent = (connectionCurrent: () => void) => () => {
          loadedChildCurrent(connectionCurrent)();
          host.currentProfiles();
          loadedChildCurrent(connectionCurrent)();
        };
        const originalIdentity = (epoch: number) =>
          Object.freeze({
            instanceId: identity,
            epoch,
            custodianPid: process.pid,
            controllerPid: exactChild.pid!,
            state: 'active' as const,
            scope: 'fresh-retained-sessions' as const,
          });
        await serveCustodianController(exactChild as unknown as CustodianChannel, controller, {
          beforeReady:
            beforeControllerReady &&
            (async (epoch, connectionCurrent) => {
              const current = originalCurrent(connectionCurrent);
              current();
              await beforeControllerReady(
                originalIdentity(epoch),
                current,
                loadedChildCurrent(connectionCurrent),
              );
              current();
              originalFeatureControllerCurrent = current;
              appChildControl?.ready(originalIdentity(epoch), current);
            }),
          observeReady:
            observeController &&
            ((epoch, connectionCurrent) => {
              const current = originalCurrent(connectionCurrent);
              current();
              const result: unknown = observeController(originalIdentity(epoch), current);
              if (result !== undefined) {
                // Refuse asynchronous observation without leaving its rejection unhandled.
                void Promise.resolve(result).catch(() => {});
                throw Error('Controller observer must be synchronous');
              }
              current();
            }),
        });
      } catch {
        stopping = true;
        appChildControl?.fence(Error('Actual original controller drain or readiness uncertain'));
        throw Error('Controller lost; retained resources remain quarantined');
      } finally {
        await waitOriginalControllerExit(
          exactChild,
          exited,
          process.env.MITZO_SYMPOSIUM_CANONICAL_STAGE === '1',
        );
        if (!stopping) appChildControl?.exited(exactChild);
        // A canonical timeout throws before this assignment and native cleanup:
        // retain the original child/host and record retirement uncertainty.
        child = undefined;
      }
      // Never auto-retry an app startup failure in a tight loop.
      if (!stopping) await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
    const signal = AbortSignal.timeout(120_000);
    await finishCustodianRetirement(
      {
        begin() {
          engine.beginSymposiumShutdown();
          host.beginShutdown();
        },
        retireRuntimes: (signal) =>
          engine.retireRetainedSymposiumRuntimes(
            `${identity}-${controllerGeneration}-retirement`,
            signal,
          ),
        drainHost: (signal) => host.drain(signal),
        closeHost: async (signal) => {
          originalCustodianLifetime.close();
          await host.closeAfterDrain(signal);
          signal.throwIfAborted();
          const originalPid = process.pid;
          let current = true;
          const assertOriginalRetirementCurrent = () => {
            signal.throwIfAborted();
            if (!current || process.pid !== originalPid)
              throw Error('Original post-host retirement lifetime expired');
          };
          try {
            await beforeRetirementReceipt?.(
              Object.freeze({ instanceId: identity, controllerGeneration }),
              assertOriginalRetirementCurrent,
              signal,
            );
            assertOriginalRetirementCurrent();
          } finally {
            current = false;
          }
        },
        record: () =>
          writeCustodianRetirementReceipt({
            stateParent: dirname(host.gateway.stateDirectory),
            gatewayStateDirectory: host.gateway.stateDirectory,
            instanceId: identity,
            controllerGeneration,
          }),
      },
      signal,
      observeRetirement &&
        ((state) =>
          observeRetirement(
            state,
            dirname(host.gateway.stateDirectory),
            Object.freeze({ instanceId: identity, controllerGeneration }),
          )),
    );
  } catch {
    originalCustodianLifetime.close();
    try {
      observeRetirement?.(
        'uncertain',
        dirname(host.gateway.stateDirectory),
        Object.freeze({ instanceId: identity, controllerGeneration }),
      );
    } catch {
      /* Keep original resources quarantined. */
    }
    try {
      host.markShutdownUncertain();
    } catch {
      // A terminal-receipt write can fail after custody stores have closed.
      // Failure remains visible without resurrecting any original capability.
    }
    // Keep original owners/ledgers alive for diagnosis. Never reconstruct their
    // capabilities in a replacement process or claim successful cleanup.
    process.stderr.write(
      'Symposium custodian fenced: cleanup is unconfirmed; resources remain quarantined.\n',
    );
    process.exitCode = 1;
  }
}
/** Importing this module cannot bootstrap a host or load app authentication. */
export function isDirectSymposiumCustodianEntry(argvPath: string | undefined): boolean {
  return !!argvPath && resolve(argvPath) === fileURLToPath(import.meta.url);
}
if (isDirectSymposiumCustodianEntry(process.argv[1]))
  void import('dotenv/config')
    .then(() => runSymposiumCustodian())
    .catch(() => {
      process.stderr.write(
        'Symposium custodian startup failed; no existing resources were adopted.\n',
      );
      process.exitCode = 1;
    });
