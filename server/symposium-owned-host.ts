import type { PublicationCredentialRegistration } from './symposium-publication-registration.js';
import { REVIEWED_SYMPOSIUM_OWNED_RUNTIME } from './symposium-owned-runtime-contract.js';
import { artifactGitContract, createArtifactGitVolume } from './symposium-artifact-initializer.js';
import { symposiumArtifactOwner } from './symposium-artifact-owner.js';
import {
  PhysicalArtifactSealer,
  type PhysicalArtifactSealInput,
} from './symposium-physical-artifact-seal.js';
import { stableSymposiumArtifactLeasePath } from './symposium-artifact-state.js';
import { isPodmanSandboxNamespace } from './symposium-podman-namespace.js';
import {
  collectPersonalAdmissionEvidence,
  PersonalEvidenceSelection,
} from './symposium-personal-evidence.js';
import { createOwnedEvidenceCollector } from './symposium-owned-evidence-async.js';
import { fenceDiscoveryCreation } from './symposium-discovery-creation.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  runSymposiumModelDiscovery,
  createSymposiumModelDiscoveryRecovery,
  type DiscoveryReceipt,
} from './symposium-model-discovery.js';
import { guardDiscoveryOperations } from './symposium-discovery-custody.js';
import { createDiscoveryHostOperations } from './symposium-model-discovery-host.js';
import type { CatalogModel } from './model-catalog.js';
import { SymposiumWorkspaceLifecycle } from './symposium-workspace-lifecycle.js';
import { createPersonalSubscriptionHost } from './symposium-personal-host.js';
import type { ConnectionSelection } from './symposium-personal-connections.js';
import { SymposiumConfigSchema } from '@mitzo/protocol';
import {
  SymposiumSessionArtifacts,
  assertSessionArtifactVolume,
  type SessionArtifactPreparation,
} from './symposium-session-artifacts.js';
import { DeviceLoginCleanupError } from './symposium-device-login.js';
import { execFile } from 'node:child_process';
import { chmodSync, lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { EventStore } from '@mitzo/protocol/event-store';
import {
  OwnedSymposiumGateway,
  type OwnedSymposiumGatewayOptions,
} from './symposium-owned-gateway.js';
import { initializeSymposiumNativeHost } from './symposium-native-host.js';
import {
  SqliteArtifactLeaseHost,
  ArtifactPodmanContext,
  ArtifactCommandNotDispatched,
} from './symposium-artifact-host.js';
import { LocalPodmanArtifactEvidence } from './symposium-podman-evidence.js';
import { LocalSymposiumProductionPhysicalProof } from './symposium-production-physical.js';
import { type SymposiumSubscriptionHostOptions } from './symposium-subscription-host.js';
import { createSymposiumSubscriptionSeatProof } from './symposium-subscription-seat-proof.js';
import type {
  SymposiumDispatchFacts,
  SymposiumHostGrantVerifier,
} from './symposium-seat-runtime.js';
import type { ArtifactLeaseRequest } from './symposium-artifact-lease.js';
import type { OpenShellRuntimeConfig } from './openshell-runtime.js';

const id = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** Internal receipt of successful cleanup, never inferred from an error string. */
class LoginCancelledForShutdown extends Error {
  constructor() {
    super('Owned Symposium host stopped');
  }
}

export interface OwnedSymposiumHostOptions {
  publicationCredentials?: readonly PublicationCredentialRegistration[];
  gateway: OwnedSymposiumGatewayOptions;
  /** Absolute evidence destination. It may be absent until real provisioning
   * completes; bootstrap never fabricates an attestation or opens runtime admission. */
  attestationPath: string;
  runtime: Pick<OpenShellRuntimeConfig, 'policy' | 'seed' | 'createDetached' | 'sandboxIdLength'>;
  podman: { executable: string; environment: NodeJS.ProcessEnv; sandboxNamespace: string };
  personal: Omit<SymposiumSubscriptionHostOptions, 'gateway' | 'seatProof'>;
  facts: SymposiumDispatchFacts & Pick<EventStore, 'getSymposiumSeatSandbox' | 'getSession'>;
  hostGrants: SymposiumHostGrantVerifier;
  artifacts: readonly { sessionId: string; volumeName: string; volumeGeneration: string }[];
}

/** Explicit bootstrap only: importing this module launches nothing. A new
 * dedicated gateway owns fresh private registries and management credentials.
 * Pending evidence permits catalog/login setup, but the separate application
 * gate remains closed until a real reviewed attestation has been written.
 * Stopping retains unresolved remote claims for reconciliation; it never emits
 * fabricated controller cleanup proofs or deletes unrelated driver resources. */
export async function createOwnedSymposiumHost(
  options: OwnedSymposiumHostOptions,
  launch: typeof OwnedSymposiumGateway.launch = OwnedSymposiumGateway.launch,
  prepareGateway?: (gateway: OwnedSymposiumGateway) => Promise<readonly unknown[]>,
  podmanCommand?: (args: readonly string[], execution: { timeout: number }) => Promise<string>,
) {
  if (
    !isAbsolute(options.attestationPath) ||
    !isAbsolute(options.podman.executable) ||
    !isPodmanSandboxNamespace(options.podman.sandboxNamespace) ||
    !isAbsolute(options.runtime.policy) ||
    !isAbsolute(options.runtime.seed)
  )
    throw new Error('Owned Symposium host requires explicit private paths and namespace');
  const artifactOwner = symposiumArtifactOwner(options.gateway.workloadImage);
  try {
    const evidence = lstatSync(options.attestationPath);
    if (!evidence.isFile() || evidence.isSymbolicLink() || evidence.mode & 0o077)
      throw new Error('Owned Symposium attestation must be a private regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const policyStat = lstatSync(options.runtime.policy);
  if (
    !policyStat.isFile() ||
    policyStat.isSymbolicLink() ||
    policyStat.uid !== process.getuid?.() ||
    policyStat.mode & 0o022
  )
    throw new Error('Owned discovery policy must remain under host custody');
  const policyDigest = createHash('sha256')
    .update(readFileSync(options.runtime.policy))
    .digest('hex');
  const artifacts = new Map<
    string,
    { sessionId: string; volumeName: string; volumeGeneration: string }
  >();
  for (const mapping of options.artifacts) {
    if (
      !Object.values(mapping).every((value) => typeof value === 'string' && id.test(value)) ||
      artifacts.has(mapping.sessionId)
    )
      throw new Error('Artifact session mapping is invalid or duplicated');
    artifacts.set(mapping.sessionId, { ...mapping });
  }
  if (
    !Number.isInteger(options.runtime.sandboxIdLength) ||
    options.runtime.sandboxIdLength < 8 ||
    options.runtime.sandboxIdLength > 13
  )
    throw new Error('Invalid dedicated sandbox name length');
  const leasePath = stableSymposiumArtifactLeasePath(options.gateway.stateParent);
  const gateway = await launch(options.gateway);
  let native: ReturnType<typeof initializeSymposiumNativeHost> | undefined;
  let leaseHost: SqliteArtifactLeaseHost | undefined;
  let artifactSealer: PhysicalArtifactSealer | undefined;
  let subscription: ReturnType<typeof createPersonalSubscriptionHost> | undefined;
  let sessionArtifacts: SymposiumSessionArtifacts | undefined;
  let stopped = false;
  let draining = false;
  const pendingHostOperations = new Set<Promise<unknown>>();
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopped) return Promise.reject(new Error('Owned Symposium host stopped'));
    if (draining) return Promise.reject(new Error('Owned Symposium host is shutting down'));
    const promise = operation();
    pendingHostOperations.add(promise);
    void promise.finally(() => pendingHostOperations.delete(promise)).catch(() => {});
    return promise;
  };
  let loginStarting = false;
  let loginQuarantined = false;
  let login:
    | Awaited<
        ReturnType<
          ReturnType<typeof createPersonalSubscriptionHost>['beginLogin' | 'beginDeviceLogin']
        >
      >
    | undefined;
  const custody = () => {
    if (stopped) throw new Error('Owned Symposium host stopped');
    gateway.verifyCustody();
  };
  try {
    custody();
    const preparedWork = prepareGateway
      ? await prepareGateway(gateway)
      : options.personal.workProfiles;
    custody();
    const runtimeConfig: OpenShellRuntimeConfig = {
      cli: gateway.cli,
      gateway: gateway.gateway,
      workspace: gateway.workspace,
      cliEnvironment: gateway.managementEnvironment,
      gatewayInsecure: false,
      image: options.gateway.workloadImage,
      policy: options.runtime.policy,
      seed: options.runtime.seed,
      createDetached: options.runtime.createDetached,
      sandboxIdLength: options.runtime.sandboxIdLength,
      workdir: REVIEWED_SYMPOSIUM_OWNED_RUNTIME.workload.workdir,
      serviceProviders: [],
      grantableServiceProviders: [],
      webSearch: 'disabled',
    };
    native = initializeSymposiumNativeHost(join(gateway.stateDirectory, 'native-attempts'));
    const podmanEnv = { ...options.podman.environment };
    const podmanText = async (
      args: readonly string[],
      maxOutputBytes = 2 * 1024 * 1024,
      deferPostCustody = false,
    ): Promise<string> => {
      if (
        !Number.isSafeInteger(maxOutputBytes) ||
        maxOutputBytes < 1 ||
        maxOutputBytes > 12 * 1024 * 1024
      )
        throw new Error('Owned Podman output bound is invalid');
      try {
        custody();
      } catch (error) {
        throw new ArtifactCommandNotDispatched(error);
      }
      const timeout = args[0] === 'start' && args[1] === '--attach' ? 60_000 : 15_000;
      const text = podmanCommand
        ? await podmanCommand(args, { timeout })
        : await new Promise<string>((resolve, reject) => {
            execFile(
              options.podman.executable,
              [...args],
              {
                env: podmanEnv,
                encoding: 'utf8',
                // Attached verifier/export helpers own bounded child work (including
                // a 20-second bundle phase); the transport must outlive that bound.
                timeout,
                maxBuffer: maxOutputBytes,
              },
              (error, stdout) => {
                if (error) reject(new Error('Owned Podman operation failed'));
                else resolve(stdout);
              },
            );
          });
      if (!deferPostCustody) custody();
      return text;
    };
    const podman = async (args: readonly string[]): Promise<unknown> =>
      JSON.parse(await podmanText(args));
    const artifactEvidence = new LocalPodmanArtifactEvidence(
      gateway.workspace,
      options.podman.sandboxNamespace,
      podman,
      gateway,
      options.gateway.workloadImage,
    );
    leaseHost = new SqliteArtifactLeaseHost(
      leasePath,
      artifactEvidence,
      new ArtifactPodmanContext(podmanText, (args, maxOutputBytes) =>
        podmanText(args, maxOutputBytes, true),
      ),
      gateway,
    );
    chmodSync(leasePath, 0o600);
    // Session identities survive fresh gateway launches. Retain their reservations
    // in the stable private parent, while recording launch custody in every row.
    const parent = lstatSync(options.gateway.stateParent);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077)
      throw new Error('Session artifact state parent must be a private directory');
    const sessionArtifactsPath = join(options.gateway.stateParent, 'session-artifacts.db');
    try {
      const ledger = lstatSync(sessionArtifactsPath);
      if (!ledger.isFile() || ledger.isSymbolicLink() || ledger.mode & 0o077)
        throw new Error('Session artifact ledger must be a private regular file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    sessionArtifacts = new SymposiumSessionArtifacts(
      sessionArtifactsPath,
      gateway.workspace,
      gateway.stateDirectory,
      custody,
      {
        get initializationContract() {
          return artifactGitContract(artifactOwner);
        },
        initializerRequired: true,
        async inspect(name) {
          const listed = await podman([
            'volume',
            'ls',
            '--filter',
            `name=^${name}$`,
            '--format',
            'json',
          ]);
          if (
            !Array.isArray(listed) ||
            listed.length > 1 ||
            listed.some((row) => !row || typeof row !== 'object' || row.Name !== name)
          )
            throw new Error('Ambiguous artifact volume inventory');
          return listed.length ? leaseHost!.inspectVolume(name, 'podman') : null;
        },
        async create(name, labels, receipt) {
          // The initializer journals terminal create/removal before its own
          // post-command custody check. The generic transport postcheck would
          // otherwise discard an exact helper identity after a successful create.
          await createArtifactGitVolume(
            name,
            labels,
            artifactOwner,
            (args) => podmanText(args, undefined, true),
            custody,
            receipt,
          );
        },
      },
    );
    chmodSync(sessionArtifactsPath, 0o600);
    const prepareSessionArtifacts = async (
      sessionId: string,
    ): Promise<SessionArtifactPreparation> => {
      custody();
      // A durable draft must already exist; this does not activate it or grant a seat.
      const session = options.facts.getSession(sessionId);
      const config = session?.symposiumConfig
        ? SymposiumConfigSchema.parse(JSON.parse(session.symposiumConfig))
        : null;
      if (session?.sessionType !== 'symposium' || config?.version !== 2)
        throw new Error('A Symposium session is required');
      if (artifacts.has(sessionId)) return { state: 'recovery_required' };
      return sessionArtifacts!.ensure(sessionId);
    };
    const ensureSessionArtifacts = (sessionId: string) =>
      track(() => prepareSessionArtifacts(sessionId));
    const physical = new LocalSymposiumProductionPhysicalProof({
      cli: gateway.cli,
      podman: options.podman.executable,
      cliEnv: gateway.managementEnvironment,
      podmanEnv,
      ownedGateway: gateway,
    });
    const currentProfiles = () => {
      custody();
      if (!subscription) throw new Error('Subscription host is not initialized');
      return subscription.currentProfiles;
    };
    const seatProof = createSymposiumSubscriptionSeatProof({
      facts: options.facts,
      currentProfiles,
      hostGrants: options.hostGrants,
      registry: options.facts,
      runtimeConfig: { ...runtimeConfig, cliContract: 'v0.1' },
      verifyGatewayCustody: custody,
    });
    const workspaceLifecycle = new SymposiumWorkspaceLifecycle(
      join(options.gateway.stateParent, 'sandbox-creation-fence.json'),
      custody,
    );
    subscription = createPersonalSubscriptionHost(
      {
        ...options.personal,
        workProfiles: preparedWork,
        gateway,
        seatProof,
        runCredentialCleanup: (operation) => workspaceLifecycle.cleanup(operation),
      },
      join(options.gateway.stateParent, 'personal-connections.json'),
      async (proof) => {
        custody();
        proof.assertCurrent();
        const gatewayConfigPath = join(gateway.stateDirectory, 'gateway.toml');
        const gatewayConfigDigest = createHash('sha256')
          .update(readFileSync(gatewayConfigPath))
          .digest('hex');
        const config = {
          cliSha256: options.gateway.cliSha256,
          workloadImage: options.gateway.workloadImage,
          policySha256: policyDigest,
          podmanUrl: `unix://${options.gateway.podmanSocket}`,
          gateway: gateway.gateway,
          workspace: gateway.workspace,
          provider: proof.provider,
        };
        const operations = createDiscoveryHostOperations(config, {
          cli: gateway.cli,
          podman: options.podman.executable,
          policy: options.runtime.policy,
          journal: join(gateway.stateDirectory, 'model-discovery.json'),
          namespace: options.podman.sandboxNamespace,
          environment: { ...gateway.managementEnvironment },
          configPins: [{ path: gatewayConfigPath, sha256: gatewayConfigDigest, mode: 0o400 }],
          attestGateway: async () => {
            custody();
          },
        });
        const guarded = guardDiscoveryOperations(operations, () => {
          custody();
          proof.assertCurrent();
        });
        const fenced = fenceDiscoveryCreation(
          guarded,
          gateway.workspace,
          workspaceLifecycle.create,
          () => {
            custody();
            proof.assertCurrent();
          },
        );
        let models: CatalogModel[] | undefined;
        const result = await runSymposiumModelDiscovery(config, fenced.operations, (catalog) => {
          custody();
          proof.assertCurrent();
          models = catalog;
        });
        custody();
        proof.assertCurrent();
        if (fenced.creationUncertain())
          return { result: { ...result, status: 'reconciliation_required', inference: false } };
        let recover;
        if (result.status === 'reconciliation_required') {
          const receipt = structuredClone(await operations.readReceipt()) as DiscoveryReceipt;
          if (receipt?.id) {
            const recoverExact = createSymposiumModelDiscoveryRecovery(config, receipt);
            recover = (check: () => void) =>
              workspaceLifecycle.cleanup(async () => {
                const cleanup = guardDiscoveryOperations(operations, () => {
                  custody();
                  check();
                });
                return recoverExact(cleanup);
              });
          }
        }
        return { result, models, recover };
      },
    );
    const artifactRequest = (
      sessionId: string,
      seatId: string,
      generation: number,
      purpose: 'admission' | 'cleanup' = 'admission',
    ): ArtifactLeaseRequest => {
      if (draining && purpose === 'admission')
        throw new Error('Owned Symposium host is shutting down');
      custody();
      const mapped =
        purpose === 'cleanup'
          ? (artifacts.get(sessionId) ?? sessionArtifacts!.getRetained(sessionId))
          : artifacts.has(sessionId)
            ? null
            : sessionArtifacts!.getReady(sessionId);
      if (purpose === 'cleanup') {
        const record = options.facts.getSymposiumSeatSandbox(sessionId, seatId, generation);
        if (
          !mapped ||
          !record ||
          record.sessionId !== sessionId ||
          record.seatId !== seatId ||
          record.generation !== generation ||
          record.workspace !== gateway.workspace
        )
          throw new Error('Artifact cleanup has no retained sandbox mapping');
        const retained = leaseHost!.retainedCleanupRequest(record);
        if (retained) {
          if (
            retained.sessionId !== sessionId ||
            retained.seatId !== seatId ||
            retained.workspaceId !== record.workspace ||
            retained.driver !== 'podman' ||
            retained.volumeName !== mapped.volumeName ||
            retained.volumeGeneration !== mapped.volumeGeneration
          )
            throw new Error('Retained artifact cleanup mapping changed');
          return retained;
        }
        // No lease and no dispatched create: the owner still proves gateway absence
        // twice before retiring the reservation. This descriptor cannot admit a seat.
        return {
          ...mapped,
          seatId,
          workspaceId: record.workspace,
          driver: 'podman',
          access: 'reviewer',
        };
      }
      const config = options.facts.getActiveSymposiumConfig(sessionId);
      const seat = config.seats.find((row) => row.id === seatId);
      const membership = options.facts.getLatestSymposiumMembership(sessionId, seatId);
      if (
        !mapped ||
        config.version !== 2 ||
        config.state !== 'active' ||
        !seat ||
        membership?.state !== 'active' ||
        membership.generation !== generation
      )
        throw new Error('Artifact request has no current host session mapping');
      options.hostGrants.verifySeat({ sessionId, seat, membershipGeneration: generation });
      if (
        !seat.authorityGrant ||
        seat.authorityGrant.filesystem === 'none' ||
        seat.authorityGrant.tools === 'none'
      )
        throw new Error('Artifact authority cannot be enforced');
      return {
        ...mapped,
        seatId,
        workspaceId: gateway.workspace,
        driver: 'podman',
        access:
          seat.role === 'reviewer' ||
          seat.authorityGrant.filesystem !== 'write' ||
          seat.authorityGrant.tools !== 'write'
            ? 'reviewer'
            : 'writer',
      };
    };
    const allocateLogin = async (device: boolean, selection?: ConnectionSelection) => {
      custody();
      if (loginQuarantined || login || loginStarting)
        throw new Error('Subscription login is already pending');
      loginStarting = true;
      let pending: Awaited<
        ReturnType<NonNullable<typeof subscription>['beginLogin' | 'beginDeviceLogin']>
      >;
      try {
        pending = await (device
          ? subscription!.beginDeviceLogin(selection)
          : subscription!.beginLogin(selection));
      } catch (error) {
        if (error instanceof DeviceLoginCleanupError) loginQuarantined = true;
        throw error;
      } finally {
        loginStarting = false;
      }
      if (stopped || draining) {
        void pending.completed.catch(() => undefined);
        await pending.cancel();
        throw new LoginCancelledForShutdown();
      }
      login = pending;
      void pending.completed.then(
        () => {
          if (login === pending) login = undefined;
        },
        (error) => {
          if (error instanceof DeviceLoginCleanupError) loginQuarantined = true;
          if (login === pending) login = undefined;
        },
      );
      return pending;
    };
    const startLogin = (device: boolean, selection?: ConnectionSelection) =>
      track(() => allocateLogin(device, selection));
    const collectExplicitEvidence = createOwnedEvidenceCollector(
      runtimeConfig,
      gateway.endpoint,
      {
        cli: gateway.cli,
        podman: options.podman.executable,
        cliEnv: gateway.managementEnvironment,
        podmanEnv,
      },
      {
        verifyCustodyAsync: async () => {
          if (stopped) throw new Error('Owned Symposium host stopped');
          await gateway.verifyCustodyAsync();
        },
        verifyOwnedNativeHostAsync: async (binding) => {
          if (stopped) throw new Error('Owned Symposium host stopped');
          await gateway.verifyOwnedNativeHostAsync(binding);
        },
        verifyGatewayDriverConfigAsync: async (...args) => {
          if (stopped) throw new Error('Owned Symposium host stopped');
          await gateway.verifyGatewayDriverConfigAsync(...args);
        },
      },
    );
    return {
      gateway,
      runtimeConfig,
      attestationPath: options.attestationPath,
      collectAdmissionEvidence: (selection: unknown) =>
        track(() => {
          const personal = PersonalEvidenceSelection.safeParse(selection);
          if (!personal.success) return collectExplicitEvidence(selection);
          return collectPersonalAdmissionEvidence(personal.data, {
            capture: (selected) => {
              if (stopped || !subscription) throw new Error('Owned personal host unavailable');
              return subscription.captureAdmissionProvider(selected);
            },
            getReady: async (sessionId) => {
              const assertDraft = () => {
                const session = options.facts.getSession?.(sessionId);
                const config = session?.symposiumConfig
                  ? SymposiumConfigSchema.safeParse(JSON.parse(session.symposiumConfig))
                  : null;
                if (
                  session?.sessionType !== 'symposium' ||
                  !config?.success ||
                  config.data.state !== 'draft'
                )
                  throw new Error('Current Symposium draft required for personal evidence');
              };
              custody();
              assertDraft();
              const mapping = sessionArtifacts!.getReady(sessionId);
              if (!mapping) return null;
              assertSessionArtifactVolume(
                gateway.workspace,
                mapping,
                await leaseHost!.inspectVolume(mapping.volumeName, 'podman'),
              );
              custody();
              assertDraft();
              const current = sessionArtifacts!.getReady(sessionId);
              if (
                !current ||
                current.sessionId !== mapping.sessionId ||
                current.volumeName !== mapping.volumeName ||
                current.volumeGeneration !== mapping.volumeGeneration
              )
                throw new Error('Session artifact readiness changed');
              return current;
            },
            collect: collectExplicitEvidence,
          });
        }),
      currentProfiles,
      publicationCredentials: options.publicationCredentials,
      physical,
      attemptRegistry: native.registry,
      async inspectCompletedArtifact(
        input: Parameters<PhysicalArtifactSealer['inspectCompletedArtifact']>[0],
        signal: AbortSignal,
      ) {
        if (draining || stopped) throw new Error('Owned Symposium host is shutting down');
        if (!(options.facts instanceof EventStore))
          throw new Error('Artifact sealing requires the retained event store');
        artifactSealer ??= new PhysicalArtifactSealer({
          store: options.facts,
          leaseHost: leaseHost!,
          gateway,
          attemptRegistry: native!.registry,
          runtimeConfig,
        });
        return track(() => artifactSealer!.inspectCompletedArtifact(input, signal));
      },
      async exportCompletedArtifactBundle(
        input: Parameters<PhysicalArtifactSealer['exportCompletedArtifactBundle']>[0],
        signal: AbortSignal,
      ) {
        if (draining || stopped) throw new Error('Owned Symposium host is shutting down');
        if (!(options.facts instanceof EventStore))
          throw new Error('Artifact sealing requires the retained event store');
        artifactSealer ??= new PhysicalArtifactSealer({
          store: options.facts,
          leaseHost: leaseHost!,
          gateway,
          attemptRegistry: native!.registry,
          runtimeConfig,
        });
        return track(() => artifactSealer!.exportCompletedArtifactBundle(input, signal));
      },
      async requireCompletedArtifactSeal(fenceId: string, signal: AbortSignal) {
        if (draining || stopped) throw new Error('Owned Symposium host is shutting down');
        if (!(options.facts instanceof EventStore))
          throw new Error('Artifact sealing requires the retained event store');
        artifactSealer ??= new PhysicalArtifactSealer({
          store: options.facts,
          leaseHost: leaseHost!,
          gateway,
          attemptRegistry: native!.registry,
          runtimeConfig,
        });
        return track(() => artifactSealer!.requireCompleted(fenceId, signal));
      },
      async sealSessionArtifacts(
        input: PhysicalArtifactSealInput,
        runtime: object,
        signal: AbortSignal,
      ) {
        if (draining || stopped) throw new Error('Owned Symposium host is shutting down');
        if (!(options.facts instanceof EventStore))
          throw new Error('Artifact sealing requires the retained event store');
        artifactSealer ??= new PhysicalArtifactSealer({
          store: options.facts,
          leaseHost: leaseHost!,
          gateway,
          attemptRegistry: native!.registry,
          runtimeConfig,
        });
        return track(() => artifactSealer!.seal(input, runtime, signal));
      },
      artifactLeaseHost: leaseHost,
      artifactRequest,
      ensureSessionArtifacts,
      verifySubscriptionPrivateAuth: subscription.verifyPrivateAuth,
      assertSubscriptionDispatch: (
        ...args: Parameters<NonNullable<typeof subscription>['assertPrivateAuth']>
      ) => {
        if (draining) throw new Error('Owned Symposium host is shutting down');
        return subscription!.assertPrivateAuth(...args);
      },
      runSandboxCreation: workspaceLifecycle.create,
      personalConnections: {
        ...subscription.personalConnections,
        create: (
          ...args: Parameters<NonNullable<typeof subscription>['personalConnections']['create']>
        ) => {
          if (draining) throw new Error('Owned Symposium host is shutting down');
          return subscription!.personalConnections.create(...args);
        },
        disconnect: (
          ...args: Parameters<NonNullable<typeof subscription>['personalConnections']['disconnect']>
        ) => track(() => subscription!.personalConnections.disconnect(...args)),
        recoverDiscovery: (
          ...args: Parameters<
            NonNullable<typeof subscription>['personalConnections']['recoverDiscovery']
          >
        ) => track(() => subscription!.personalConnections.recoverDiscovery(...args)),
        discoverModels: (
          ...args: Parameters<
            NonNullable<NonNullable<typeof subscription>['personalConnections']['discoverModels']>
          >
        ) => track(() => subscription!.personalConnections.discoverModels!(...args)),
      },
      beginLogin: (selection?: ConnectionSelection) =>
        startLogin(false, selection) as ReturnType<NonNullable<typeof subscription>['beginLogin']>,
      beginDeviceLogin: (selection?: ConnectionSelection) =>
        startLogin(true, selection) as ReturnType<
          NonNullable<typeof subscription>['beginDeviceLogin']
        >,

      beginShutdown() {
        draining = true;
        workspaceLifecycle.beginDrain();
      },
      async drain(signal: AbortSignal) {
        draining = true;
        workspaceLifecycle.beginDrain();
        const pending = await Promise.allSettled([...pendingHostOperations]);
        let failed = pending.some(
          (result) =>
            result.status === 'rejected' && !(result.reason instanceof LoginCancelledForShutdown),
        );
        signal.throwIfAborted();
        try {
          if (login) await login.cancel();
          if (loginQuarantined) failed = true;
        } catch {
          failed = true;
        }
        try {
          await workspaceLifecycle.drain(signal);
        } catch {
          failed = true;
        }
        signal.throwIfAborted();
        if (failed) throw new Error('Host operation did not settle cleanly');
      },
      markShutdownUncertain() {
        for (const claim of native!.registry.pending())
          native!.registry.markUncertain(claim.claimToken);
      },
      async closeAfterDrain(signal: AbortSignal) {
        signal.throwIfAborted();
        await gateway.stopAndWait(signal);
        signal.throwIfAborted();
        stopped = true;
        subscription!.invalidate();
        native!.registry.close();
        artifactSealer?.close();
        leaseHost!.close();
        sessionArtifacts!.close();
      },
      stop() {
        if (stopped) return;
        stopped = true;
        try {
          void Promise.resolve(login?.cancel()).catch(() => {
            loginQuarantined = true;
          });
          subscription!.invalidate();
          for (const claim of native!.registry.pending())
            native!.registry.markUncertain(claim.claimToken);
        } finally {
          try {
            native!.registry.close();
          } finally {
            try {
              artifactSealer?.close();
              leaseHost!.close();
              sessionArtifacts!.close();
            } finally {
              gateway.stop();
            }
          }
        }
      },
    };
  } catch (error) {
    subscription?.invalidate();
    native?.registry.close();
    artifactSealer?.close();
    leaseHost?.close();
    sessionArtifacts?.close();
    gateway.stop();
    throw error;
  }
}
