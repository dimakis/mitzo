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
import type { EventStore } from '@mitzo/protocol/event-store';
import {
  OwnedSymposiumGateway,
  type OwnedSymposiumGatewayOptions,
} from './symposium-owned-gateway.js';
import { initializeSymposiumNativeHost } from './symposium-native-host.js';
import { SqliteArtifactLeaseHost } from './symposium-artifact-host.js';
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
export interface OwnedSymposiumHostOptions {
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
  podmanCommand?: (args: readonly string[]) => Promise<string>,
) {
  if (
    !isAbsolute(options.attestationPath) ||
    !isAbsolute(options.podman.executable) ||
    !id.test(options.podman.sandboxNamespace) ||
    !isAbsolute(options.runtime.policy) ||
    !isAbsolute(options.runtime.seed)
  )
    throw new Error('Owned Symposium host requires explicit private paths and namespace');
  try {
    const evidence = lstatSync(options.attestationPath);
    if (!evidence.isFile() || evidence.isSymbolicLink() || evidence.mode & 0o077)
      throw new Error('Owned Symposium attestation must be a private regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
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
  const gateway = await launch(options.gateway);
  let native: ReturnType<typeof initializeSymposiumNativeHost> | undefined;
  let leaseHost: SqliteArtifactLeaseHost | undefined;
  let subscription: ReturnType<typeof createPersonalSubscriptionHost> | undefined;
  let sessionArtifacts: SymposiumSessionArtifacts | undefined;
  let stopped = false;
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
      workdir: '/sandbox/workspaces/mgmt',
      serviceProviders: [],
      grantableServiceProviders: [],
      webSearch: 'disabled',
    };
    native = initializeSymposiumNativeHost(join(gateway.stateDirectory, 'native-attempts'));
    const podmanEnv = { ...options.podman.environment };
    const podmanText = async (args: readonly string[]): Promise<string> => {
      custody();
      const text = podmanCommand
        ? await podmanCommand(args)
        : await new Promise<string>((resolve, reject) => {
            execFile(
              options.podman.executable,
              [...args],
              { env: podmanEnv, encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
              (error, stdout) => {
                if (error) reject(new Error('Owned Podman operation failed'));
                else resolve(stdout);
              },
            );
          });
      custody();
      return text;
    };
    const podman = async (args: readonly string[]): Promise<unknown> =>
      JSON.parse(await podmanText(args));
    const artifactEvidence = new LocalPodmanArtifactEvidence(
      gateway.workspace,
      options.podman.sandboxNamespace,
      podman,
      gateway,
    );
    const leasePath = join(gateway.stateDirectory, 'artifact-leases.db');
    leaseHost = new SqliteArtifactLeaseHost(leasePath, artifactEvidence, async (driver, name) => {
      if (driver !== 'podman' || !id.test(name))
        throw new Error('Invalid owned artifact volume inspection');
      return podman(['volume', 'inspect', name]);
    });
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
        async create(name, labels) {
          const result = await podmanText([
            'volume',
            'create',
            '--driver',
            'local',
            ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
            name,
          ]);
          if (result.trim() !== name) throw new Error('Artifact volume creation identity changed');
        },
      },
    );
    chmodSync(sessionArtifactsPath, 0o600);
    const ensureSessionArtifacts = async (
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
      const mapped = artifacts.get(sessionId);
      if (mapped) {
        assertSessionArtifactVolume(
          gateway.workspace,
          mapped,
          await leaseHost!.inspectVolume(mapped.volumeName, 'podman'),
        );
        custody();
        return { state: 'ready' };
      }
      return sessionArtifacts!.ensure(sessionId);
    };
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
    );
    const artifactRequest = (
      sessionId: string,
      seatId: string,
      generation: number,
      purpose: 'admission' | 'cleanup' = 'admission',
    ): ArtifactLeaseRequest => {
      custody();
      const mapped =
        artifacts.get(sessionId) ??
        (purpose === 'cleanup'
          ? sessionArtifacts!.getRetained(sessionId)
          : sessionArtifacts!.getReady(sessionId));
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
    const startLogin = async (device: boolean, selection?: ConnectionSelection) => {
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
      if (stopped) {
        void pending.completed.catch(() => undefined);
        await pending.cancel();
        throw new Error('Owned Symposium host stopped');
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
    return {
      gateway,
      runtimeConfig,
      attestationPath: options.attestationPath,
      currentProfiles,
      physical,
      attemptRegistry: native.registry,
      artifactLeaseHost: leaseHost,
      artifactRequest,
      ensureSessionArtifacts,
      verifySubscriptionPrivateAuth: subscription.verifyPrivateAuth,
      assertSubscriptionDispatch: subscription.assertPrivateAuth,
      runSandboxCreation: workspaceLifecycle.create,
      personalConnections: subscription.personalConnections,
      beginLogin: (selection?: ConnectionSelection) =>
        startLogin(false, selection) as ReturnType<NonNullable<typeof subscription>['beginLogin']>,
      beginDeviceLogin: (selection?: ConnectionSelection) =>
        startLogin(true, selection) as ReturnType<
          NonNullable<typeof subscription>['beginDeviceLogin']
        >,

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
    leaseHost?.close();
    sessionArtifacts?.close();
    gateway.stop();
    throw error;
  }
}
