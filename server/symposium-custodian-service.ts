import {
  StagingNativeFeatureOwner,
  type StagingNativeEnrollment,
} from './staging-native-feature-owner.js';
import type { StagingNativeFeatureBootstrap } from './staging-native-feature-bootstrap.js';
import { StagingNativeInferenceCurrentOwner } from './staging-native-inference-current-owner.js';
import type { SymposiumStagingNativeFixtures } from './symposium-staging-native-fixture.js';
import { collectStagingNativeTextReadEvidence } from './staging-native-feature-evidence.js';
import type { StagingNativeModelRequestReceipt } from './staging-native-model-authority.js';
import { createRequire } from 'node:module';
import {
  createStagingFeatureRouter,
  type StagingFeatureOwnerProtocol,
} from './staging-feature-router.js';
import type {
  SymposiumReviewPhysicalHost,
  SymposiumReviewRouteHost,
} from './symposium-review-host-contract.js';
import {
  createSymposiumPersonalConnectionRouter,
  type SymposiumPersonalConnectionService,
} from './symposium-personal-connection-router.js';
import { SymposiumReviewActionAuthority } from './symposium-review-action-authority.js';
import { createSymposiumSuccessorFixAuthority } from './symposium-artifact-successor-authority.js';
import { createSymposiumReaderAuthorityBridge } from './symposium-reader-authority-bridge.js';
import { createSymposiumProductionReviewComposition } from './symposium-production-review-composition.js';
import type { InitialSourceExportReceipt } from './symposium-source-artifact-seal.js';
import type { ArtifactGenerationRequest } from './symposium-artifact-generations.js';
import type { SuccessorArtifactExportReceipt } from './symposium-physical-artifact-seal.js';
import {
  createSymposiumApplicationDispatchPolicy,
  selectSymposiumApplicationClaim,
} from './symposium-application-dispatch.js';
import { knowledgeLibraryFromEnvironment } from './knowledge-library-runtime.js';
import { createKnowledgeLibraryLoader } from './knowledge-library-loader.js';
import { custodianPublicationApproval } from './symposium-custodian-authority.js';
import { drainRetainedSymposiumControllers } from './symposium-controller-drain.js';
import { createSymposiumSourceRouter } from './symposium-source-routes.js';
import {
  PublicationRegistration,
  publicationAuthorityPath,
  type PublicationCredentialRegistration,
} from './symposium-publication-registration.js';
import {
  completedPublicationArtifact,
  completedSealHash,
  publicationSealFenceForRecord,
  type CompletedPublicationHost,
} from './symposium-publication-artifact.js';
import { createPublicationRouter } from './symposium-publication-routes.js';
import { capabilityOperationStore } from './capability-operation-owner.js';
import {
  ownedEvidenceHandler,
  sessionOwnedEvidenceHandler,
  sessionEvidenceRequestAuthority,
} from './symposium-owned-evidence.js';
import type { SandboxCreationFence } from './symposium-workspace-lifecycle.js';
import type { ConnectionSelection } from './symposium-personal-connections.js';
import { SymposiumReviewStore } from './symposium-review-workflows.js';
import { SymposiumAccessRequests } from './symposium-access-tools.js';
import { createSymposiumAccessRouter } from './symposium-access-router.js';
import { createSymposiumReviewRouteComposition } from './symposium-review-route-composition.js';
import { createSymposiumSessionRouter } from './symposium-session-create.js';
import { createSubscriptionLoginController } from './symposium-subscription-login-route.js';
import { AccountBindingSchema, SymposiumConfigSchema } from '@mitzo/protocol';
import { SymposiumProfileStore } from './symposium-profiles.js';
import { authorizeSymposiumSeat } from './symposium-seat-authorization.js';
import { createAgentLibraryRouter } from './agent-library-router.js';
import { createContextPackRouter } from './context-pack-router.js';
import {
  createAcceptedContextPacks,
  installContextPackRuntime,
  contextPackSourceRef,
} from './context-pack-runtime.js';
import { contextPackRouterDependencies } from './context-pack-composition.js';
import {
  SymposiumAgentContextStore,
  createSymposiumAgentContextBinding,
} from './symposium-agent-context.js';
import { createSymposiumProfileRouter } from './symposium-profile-routes.js';
import { SymposiumProfileProposalStore } from './symposium-profile-proposals.js';
import { createSymposiumProfileProposalRouter } from './symposium-profile-proposal-routes.js';
import { type AccountProfiles } from './account-profiles.js';
import { SymposiumOrchestrator } from './symposium-orchestrator.js';
import {
  createOpenShellProviderIdentityResolver,
  createSymposiumSessionRuntime,
} from './symposium-session-runtime.js';
import { SymposiumNativeEventSink } from './symposium-native-event-sink.js';
import type { OpenShellRuntimeConfig } from './openshell-runtime.js';
import {
  readSymposiumProductionAttestation,
  verifySymposiumProductionGate,
  assertSymposiumAttestedClaudeProvider,
  type SymposiumProductionPhysicalProof,
} from './symposium-production-gate.js';
import { SYMPOSIUM_CODEX_CONTROLLER_COMMAND } from './symposium-codex-native.js';
import {
  SYMPOSIUM_SUBSCRIPTION_CONTROLLER_COMMAND,
  type VerifySymposiumSubscriptionAuth,
} from './symposium-subscription-native.js';
import type { ArtifactLeaseRequest } from './symposium-artifact-lease.js';
import { createSymposiumDirectorRouter } from './symposium-director-routes.js';
import { SymposiumHostGrants } from './symposium-host-grants.js';
import { getSymposiumPerspective, getSymposiumQueuedInputs } from './symposium-perspectives.js';
import express from 'express';
import { realpathSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';
import { createHash, randomUUID } from 'crypto';
import {
  operatorAuthMiddleware,
  registerAuthSession,
  type AuthSession,
} from './operator-session.js';
import { homedir } from 'os';
import { EventStore } from './event-store.js';
import { CodexConversationStore } from './codex-conversation-store.js';
import { AgentLibraryStore } from './agent-library-store.js';
import { codexPrivateDirectory } from './codex-private-path.js';
import { loadRepoConfig } from './repo-config.js';
import { lstatSync, mkdirSync } from 'node:fs';
import { dispatchCustodianHttp } from './symposium-custodian-http.js';
import { custodianRequestAuthority } from './symposium-custodian-authority.js';
import type { CustodianRequest } from './symposium-custodian-protocol.js';
import type { CapabilityApproval } from './connections/capabilities/types.js';
export interface SymposiumProductionHost
  extends SymposiumReviewPhysicalHost, SymposiumReviewRouteHost {
  activateSuccessorArtifact?(
    request: ArtifactGenerationRequest,
    generationId: string,
    exported: InitialSourceExportReceipt | SuccessorArtifactExportReceipt,
    bundle: Buffer,
    signal: AbortSignal,
  ): Promise<{ generationId: string; revision: number }>;
  publicationCredentials?: readonly PublicationCredentialRegistration[];
  exportCompletedArtifactBundle?: CompletedPublicationHost['exportCompletedArtifactBundle'];
  runSandboxCreation?: SandboxCreationFence;
  ensureSessionArtifacts?: (
    sessionId: string,
  ) => Promise<import('./symposium-session-artifacts.js').SessionArtifactPreparation>;
  /** Source-only capabilities minted inside the original owned host. */
  captureStagingFeatureEnrollment?: (profileId: string, model: string) => StagingNativeEnrollment;
  createStagingFeatureFixtures?: (
    assertOriginalOwnerCurrent: () => void,
  ) => SymposiumStagingNativeFixtures;
  runStagingFeatureOperation?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Dedicated upstream routing; never inherit the legacy chat gateway. */
  runtimeConfig: OpenShellRuntimeConfig;
  attestationPath: string;
  admissionBuildSelection?: import('./symposium-owned-runtime-contract.js').SymposiumOwnedBuildSelection;
  collectSessionAdmissionCandidate?: (
    binding: { sessionId: string; configRevision: number },
    assertCurrent: () => void,
  ) => Promise<import('./symposium-owned-evidence.js').SessionOwnedEvidenceCapability>;
  collectSessionAdmissionEvidence?: (
    selection: unknown,
  ) => Promise<import('./symposium-owned-evidence.js').SessionOwnedEvidenceCapability>;
  collectAdmissionEvidence?: (
    selection: unknown,
  ) => Promise<import('./symposium-production-gate.js').SymposiumProductionAttestation>;
  beginDeviceLogin?: (
    selection?: ConnectionSelection,
  ) => Promise<import('./symposium-device-login.js').DeviceLogin>;
  beginLogin?: (selection?: ConnectionSelection) => Promise<{
    authorizationUrl: string;
    completed: Promise<unknown>;
    cancel(): void;
  }>;
  personalConnections?: SymposiumPersonalConnectionService;
  resolveSeatPolicy?: import('./symposium-owned-seat-policy.js').SymposiumSeatPolicySelector;
  observeDurableReviewToolResult?: import('./symposium-codex-native.js').OpenAiCodexSeatInput['observeDurableReviewToolResult'];
  /** Private host-only final RPC input metadata; omitted in ordinary production. */
  readonly observeNativeTurnInput?: boolean;
  observeStartupConfig?: import('./symposium-codex-native.js').OpenAiCodexSeatInput['observeStartupConfig'];
  observePrelaunch?: import('./symposium-codex-native.js').OpenAiCodexSeatInput['observePrelaunch'];
  readNativeObservation?: (
    claimToken: string,
  ) => import('./symposium-native-observations.js').NativeTurnObservation;
  verifySubscriptionPrivateAuth?: VerifySymposiumSubscriptionAuth;
  assertSubscriptionDispatch?: (input: Parameters<VerifySymposiumSubscriptionAuth>[0]) => void;
  physical: SymposiumProductionPhysicalProof;
  preinitialSource?: (sessionId: string) => boolean;
  artifactReady?: (sessionId: string, seatId: string, generation: number) => boolean;
  artifactRequest(
    sessionId: string,
    seatId: string,
    generation: number,
    purpose?: 'admission' | 'cleanup',
  ): ArtifactLeaseRequest;
}

export type CustodianBroadcast = (sessionId: string, event: Record<string, unknown>) => void;
/** Source compatibility only; provider/model authority is qualified separately. */
export const SYMPOSIUM_CUSTODIAN_SERVICE_PROTOCOL_VERSION = 1;
/** No stores, credential reads, host construction or listeners exist at import time. */
export function createSymposiumCustodianService(options: {
  workspaceRoot: string;
  broadcast?: CustodianBroadcast;
}) {
  const workspaceRoot = options.workspaceRoot;
  if (
    !isAbsolute(workspaceRoot) ||
    resolve(workspaceRoot) !== workspaceRoot ||
    realpathSync(workspaceRoot) !== workspaceRoot
  )
    throw Error('Exact absolute original native workspace required');
  const workspace = lstatSync(workspaceRoot);
  if (
    !workspace.isDirectory() ||
    workspace.isSymbolicLink() ||
    (process.getuid && workspace.uid !== process.getuid())
  )
    throw Error('Original owned native workspace required');
  const custodianOwnerMode = process.env.MITZO_SYMPOSIUM_CUSTODIAN_OWNER === '1';
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => {
    try {
      const authorization = custodianRequestAuthority(req);
      if (custodianOwnerMode && !authorization)
        return res.status(403).json({ error: 'Original custodian request authority required' });
      if (authorization) res.locals.authSession = authorization;
      next();
    } catch {
      res.status(403).json({ error: 'Original custodian authority unavailable' });
    }
  });
  if (custodianOwnerMode && !process.env.MITZO_CODEX_PRIVATE_DIR)
    throw Error('Explicit original owned Codex private directory required');
  const codexDirectory = codexPrivateDirectory();
  const stateDirectory = join(workspaceRoot, '.mitzo');
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const state = lstatSync(stateDirectory);
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    (process.getuid && state.uid !== process.getuid())
  )
    throw Error('Original owned native state directory required');
  const eventStore = new EventStore(join(stateDirectory, 'events.db'));
  mkdirSync(codexDirectory, { recursive: true, mode: 0o700 });
  const codexStore = new CodexConversationStore(join(codexDirectory, 'conversations.db'), {
    requireOwner: custodianOwnerMode,
  });
  const agentLibrary = new AgentLibraryStore(join(workspaceRoot, '.mitzo', 'events.db'));
  const getRepoConfig = () => loadRepoConfig(workspaceRoot);
  const getKnowledgeLibraryRuntime = createKnowledgeLibraryLoader(() =>
    knowledgeLibraryFromEnvironment(process.env, {
      workspaceRoots: [
        workspaceRoot,
        ...Object.values(getRepoConfig().repos),
        ...getRepoConfig().allowedPaths,
      ].filter(Boolean),
    }),
  );
  const releaseContextPacks = installContextPackRuntime(getKnowledgeLibraryRuntime);
  let stagingFeatureOwner: StagingFeatureOwnerProtocol | undefined;
  let stagingNativeInferenceCurrentOwner: StagingNativeInferenceCurrentOwner | undefined;
  app.use(
    '/api/staging/features',
    operatorAuthMiddleware,
    createStagingFeatureRouter(
      () => stagingFeatureOwner,
      () => stagingNativeInferenceCurrentOwner,
    ),
  );
  app.use(
    '/api/context-packs',
    operatorAuthMiddleware,
    createContextPackRouter(async () => {
      const runtime = await getKnowledgeLibraryRuntime();
      return runtime ? contextPackRouterDependencies(runtime, agentLibrary) : undefined;
    }),
  );
  app.use(
    '/api/agent-library',
    operatorAuthMiddleware,
    createAgentLibraryRouter(agentLibrary, {
      workspaceRoot,
      contextPacks: async (signal) => {
        const runtime = await getKnowledgeLibraryRuntime();
        if (!runtime) throw Error('Knowledge Library is not configured');
        return createAcceptedContextPacks(runtime, {
          assertCurrent: () => signal.throwIfAborted(),
        });
      },
    }),
  );
  const symposiumProfileStore = new SymposiumProfileStore(
    join(workspaceRoot, '.mitzo', 'events.db'),
  );
  const symposiumAgentContextStore = new SymposiumAgentContextStore(
    join(workspaceRoot, '.mitzo', 'events.db'),
  );
  const symposiumAccessRequests = new SymposiumAccessRequests(
    join(workspaceRoot, '.mitzo', 'events.db'),
  );
  const symposiumProfileProposalStore = new SymposiumProfileProposalStore(
    join(workspaceRoot, '.mitzo', 'events.db'),
  );
  app.use(
    '/api/symposium/profile-proposals',
    operatorAuthMiddleware,
    createSymposiumProfileProposalRouter(symposiumProfileProposalStore, (sessionId) =>
      Boolean(eventStore.getSession(sessionId)),
    ),
  );
  app.use(
    '/api/symposium/profiles',
    operatorAuthMiddleware,
    createSymposiumProfileRouter(symposiumProfileStore),
  );

  let custodianBroadcast: CustodianBroadcast | undefined = options.broadcast;
  function setSymposiumCustodianBroadcast(value: CustodianBroadcast) {
    if (!custodianOwnerMode) throw Error('Retained custodian mode required');
    custodianBroadcast = value;
  }
  const retainedCustodianSessions = new Set<string>();
  function hasRetainedCustodianSession(sessionId: string) {
    return retainedCustodianSessions.has(sessionId);
  }
  const symposiumNativeEvents = new SymposiumNativeEventSink(eventStore, (sessionId, event) =>
    custodianBroadcast?.(sessionId, event),
  );
  const symposiumSessionRuntimes = new Map<
    string,
    {
      orchestrator: SymposiumOrchestrator;
      runtimeFingerprint: string;
      runtime: ReturnType<typeof createSymposiumSessionRuntime>;
    }
  >();
  let symposiumShuttingDown = false;
  let symposiumControllerPaused = false;
  function pauseSymposiumController() {
    symposiumControllerPaused = true;
  }
  async function drainSymposiumController(identity: string, signal: AbortSignal) {
    pauseSymposiumController();
    await drainRetainedSymposiumControllers(eventStore, symposiumSessionRuntimes, identity, signal);
  }
  function resumeSymposiumController() {
    if (symposiumShuttingDown || symposiumSessionRuntimes.size)
      throw Error('Retained runtime cleanup incomplete');
    symposiumControllerPaused = false;
  }
  function beginSymposiumShutdown() {
    symposiumShuttingDown = true;
    symposiumPublication?.shutdown();
    for (const entry of symposiumSessionRuntimes.values()) entry.runtime.beginShutdown();
  }
  async function drainSymposiumRuntimes(signal: AbortSignal) {
    beginSymposiumShutdown();
    const results = await Promise.allSettled(
      [...symposiumSessionRuntimes.values()].map((entry) => entry.runtime.drain(signal)),
    );
    signal.throwIfAborted();
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Symposium runtime cleanup incomplete');
  }
  /** Retire a live custodian's retained authority before its gateway exits.
   * Physical cleanup alone cannot leave active membership generations behind:
   * the next owner must see durable suspension and require explicit restore. */
  async function retireRetainedSymposiumRuntimes(identity: string, signal: AbortSignal) {
    if (!custodianOwnerMode) throw Error('Retained custodian mode required');
    beginSymposiumShutdown();
    await drainRetainedSymposiumControllers(eventStore, symposiumSessionRuntimes, identity, signal);
  }
  let symposiumProductionHost: SymposiumProductionHost | undefined;
  let symposiumPublication: PublicationRegistration | undefined;
  /** Trusted server bootstrap only. No request handler accepts or supplies this capability. */
  function installSymposiumProductionHost(host: SymposiumProductionHost): void {
    if (symposiumProductionHost || symposiumSessionRuntimes.size)
      throw new Error('Symposium production host must be installed once before runtime creation');
    if (custodianOwnerMode && host.sourceImport?.requireSeal && !host.reviewHost) {
      const composed = createSymposiumProductionReviewComposition({
        host,
        events: eventStore,
        reviews: symposiumReviewStore,
        grants: symposiumHostGrants,
        actionAuthority: symposiumReviewActionAuthority,
        artifactResultsPath: join(workspaceRoot, '.mitzo', 'events.db'),
        runtime: (sessionId) => symposiumRuntimeForSession(sessionId),
        retainedRuntime: (sessionId) => symposiumSessionRuntimes.get(sessionId) ?? null,
        retireSealedRuntime: (sessionId, runtime) => {
          const retained = symposiumSessionRuntimes.get(sessionId);
          if (!retained || retained.runtime !== runtime)
            throw new Error('Sealed runtime identity changed before retirement');
          symposiumSessionRuntimes.delete(sessionId);
        },
      });
      try {
        installSymposiumReaderAuthority({
          current: composed.assertReaderAdmissionCurrent,
          staged: composed.assertReaderAdmissionStaged,
        });
        host.reviewHost = composed.reviewHost;
      } catch (error) {
        composed.close();
        throw error;
      }
    }
    if (host.publicationCredentials?.length) {
      if (
        !host.requireCompletedArtifactSeal ||
        !host.inspectCompletedArtifact ||
        !host.exportCompletedArtifactBundle
      )
        throw new Error('Publication registration requires completed artifact custody');
      const artifact = completedPublicationArtifact({
        store: symposiumReviewStore,
        host: {
          requireCompletedArtifactSeal: host.requireCompletedArtifactSeal.bind(host),
          inspectCompletedArtifact: host.inspectCompletedArtifact.bind(host),
          exportCompletedArtifactBundle: host.exportCompletedArtifactBundle.bind(host),
        },
      });
      symposiumPublication = new PublicationRegistration({
        describeArtifact: async (sessionId, recordId, signal) => {
          const record = symposiumReviewStore.getReviewRecord('user', sessionId, recordId);
          const fenceId = record && publicationSealFenceForRecord(record);
          const intent = fenceId && eventStore.getSymposiumArtifactSealByFence(fenceId);
          if (!record || !intent)
            throw new Error('Trusted review record and completed seal required');
          const seal = await host.requireCompletedArtifactSeal!(intent.fenceId, signal);
          if (
            seal.sessionId !== sessionId ||
            seal.fenceId !== intent.fenceId ||
            seal.git.commit !== record.snapshot.artifactRevision ||
            seal.git.committedTreeDigest !== record.snapshot.artifactHash ||
            intent.selection.sessionId !== sessionId
          )
            throw new Error('Trusted review record seal changed');
          return {
            recordId: record.recordId,
            recordHash: record.contentHash,
            sealId: seal.fenceId,
            sealHash: completedSealHash(seal),
            commit: seal.git.commit,
          };
        },
        authorityPath: publicationAuthorityPath(join(workspaceRoot, '.mitzo')),
        operations: capabilityOperationStore(join(workspaceRoot, '.mitzo')),
        credentials: host.publicationCredentials,
        artifact,
      });
    }
    symposiumProductionHost = host;
  }
  const stagingNativeSessions = new Map<
    string,
    {
      host: SymposiumProductionHost;
      candidate: import('./symposium-production-gate.js').SymposiumProductionAttestation;
      claimToken: string;
      fixture: import('./symposium-staging-native-fixture.js').StagingNativeFixture;
      fixtures: SymposiumStagingNativeFixtures;
      sandboxGuards: Map<
        string,
        import('./staging-native-model-authority.js').StagingNativeSandboxGuard
      >;
      prepareSandbox(
        name: string,
      ): Promise<import('./staging-native-model-authority.js').StagingNativeSandboxGuard>;
      assertCurrent(): void;
      assertCleanupCurrent(): void;
    }
  >();
  let symposiumRuntimeForSession: (sessionId: string) => SymposiumOrchestrator | null = (
    sessionId,
  ) => {
    if (symposiumShuttingDown || symposiumControllerPaused) return null;
    if (custodianOwnerMode && !retainedCustodianSessions.has(sessionId)) return null;
    if (eventStore.getSession(sessionId)?.sessionType !== 'symposium') return null;
    const host = symposiumProductionHost;
    if (!host) return null;
    const baseConfig = host.runtimeConfig;
    const attestationPath = host.attestationPath;
    if (!attestationPath) return null;
    let verified: ReturnType<typeof verifySymposiumProductionGate>;
    let attestationIdentity: string | undefined;
    const verifyHostCapability = (cleanup = false) => {
      if (symposiumShuttingDown) throw new Error('Symposium is shutting down');
      if (!attestationPath || !symposiumProductionHost)
        throw new Error('Symposium production host or attestation is unavailable');
      const feature = stagingNativeSessions.get(sessionId);
      if (feature) {
        if (feature.host !== symposiumProductionHost) throw Error('Original feature host changed');
        if (cleanup) feature.assertCleanupCurrent();
        else feature.assertCurrent();
      }
      const attestation = feature?.candidate ?? readSymposiumProductionAttestation(attestationPath);
      const identity = JSON.stringify(attestation);
      if (attestationIdentity && identity !== attestationIdentity)
        throw new Error('Symposium production attestation changed during session');
      const result = verifySymposiumProductionGate(
        baseConfig,
        attestation,
        symposiumProductionHost.physical,
        undefined,
        symposiumProductionHost.admissionBuildSelection,
      );
      attestationIdentity = identity;
      return result;
    };
    try {
      verified = verifyHostCapability();
      if (
        verified.allowedAccountProviders.has('openai-codex') &&
        (!host.verifySubscriptionPrivateAuth || !host.assertSubscriptionDispatch)
      )
        return null;
    } catch {
      return null;
    }
    const runtimeConfig = verified.runtimeConfig;
    const runtimeFingerprint = JSON.stringify({
      runtimeConfig,
      allowedRoles: [...verified.allowedRoles].sort(),
      allowedAccountProviders: [...verified.allowedAccountProviders].sort(),
      attestationIdentity,
    });
    const cached = symposiumSessionRuntimes.get(sessionId);
    if (cached && cached.runtimeFingerprint !== runtimeFingerprint) return null;
    let runtime = cached?.orchestrator;
    if (!runtime) {
      const retainedRuntime = createSymposiumSessionRuntime({
        sessionId,
        store: eventStore,
        profiles: host.currentProfiles(),
        currentProfiles: host.currentProfiles,
        observeDurableReviewToolResult: stagingNativeSessions.has(sessionId)
          ? undefined
          : host.observeDurableReviewToolResult,
        observeNativeTurnInput: host.observeNativeTurnInput,
        observeStartupConfig: host.observeStartupConfig,
        observePrelaunch: host.observePrelaunch,
        hostGrants: symposiumHostGrants,
        codexStore: codexStore,
        profileProposalStore: symposiumProfileProposalStore,
        accessRequests: symposiumAccessRequests,
        profileCatalogStore: symposiumProfileStore,
        agentContext: createSymposiumAgentContextBinding({
          store: symposiumAgentContextStore,
          profiles: symposiumProfileStore,
          assertCurrent: (execution) => {
            execution.signal.throwIfAborted();
            const generation = execution.provenance.membershipGeneration;
            if (generation === undefined)
              throw Error('Context membership generation is unavailable');
            symposiumHostGrants.verifySeat({
              sessionId: execution.sessionId,
              seat: execution.seat,
              membershipGeneration: generation,
            });
            const recipe = execution.seat.contextRecipe;
            if (
              recipe?.source === 'packs' &&
              recipe.packs.some(
                (pin) =>
                  !execution.seat.contextGrant?.sourceRefs.includes(contextPackSourceRef(pin)),
              )
            )
              throw Error('The selected context packs are outside the host-issued context grant');
          },
          compileOptions: async (execution) => {
            const runtime = await getKnowledgeLibraryRuntime();
            if (!runtime) throw Error('Knowledge Library is not configured for this agent');
            return {
              packs: createAcceptedContextPacks(runtime, {
                assertCurrent: () => {
                  execution.signal.throwIfAborted();
                  const generation = execution.provenance.membershipGeneration;
                  if (generation === undefined)
                    throw Error('Context membership generation is unavailable');
                  symposiumHostGrants.verifySeat({
                    sessionId: execution.sessionId,
                    seat: execution.seat,
                    membershipGeneration: generation,
                  });
                },
              }),
            };
          },
        }),
        reviewStore: symposiumReviewStore,
        resolveProviderIdentity: createOpenShellProviderIdentityResolver(runtimeConfig),
        runtimeConfig,
        perSeatSandboxVerified: true,
        allowedSeatRoles: verified.allowedRoles,
        allowedAccountProviders: verified.allowedAccountProviders,
        verifyHostCapability,
        verifyCleanupCapability: () => verifyHostCapability(true),
        attemptRegistry: host.attemptRegistry,
        claimIdFactory: (input) =>
          stagingNativeSessions.get(input.sessionId)?.claimToken ??
          selectSymposiumApplicationClaim(symposiumReviewStore, input) ??
          randomUUID(),
        assertArtifactAdmissionCurrent: host.assertArtifactAdmissionCurrent,
        applicationPolicy: createSymposiumApplicationDispatchPolicy({
          store: symposiumReviewStore,
          observations: host.attemptRegistry.observations,
          assertArtifactCurrent(attempt) {
            const current = host.reviewHost?.currentArtifact({ owner: 'user', sessionId });
            if (
              !current ||
              current.revision !== attempt.artifactRevision ||
              current.hash !== attempt.artifactHash
            )
              throw new Error('Trusted current application artifact unavailable');
          },
        }),
        artifactLeaseHost: host.artifactLeaseHost,
        artifactRequest: host.artifactRequest,
        preinitialSource: host.preinitialSource,
        artifactReady: host.artifactReady,
        resolveSeatPolicy: host.resolveSeatPolicy,
        runSandboxCreation: host.runSandboxCreation,
        verifiedCodexControllerCommand: SYMPOSIUM_CODEX_CONTROLLER_COMMAND,
        ...(host.verifySubscriptionPrivateAuth
          ? {
              verifiedSubscriptionControllerCommand: SYMPOSIUM_SUBSCRIPTION_CONTROLLER_COMMAND,
              verifySubscriptionPrivateAuth: host.verifySubscriptionPrivateAuth,
              assertSubscriptionDispatch: host.assertSubscriptionDispatch,
            }
          : {}),
        readOnlyEnforced: {
          openaiApi: verified.readOnlyEnforced,
          chatgptSubscription: verified.readOnlyEnforced,
          claudeVertex: verified.claudeProviders.size > 0,
        },
        stagingEffectCurrent: stagingNativeSessions.has(sessionId)
          ? () => {
              const original = stagingNativeSessions.get(sessionId);
              if (!original || original.host !== host)
                throw Error('Original staging native effect owner unavailable');
              original.assertCurrent();
            }
          : undefined,
        stagingCleanupCurrent: stagingNativeSessions.has(sessionId)
          ? () => {
              const original = stagingNativeSessions.get(sessionId);
              if (!original || original.host !== host)
                throw Error('Original staging native cleanup owner unavailable');
              original.assertCleanupCurrent();
            }
          : undefined,
        stagingPrepareSandbox: stagingNativeSessions.has(sessionId)
          ? async (selected) => {
              const original = stagingNativeSessions.get(sessionId)!;
              original.assertCurrent();
              if (selected.sessionId !== sessionId || selected.seatId !== 'primary')
                throw Error('Original provisional sandbox scope changed');
              const guard =
                original.sandboxGuards.get(selected.sandboxName) ??
                (await original.prepareSandbox(selected.sandboxName));
              guard.assertCurrent();
              original.assertCurrent();
              original.sandboxGuards.set(selected.sandboxName, guard);
              return guard;
            }
          : undefined,
        stagingFixtureTools: stagingNativeSessions.has(sessionId)
          ? (execution, verifyCurrent) => {
              const original = stagingNativeSessions.get(sessionId)!;
              original.assertCurrent();
              if (execution.claimToken !== original.claimToken)
                throw Error('Original feature tool claim changed');
              if (execution.seat.accountBinding?.provider === 'anthropic-vertex')
                return {
                  tools: [],
                  instructions: 'Use the native Read exactly once on the requested nonce fixture.',
                  executeTool: async () => {
                    throw Error('Additional feature host tools are unavailable');
                  },
                };
              return original.fixtures.readTools(original.fixture, execution, verifyCurrent);
            }
          : undefined,
        recordAccepted: (receipt) => eventStore.markSymposiumRecipientAccepted(receipt),
        recordEvent: (execution, event) => symposiumNativeEvents.record(execution, event),
      });
      runtime = retainedRuntime.orchestrator;
      symposiumSessionRuntimes.set(sessionId, {
        orchestrator: runtime,
        runtimeFingerprint,
        runtime: retainedRuntime,
      });
    }
    return runtime;
  };
  const symposiumSafetyOrchestrator = new SymposiumOrchestrator({
    store: eventStore,
    executors: {},
  });
  function symposiumAccountProfiles(): AccountProfiles {
    if (!symposiumProductionHost) throw new Error('Symposium account catalog is unavailable');
    return symposiumProductionHost.currentProfiles();
  }
  const symposiumHostGrants = new SymposiumHostGrants(join(workspaceRoot, '.mitzo', 'events.db'), {
    getConfig: (sessionId) => {
      const raw = eventStore.getSession(sessionId)?.symposiumConfig;
      return raw ? SymposiumConfigSchema.parse(JSON.parse(raw)) : null;
    },
    commitConfig: (sessionId, config, expectedRevision, operation) =>
      operation
        ? eventStore.setSymposiumConfig(sessionId, config, expectedRevision, operation)
        : eventStore.setSymposiumConfig(sessionId, config, expectedRevision),
    getMembership: (sessionId, seatId) =>
      eventStore.getLatestSymposiumMembership(sessionId, seatId) ?? null,
    validateSelection: (seat) => {
      if (!seat.accountBinding) throw new Error('Seat account binding is required');
      symposiumAccountProfiles().validateModel(
        seat.accountBinding,
        seat.model,
        seat.reasoningEffort,
      );
    },
    resolveProfile: (selection) =>
      symposiumProfileStore.get('user', selection.profileId, selection.revision),
    authorizeSeat: authorizeSymposiumSeat,
  });
  const symposiumReaderAuthorityBridge = createSymposiumReaderAuthorityBridge();

  /** Trusted app composition installs the concrete owner once; requests never supply this callback. */
  function installSymposiumReaderAuthority(
    assertAdmissionCurrent: Parameters<typeof symposiumReaderAuthorityBridge.install>[0],
  ): void {
    symposiumReaderAuthorityBridge.install(assertAdmissionCurrent);
  }

  /** Called automatically inside the original runSymposiumCustodian bootstrap.
   * The app fixes its actual store, grants, runtime and retained host objects. */
  function configureStagingNativeFeatureOwner(
    host: SymposiumProductionHost & {
      gateway: import('./symposium-owned-gateway.js').OwnedSymposiumGateway;
    },
    bootstrap: StagingNativeFeatureBootstrap,
    ownerInstance: string,
    assertOriginalOwnerCurrent: () => void,
  ): void {
    if (
      !custodianOwnerMode ||
      symposiumProductionHost !== host ||
      stagingFeatureOwner ||
      process.env.PORT !== '3190' ||
      process.env.MITZO_BIND_HOST !== '127.0.0.1' ||
      !host.captureStagingFeatureEnrollment ||
      !host.createStagingFeatureFixtures ||
      !host.runStagingFeatureOperation
    )
      throw Error('Actual original canonical native feature composition required');
    const mutation = createRequire(import.meta.url)(
      '../scripts/lib/staging-pipeline-mutation-guard.mjs',
    ) as { assertStagingPipelineFeatureDispatch(input: unknown, options: { root: string }): void };
    if (typeof mutation.assertStagingPipelineFeatureDispatch !== 'function')
      throw Error('Accepted original feature singleton guard unavailable');
    let fixtures: SymposiumStagingNativeFixtures | undefined;
    const inferenceCurrent = new StagingNativeInferenceCurrentOwner(host.gateway);
    stagingNativeInferenceCurrentOwner = inferenceCurrent;
    stagingFeatureOwner = new StagingNativeFeatureOwner({
      bootstrap,
      gateway: host.gateway,
      ownerInstance,
      currentProfiles: host.currentProfiles,
      captureEnrollment: host.captureStagingFeatureEnrollment,
      assertOriginalOwnerCurrent: () => {
        assertOriginalOwnerCurrent();
        if (symposiumProductionHost !== host) throw Error('Original native feature host changed');
        host.currentProfiles();
      },
      assertReservation: (plan, token, planSha256) =>
        mutation.assertStagingPipelineFeatureDispatch(
          { sourceCommit: plan.sourceCommit, token, planSha256, plan },
          { root: join(homedir(), '.local/share/mitzo-staging') },
        ),
      execute: (input) =>
        host.runStagingFeatureOperation!(async () => {
          input.assertCurrent();
          const sessionId = randomUUID(),
            claimToken = randomUUID();
          const nonce = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
          const config = SymposiumConfigSchema.parse({
            version: 2,
            revision: 1,
            state: 'draft',
            anchorSeatId: 'primary',
            activeSeatCap: 1,
            interceptMode: 'manual',
            turnRules: { mode: 'directed', maxTurns: 2 },
            seats: [
              {
                id: 'primary',
                name: 'Staging fixture reader',
                role: 'reviewer',
                model: input.enrollment.selectedModel,
                accountBinding: input.enrollment.binding,
                color: '#335577',
                systemPrompt:
                  'Read only the exact nonce fixture requested in this turn and return its contents. Do not use other tools or delegate.',
                authorityRequest: { filesystem: 'read', tools: 'read', network: 'restricted' },
              },
            ],
          });
          eventStore.createSymposiumSession({
            idempotencyKey: `stage-feature:${input.runId}`,
            fingerprint: input.runId,
            sessionId,
            summary: 'Staging text/Read fixture',
            binding: input.enrollment.binding,
            config,
            profileSelections: {},
          });
          retainedCustodianSessions.add(sessionId);
          input.assertCurrent();
          if ((await host.ensureSessionArtifacts!(sessionId)).state !== 'ready')
            throw Error('Original staging native artifact creation is unconfirmed');
          fixtures ??= host.createStagingFeatureFixtures!(() => {
            bootstrap.assertOriginalOwnerCurrent();
            assertOriginalOwnerCurrent();
          });
          const fixture = await fixtures.prepare(sessionId, nonce, input.assertCurrent);
          input.assertCurrent();
          let candidate: import('./symposium-production-gate.js').SymposiumProductionAttestation;
          if (input.enrollment.personalConnection) {
            if (!host.collectAdmissionEvidence)
              throw Error('Original personal evidence adapter unavailable');
            candidate = await host.collectAdmissionEvidence({
              personalConnection: input.enrollment.personalConnection,
              sessionId,
              allowedRoles: ['reviewer'],
            });
          } else {
            if (!host.collectSessionAdmissionCandidate)
              throw Error('Original native draft evidence adapter unavailable');
            const original = await host.collectSessionAdmissionCandidate(
              { sessionId, configRevision: 1 },
              input.assertCurrent,
            );
            await original.assertCurrent();
            candidate = original.candidate;
          }
          input.assertCurrent();
          stagingNativeSessions.set(sessionId, {
            host,
            candidate,
            claimToken,
            fixture,
            fixtures,
            sandboxGuards: new Map(),
            prepareSandbox: async (name) => {
              const original = {
                runId: input.runId,
                planSha256: createHash('sha256').update(JSON.stringify(input.plan)).digest('hex'),
                acceptedAppCommit: input.plan.sourceCommit,
                nativeSourceCommit: input.plan.nativeSourceCommit ?? bootstrap.sourceCommit,
                ownerInstance,
                sessionId,
                claimToken,
                sandboxName: name,
                assertCurrent: input.assertCurrent,
                assertCleanupCurrent: input.assertCleanupCurrent,
              };
              const guard = await input.modelAuthority.prepareSandbox(input.modelPlan, {
                ...original,
                deadlineAt: input.deadlineAt,
                registerPreparedGuard: (pending) => {
                  inferenceCurrent.registerGuard(original, pending);
                  stagingNativeSessions.get(sessionId)!.sandboxGuards.set(name, pending);
                },
              });
              if (stagingNativeSessions.get(sessionId)!.sandboxGuards.get(name) !== guard)
                throw Error('Original pre-RPC native guard registration differs');
              return guard;
            },
            assertCurrent: input.assertCurrent,
            assertCleanupCurrent: input.assertCleanupCurrent,
          });
          const active = symposiumHostGrants.activate({
            sessionId,
            expectedRevision: 1,
            actor: 'staging-feature-owner',
            contextSourceRefs: [],
          });
          input.assertCurrent();
          const orchestrator = symposiumRuntimeForSession(sessionId);
          const runtime = symposiumSessionRuntimes.get(sessionId)?.runtime;
          if (!orchestrator || !runtime) throw Error('Actual original native runtime unavailable');
          fixtures.bindRuntime(fixture, runtime);
          const membership = await orchestrator.transitionMembership({
            sessionId,
            seatId: 'primary',
            action: 'admit',
            expectedGeneration: 0,
            configRevision: active.revision,
            actor: 'staging-feature-owner',
            reason: 'Exact announced staging fixture',
            idempotencyKey: `stage-feature:${input.runId}:admit`,
          });
          if (membership.state !== 'active' || membership.reconciliation !== 'confirmed')
            throw Error('Actual original native membership admission is unconfirmed');
          input.assertCurrent();
          const sandbox = await runtime.owner.ensure(
            sessionId,
            'primary',
            AbortSignal.timeout(60000),
          );
          if (!sandbox.sandboxId)
            throw Error('Original staging native sandbox identity unavailable');
          const preparedGuard = stagingNativeSessions
            .get(sessionId)!
            .sandboxGuards.get(sandbox.sandboxName);
          if (!preparedGuard) throw Error('Original provisional native sandbox guard unavailable');
          inferenceCurrent.bindSandbox(preparedGuard, sandbox.sandboxId);
          const budget = await input.modelAuthority.issue(input.modelPlan, {
            sessionId,
            seatId: 'primary',
            claimToken,
            sandboxName: sandbox.sandboxName,
            sandboxId: sandbox.sandboxId,
            deadlineAt: input.deadlineAt,
            preparedGuard,
          });
          budget.assertCurrent();
          input.assertCurrent();
          const delivery = orchestrator.stageDelivery({
            sessionId,
            sourceSeatId: null,
            recipientSeatIds: ['primary'],
            originalContent: `Use Read exactly once on ${fixture.fixturePath}. Return the exact file contents.`,
            idempotencyKey: `stage-feature:${input.runId}:delivery`,
          });
          orchestrator.intervene({
            deliveryId: delivery.deliveryId,
            action: 'approve',
            idempotencyKey: `stage-feature:${input.runId}:approve`,
          });
          let timer: ReturnType<typeof setTimeout> | undefined;
          let modelRequests: StagingNativeModelRequestReceipt | undefined;
          try {
            budget.assertCurrent();
            input.assertCurrent();
            await Promise.race([
              orchestrator.deliver(delivery.deliveryId),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(Error('Original native feature deadline expired')),
                  Math.max(1, input.deadlineAt - Date.now()),
                );
              }),
            ]);
            input.assertCurrent();
            budget.assertCurrent();
            const evidence = collectStagingNativeTextReadEvidence(
              eventStore,
              host.attemptRegistry,
              {
                sessionId,
                deliveryId: delivery.deliveryId,
                binding: input.enrollment.binding,
                fixturePath: fixture.fixturePath,
                nonce,
                afterSeq: 0,
              },
            );
            input.assertCleanupCurrent();
            await runtime.drain(AbortSignal.timeout(60000));
            input.assertCleanupCurrent();
            modelRequests = await budget.revokeAndConfirm();
            if (
              modelRequests.claimToken !== claimToken ||
              modelRequests.sandboxId !== sandbox.sandboxId
            )
              throw Error('Actual native HTTP request budget receipt changed');
            input.assertCleanupCurrent();
            const retirement = await fixtures.retire(
              fixture,
              claimToken,
              input.assertCleanupCurrent,
            );
            return { evidence, retirement, modelRequests };
          } catch (error) {
            // These are actual original cleanup operations. Their rejection/timeout
            // retains the same owner and never manufactures a terminal result.
            await Promise.allSettled([
              orchestrator.cancel({
                deliveryId: delivery.deliveryId,
                reason: 'Staging fixture failed',
                idempotencyKey: `stage-feature:${input.runId}:cancel`,
              }),
              runtime.drain(AbortSignal.timeout(60000)),
              ...(modelRequests ? [] : [budget.revokeAndConfirm()]),
            ]);
            throw error;
          } finally {
            if (timer) clearTimeout(timer);
          }
        }),
    });
  }

  function getSymposiumBootstrapDependencies() {
    return {
      collectSessionAdmissionEvidence: (selection: unknown) => {
        const collect = symposiumProductionHost?.collectSessionAdmissionEvidence;
        if (!collect) throw new Error('Original admission evidence owner unavailable');
        return collect(selection);
      },
      reviews: symposiumReviewStore,
      readNativeObservation: (claimToken: string) => {
        const read = symposiumProductionHost?.readNativeObservation;
        if (!read) throw new Error('Original native observation owner unavailable');
        return read(claimToken);
      },
      facts: eventStore,
      hostGrants: symposiumHostGrants,
      successorAuthority: createSymposiumSuccessorFixAuthority({
        workflows: symposiumReviewStore,
        events: eventStore,
        grants: symposiumHostGrants,
      }),
      readerAuthority: symposiumReaderAuthorityBridge.authority,
    };
  }

  /** Runtime integration installs a verified session-scoped orchestrator, never config-only admission. */
  function setSymposiumDirectorRuntimeFactory(
    factory: (sessionId: string) => SymposiumOrchestrator | null,
  ): void {
    symposiumRuntimeForSession = factory;
  }
  app.use(
    '/api/symposium/sessions',
    operatorAuthMiddleware,
    createSymposiumSessionRouter({
      store: eventStore,
      profiles: symposiumProfileStore,
      currentAccounts: symposiumAccountProfiles,
      assertVertexDraftAvailable: (binding) => {
        const host = symposiumProductionHost;
        if (!host) throw new Error('Original native Vertex host unavailable');
        const profiles = host.currentProfiles();
        const route = profiles.vertexSandboxRoute(binding);
        const capability = verifySymposiumProductionGate(
          host.runtimeConfig,
          readSymposiumProductionAttestation(host.attestationPath),
          host.physical,
          undefined,
          host.admissionBuildSelection,
        );
        if (!capability.allowedAccountProviders.has('anthropic-vertex'))
          throw new Error('Vertex outside reviewed native host scope');
        assertSymposiumAttestedClaudeProvider(capability, {
          accountId: binding.accountId,
          ...route,
          workspace: host.runtimeConfig.workspace,
        });
      },
      onSessionCreated: (sessionId) => retainedCustodianSessions.add(sessionId),
      ensureSessionArtifacts: async (sessionId) => {
        if (custodianOwnerMode && !retainedCustodianSessions.has(sessionId))
          throw Error('Session was not created by this retained custodian');
        return symposiumProductionHost?.ensureSessionArtifacts?.(sessionId) ?? { state: 'pending' };
      },
    }),
  );
  const symposiumReviewActionAuthority = new SymposiumReviewActionAuthority();
  const symposiumReviewStore = new SymposiumReviewStore(join(workspaceRoot, '.mitzo', 'events.db'));
  app.use(
    '/api/sessions/:id/symposium/access-requests',
    operatorAuthMiddleware,
    createSymposiumAccessRouter(
      symposiumAccessRequests,
      (id) => eventStore.getSession(id)?.sessionType === 'symposium',
    ),
  );
  app.use(
    '/api/sessions/:id/symposium/publication',
    operatorAuthMiddleware,
    createPublicationRouter({
      onPublicationCompleted: (sessionId, publication, operation) =>
        symposiumAccessRequests.publicationCompleted(sessionId, publication, operation),
      registration: () => symposiumPublication,
      hasSession: (id) => eventStore.getSession(id)?.sessionType === 'symposium',
      approval: (req, session, conversationId) => custodianPublicationApproval(req),
    }),
  );
  app.use(
    '/api/sessions/:id/symposium/reviews',
    createSymposiumReviewRouteComposition({
      store: symposiumReviewStore,
      actionAuthority: symposiumReviewActionAuthority,
      currentHost: () => symposiumProductionHost,
      /** Dispose only a never-installed, inactive semantic fixture/service. This
       * is not physical native retirement and cannot authorize another owner. */
      closeUninstalledService() {
        if (
          symposiumProductionHost ||
          symposiumSessionRuntimes.size ||
          retainedCustodianSessions.size ||
          stagingFeatureOwner
        )
          throw Error('Installed original native owner requires actual retirement');
        releaseContextPacks();
        symposiumAccessRequests.close();
        symposiumProfileProposalStore.close();
        symposiumAgentContextStore.close();
        symposiumProfileStore.close();
        symposiumHostGrants.close();
        symposiumReviewStore.close();
        agentLibrary.close();
        codexStore.close();
        eventStore.close();
      },
      runtime: (sessionId) => symposiumRuntimeForSession(sessionId),
      hasSession: (sessionId) => eventStore.getSession(sessionId)?.sessionType === 'symposium',
    }),
  );
  app.use(
    '/api/sessions/:id/symposium/source',
    operatorAuthMiddleware,
    createSymposiumSourceRouter({
      repositories: () => getRepoConfig().repos,
      getSession: (id) => eventStore.getSession(id),
      getHost: () => symposiumProductionHost?.sourceImport,
    }),
  );
  app.use(
    '/api/sessions/:id/symposium',
    operatorAuthMiddleware,
    createSymposiumDirectorRouter({
      store: eventStore,
      artifactReady: (sessionId, seatId, generation) =>
        symposiumProductionHost?.artifactReady?.(sessionId, seatId, generation) ?? true,
      getRuntime: (sessionId) => symposiumRuntimeForSession(sessionId),
      getSafetyOrchestrator: () => symposiumSafetyOrchestrator,
      profileBindingEnforced: true,
      hasOrdinaryRuntime: (sessionId) => {
        // A native service never owns ordinary conversations. Unknown or ordinary
        // persisted sessions cannot be converted through the retained owner.
        return eventStore.getSession(sessionId)?.sessionType !== 'symposium';
      },
      validateSelection: (seat) => {
        if (seat.accountBinding)
          symposiumAccountProfiles().validateModel(
            seat.accountBinding,
            seat.model,
            seat.reasoningEffort,
          );
      },
      validateActiveConfig: (sessionId, config) =>
        symposiumHostGrants.validateActiveConfig(sessionId, config),
      activateDraft: (input) => symposiumHostGrants.activate(input),
      reviseSeat: (input) => symposiumHostGrants.reviseSeat(input),
      getPerspective: (sessionId, perspective, options) =>
        getSymposiumPerspective(eventStore, sessionId, perspective, options),
      getQueuedInputs: (sessionId, perspective) =>
        getSymposiumQueuedInputs(eventStore, sessionId, perspective),
      resolveSelection: (accountId, model, reasoningEffort) => {
        const profiles = symposiumAccountProfiles();
        const binding = profiles.resolve(accountId, model);
        profiles.validateModel(binding, model, reasoningEffort);
        return AccountBindingSchema.parse(binding);
      },
    }),
  );

  const subscriptionLogin = createSubscriptionLoginController(
    () => symposiumProductionHost,
    (_req, res) => (res.locals.authSession as AuthSession | undefined)?.id,
  );
  // Retained owned-host candidate collection; never writes or activates admission.
  app.post(
    '/api/symposium/admission-evidence',
    operatorAuthMiddleware,
    ownedEvidenceHandler(() => symposiumProductionHost?.collectAdmissionEvidence),
  );
  app.post(
    '/api/symposium/sessions/:sessionId/admission-evidence',
    operatorAuthMiddleware,
    sessionOwnedEvidenceHandler(
      () => symposiumProductionHost?.collectSessionAdmissionCandidate,
      (req, res) =>
        sessionEvidenceRequestAuthority(req, res, {
          session: res.locals.authSession as AuthSession | undefined,
          hasSession: (id) =>
            (!custodianOwnerMode || retainedCustodianSessions.has(id)) &&
            eventStore.getSession(id)?.sessionType === 'symposium',
          register: registerAuthSession,
        }),
    ),
  );
  app.use(
    '/api/symposium/personal/connections',
    createSymposiumPersonalConnectionRouter(() => symposiumProductionHost?.personalConnections),
  );
  app.get('/api/symposium/personal/login/status', operatorAuthMiddleware, subscriptionLogin.status);
  app.post('/api/symposium/personal/login', operatorAuthMiddleware, subscriptionLogin.start);
  app.post(
    '/api/symposium/personal/login/cancel',
    operatorAuthMiddleware,
    subscriptionLogin.cancel,
  );

  // Reads the dedicated host catalog (including its cached model discovery); no refresh or legacy fallback.
  app.get('/api/symposium/accounts', (_req, res) => {
    try {
      if (!symposiumProductionHost) throw new Error('Symposium host is unavailable');
      res.json(symposiumProductionHost.currentProfiles().catalog());
    } catch {
      res.status(503).json({ error: 'Symposium account catalog unavailable.' });
    }
  });

  return {
    getSymposiumBootstrapDependencies,
    installSymposiumProductionHost,
    configureStagingNativeFeatureOwner,
    setSymposiumCustodianBroadcast,
    pauseSymposiumController,
    drainSymposiumController,
    resumeSymposiumController,
    hasRetainedCustodianSession,
    beginSymposiumShutdown,
    drainSymposiumRuntimes,
    retireRetainedSymposiumRuntimes,
    installSymposiumReaderAuthority,
    setSymposiumDirectorRuntimeFactory,
    currentHost: () => symposiumProductionHost,
    /** Dispose only a never-installed, inactive semantic fixture/service. This
     * is not physical native retirement and cannot authorize another owner. */
    closeUninstalledService() {
      if (
        symposiumProductionHost ||
        symposiumSessionRuntimes.size ||
        retainedCustodianSessions.size ||
        stagingFeatureOwner
      )
        throw Error('Installed original native owner requires actual retirement');
      releaseContextPacks();
      symposiumAccessRequests.close();
      symposiumProfileProposalStore.close();
      symposiumAgentContextStore.close();
      symposiumProfileStore.close();
      symposiumHostGrants.close();
      symposiumReviewStore.close();
      agentLibrary.close();
      codexStore.close();
      eventStore.close();
    },
    handle: app,
    dispatchCustodianRequest(
      command: CustodianRequest,
      current: () => void,
      approval?: CapabilityApproval,
      signal?: AbortSignal,
    ) {
      current();
      if (
        custodianOwnerMode &&
        command.sessionId &&
        !retainedCustodianSessions.has(command.sessionId)
      )
        throw Error('Session was not created by this original retained custodian');
      return dispatchCustodianHttp(app, command, current, approval, signal);
    },
  };
}
