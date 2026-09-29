import type {
  SymposiumSeatPolicy,
  SymposiumSeatPolicySelector,
} from './symposium-owned-seat-policy.js';
import { REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME } from './symposium-owned-runtime-contract.js';
import {
  SandboxCreationPreflightError,
  type SandboxCreationFence,
} from './symposium-workspace-lifecycle.js';
import { validateOpenShellCliEnvironment } from './openshell-cli-environment.js';
import {
  assertSymposiumAttestedProvider,
  assertSymposiumAttestedClaudeProvider,
  type SymposiumProviderCapability,
} from './symposium-production-gate.js';
import { SymposiumNativeEventSink } from './symposium-native-event-sink.js';
import type { AccountProfiles } from './account-profiles.js';
import { createHash, randomUUID } from 'node:crypto';
import type { CodexConversationStore } from './codex-conversation-store.js';
import { spawnSync } from 'node:child_process';
import type { EventStore } from './event-store.js';
import type { SymposiumSeatSandboxRecord } from '@mitzo/protocol/event-store';
import { createClaudeVertexSeat } from './symposium-claude-native.js';
import {
  acquireSymposiumArtifactLease,
  acquireConfirmedSealedReaderLease,
  artifactDriverConfigForLease,
  type ArtifactLeaseRequest,
  type ArtifactLease,
} from './symposium-artifact-lease.js';
import type { SqliteArtifactLeaseHost } from './symposium-artifact-host.js';
import type { SymposiumAttemptRegistry } from './symposium-attempt-registry.js';
import {
  createSymposiumNativeProfileTools,
  assertSymposiumProfileAttemptCurrent,
} from './symposium-native-profile-tools.js';
import { createSymposiumNativeReviewTool } from './symposium-native-review-tool.js';
import type { SymposiumReviewStore } from './symposium-review-workflows.js';
import type { SymposiumProfileStore } from './symposium-profiles.js';
import type { SymposiumProfileProposalStore } from './symposium-profile-proposals.js';
import { createOpenAiCodexSeat } from './symposium-codex-native.js';
import {
  assertSubscriptionControllerCommand,
  createChatGptSubscriptionSeat,
  resolveSymposiumSubscriptionRoute,
  type VerifySymposiumSubscriptionAuth,
} from './symposium-subscription-native.js';
import {
  SymposiumOpenShellSeatExecutor,
  type SymposiumOpenShellSeatExecutorDeps,
} from './symposium-openshell-seat-executor.js';
import { SymposiumOrchestrator, type SymposiumSeatExecutor } from './symposium-orchestrator.js';
import {
  OpenShellRuntimeManager,
  sandboxNameForConversation,
  type BoundOpenShellRuntimeConfig,
  type OpenShellAccountRoute,
  type OpenShellRuntimeConfig,
} from './openshell-runtime.js';
import {
  admitSymposiumSeatDispatch,
  type SymposiumDispatchFacts,
  type SymposiumHostGrantVerifier,
} from './symposium-seat-runtime.js';

export interface SymposiumPhysicalProviderIdentity {
  name: string;
  id: string;
  type: string;
  workspace: string;
}

export type SymposiumProviderIdentityResolver = (
  name: string,
  id: string,
) => SymposiumPhysicalProviderIdentity;

/** Fresh, read-only gateway inventory. Never logs or retains credential metadata. */
export function createOpenShellProviderIdentityResolver(
  config: Pick<
    OpenShellRuntimeConfig,
    | 'cli'
    | 'gateway'
    | 'gatewayEndpoint'
    | 'gatewayInsecure'
    | 'workspace'
    | 'cliContract'
    | 'cliEnvironment'
  >,
  run?: (args: readonly string[]) => string,
  spawn: typeof spawnSync = spawnSync,
): SymposiumProviderIdentityResolver {
  const args = [
    'provider',
    ...(config.gatewayEndpoint
      ? [
          '--gateway-endpoint',
          config.gatewayEndpoint,
          ...(config.gatewayInsecure ? ['--gateway-insecure'] : []),
        ]
      : ['--gateway', config.gateway]),
    '--workspace',
    config.workspace,
    'list',
    '--output',
    'json',
    ...(config.cliContract === 'v0.1' ? ['--page-size', '100'] : ['--limit', '100']),
  ];
  const invoke =
    run ??
    ((argv: readonly string[]) => {
      const result = spawn(config.cli, [...argv], {
        ...(config.cliEnvironment
          ? { env: validateOpenShellCliEnvironment(config.cliEnvironment) }
          : {}),
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 1_000_000,
      });
      if (result.error || result.status !== 0)
        throw new Error('OpenShell provider inventory is unavailable');
      return result.stdout;
    });
  return (name, id) => {
    let rows: unknown;
    try {
      if (config.cliContract === 'v0.1') {
        const all: unknown[] = [];
        const seen = new Set<string>();
        let token = '';
        do {
          const page = JSON.parse(invoke(token ? [...args, '--page-token', token] : args));
          if (!page || !Array.isArray(page.providers) || typeof page.next_page_token !== 'string')
            throw new Error('invalid page');
          all.push(...page.providers);
          token = page.next_page_token;
          if (token && seen.has(token)) throw new Error('repeated page token');
          if (token) seen.add(token);
        } while (token);
        rows = all;
      } else rows = JSON.parse(invoke(args));
    } catch {
      throw new Error('OpenShell provider inventory is unavailable');
    }
    if (!Array.isArray(rows)) throw new Error('OpenShell provider inventory is invalid');
    const matches = rows.filter(
      (row) => !!row && typeof row === 'object' && (row as Record<string, unknown>).name === name,
    );
    if (matches.length !== 1) throw new Error('OpenShell provider identity is unavailable');
    const row = matches[0] as Record<string, unknown>;
    if (
      row.id !== id ||
      row.workspace !== config.workspace ||
      typeof row.type !== 'string' ||
      !row.type
    )
      throw new Error('OpenShell provider identity changed');
    return { name, id, type: row.type, workspace: config.workspace };
  };
}

export interface SymposiumProviderUnion {
  owner: OpenShellAccountRoute;
  bindings: Array<{ name: string; type: string; id: string }>;
  logicalProviders: string[];
  seatCount: number;
  /** Recompute from durable membership and host grant truth before/after every async attachment. */
  verify(): void;
}

// Retained admission revalidates an already-confirmed generation at a new config
// revision. It never authorizes sandbox attachment or dispatch without admission.
type SeatProviderPhase = 'candidate' | 'retained' | 'reconciling' | 'confirmed';

/** Freeze the exact admitted generation and physical provider inventory for one reconciliation. */
export function snapshotSymposiumProviderUnion(
  sessionId: string,
  facts: SymposiumDispatchFacts,
  profiles: AccountProfiles | (() => AccountProfiles),
  hostGrants: SymposiumHostGrantVerifier,
  resolveProviderIdentity: SymposiumProviderIdentityResolver,
  workspace: string,
  phase: SeatProviderPhase = 'confirmed',
): SymposiumProviderUnion {
  const collect = () => {
    const currentProfiles = typeof profiles === 'function' ? profiles() : profiles;
    const config = facts.getActiveSymposiumConfig(sessionId);
    if (config.version !== 2 || config.state !== 'active')
      throw new Error('Shared native runtime requires active Symposium v2');
    const admitted: Array<{
      seatId: string;
      generation: number;
      accountId: string;
      profileRevision: string;
      provider: string;
      name: string;
      id: string;
      type: string;
      model: string;
      account: OpenShellAccountRoute;
    }> = [];
    for (const seat of config.seats) {
      const membership = facts.getLatestSymposiumMembership(sessionId, seat.id);
      if (membership?.state !== 'active') continue;
      if (phase === 'retained' && membership.reconciliation !== 'confirmed')
        throw new Error('Retained Symposium seat membership is not confirmed');
      const binding = seat.accountBinding;
      if (!binding) throw new Error('Active Symposium seat lacks account binding');
      const latestAdmission = facts.getLatestSymposiumAdmission(
        sessionId,
        seat.id,
        config.revision,
      );
      // Restore creates a new pending generation without advancing the config.
      // A prior generation's admission cannot authorize it, but must not block
      // inspection of the new candidate before host admission is recorded.
      const admission =
        phase === 'candidate' && latestAdmission?.membershipGeneration !== membership.generation
          ? null
          : latestAdmission;
      if (
        (phase !== 'candidate' && phase !== 'retained' && admission?.decision !== 'admitted') ||
        (admission != null &&
          (admission.decision !== 'admitted' ||
            admission.membershipGeneration !== membership.generation ||
            admission.accountId !== binding.accountId ||
            admission.provider !== binding.provider ||
            admission.model !== binding.model ||
            admission.accountProfileRevision !== binding.profileRevision))
      )
        throw new Error('Active Symposium seat lacks current provider admission');
      hostGrants.verifySeat({ sessionId, seat, membershipGeneration: membership.generation });
      currentProfiles.resume(binding);
      let name: string;
      let id: string;
      let account: OpenShellAccountRoute;
      if (binding.provider === 'openai') {
        const route = currentProfiles.apiProfile(binding);
        if (!route.sandboxProvider || !route.sandboxProviderId)
          throw new Error('OpenAI seat lacks physical provider binding');
        name = route.sandboxProvider;
        id = route.sandboxProviderId;
        account = { kind: 'api', provider: name, model: binding.model };
      } else if (binding.provider === 'openai-codex') {
        const { profile: route } = resolveSymposiumSubscriptionRoute(currentProfiles, binding);
        name = route.sandboxProvider!;
        id = route.sandboxProviderId!;
        account = {
          kind: 'chatgpt-subscription-native',
          provider: name,
          providerId: id,
          providerType: 'codex',
          model: binding.model,
        };
      } else if (binding.provider === 'anthropic-vertex') {
        const route = currentProfiles.vertexSandboxRoute(binding);
        name = route.provider;
        id = route.providerId;
        account = { kind: 'api', provider: name, model: binding.model };
      } else {
        throw new Error('Shared native runtime does not support this account provider');
      }
      const physical = resolveProviderIdentity(name, id);
      if (
        physical.name !== name ||
        physical.id !== id ||
        physical.workspace !== workspace ||
        !physical.type
      )
        throw new Error('OpenShell physical provider identity changed');
      const expectedType =
        binding.provider === 'anthropic-vertex'
          ? 'google-vertex-ai'
          : binding.provider === 'openai-codex'
            ? 'codex'
            : 'openai';
      if (physical.type !== expectedType)
        throw new Error('OpenShell physical provider type does not match Symposium account');
      admitted.push({
        seatId: seat.id,
        generation: membership.generation,
        accountId: binding.accountId,
        profileRevision: binding.profileRevision,
        provider: binding.provider,
        name,
        id,
        type: physical.type,
        model: binding.model,
        account,
      });
    }
    const anchor = admitted.find((entry) => entry.seatId === config.anchorSeatId);
    if (!anchor) throw new Error('Shared sandbox anchor is not admitted');
    const sameName = new Map<string, (typeof admitted)[number]>();
    for (const entry of admitted) {
      const prior = sameName.get(entry.name);
      if (prior && (prior.id !== entry.id || prior.accountId !== entry.accountId))
        throw new Error('Distinct Symposium accounts cannot share one provider binding');
      sameName.set(entry.name, entry);
    }
    const ordered = [anchor, ...admitted.filter((entry) => entry !== anchor)].filter(
      (entry, index, all) => all.findIndex((candidate) => candidate.name === entry.name) === index,
    );
    return {
      owner: anchor.account,
      bindings: ordered.map(({ name, type, id }) => ({ name, type, id })),
      logicalProviders: [...new Set(admitted.map((entry) => entry.provider))].sort(),
      seatCount: admitted.length,
      fingerprint: JSON.stringify([config.revision, config.anchorSeatId, admitted]),
    };
  };
  const snapshot = collect();
  return {
    owner: snapshot.owner,
    bindings: snapshot.bindings,
    logicalProviders: snapshot.logicalProviders,
    seatCount: snapshot.seatCount,
    verify: () => {
      if (collect().fingerprint !== snapshot.fingerprint)
        throw new Error('Symposium provider union changed during reconciliation');
    },
  };
}

export interface SymposiumSharedSandboxOwnerDeps {
  resolveSeatPolicy?: SymposiumSeatPolicySelector;
  runSandboxCreation?: SandboxCreationFence;
  sessionId: string;
  facts: SymposiumDispatchFacts;
  profiles: AccountProfiles;
  /** Refresh account binding truth at every admission and async reconciliation boundary. */
  currentProfiles?: () => AccountProfiles;
  hostGrants: SymposiumHostGrantVerifier;
  resolveProviderIdentity: SymposiumProviderIdentityResolver;
  runtimeConfig: OpenShellRuntimeConfig;
  readOnlyEnforced: { openaiApi: boolean; claudeVertex: boolean; chatgptSubscription?: boolean };
  verifyHostCapability?: () => SymposiumProviderCapability;
  verifiedSubscriptionControllerCommand?: readonly string[];
  verifySubscriptionPrivateAuth?: VerifySymposiumSubscriptionAuth;
  assertSubscriptionDispatch?: (input: Parameters<VerifySymposiumSubscriptionAuth>[0]) => void;
  managerFactory?: (config: BoundOpenShellRuntimeConfig) => {
    ensure(
      sessionId: string,
      signal: AbortSignal,
      expected?: { sandboxName: string; sandboxId: string },
    ): Promise<{ sandboxName: string; sandboxId?: string; workdir: string }>;
    inspect?(
      runtimeId: string,
      physicalId: string,
      signal: AbortSignal,
    ): Promise<{ id: string; phase: string } | undefined>;
    inspectReserved?(
      runtimeId: string,
      signal: AbortSignal,
    ): Promise<{ id: string; name: string; phase: string } | undefined>;
    stop?(runtimeId: string, physicalId: string, signal: AbortSignal): Promise<void>;
    delete?(runtimeId: string, physicalId: string, signal: AbortSignal): Promise<void>;
  };
}

function verifyClaudeSeatCapability(
  deps: Pick<
    SymposiumSharedSandboxOwnerDeps,
    'facts' | 'profiles' | 'currentProfiles' | 'runtimeConfig'
  >,
  sessionId: string,
  seatId: string,
  capability: SymposiumProviderCapability | undefined,
): void {
  const seat = deps.facts
    .getActiveSymposiumConfig(sessionId)
    .seats.find((candidate) => candidate.id === seatId);
  const binding = seat?.accountBinding;
  if (binding?.provider !== 'anthropic-vertex') return;
  if (deps.runtimeConfig.image !== REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME.build.image)
    throw new Error('Claude native image is outside the reviewed contract');
  const route = (deps.currentProfiles?.() ?? deps.profiles).vertexSandboxRoute(binding);
  assertSymposiumAttestedClaudeProvider(capability, {
    ...route,
    accountId: binding.accountId,
    model: binding.model,
    workspace: deps.runtimeConfig.workspace,
  });
}

function assertNativeSubscriptionCapability(
  deps: Pick<
    SymposiumSharedSandboxOwnerDeps,
    'verifiedSubscriptionControllerCommand' | 'verifySubscriptionPrivateAuth'
  >,
): void {
  if (
    !deps.verifiedSubscriptionControllerCommand ||
    typeof deps.verifySubscriptionPrivateAuth !== 'function'
  )
    throw new Error(
      'Personal ChatGPT native launcher and private credential proof are unavailable',
    );
  assertSubscriptionControllerCommand(deps.verifiedSubscriptionControllerCommand);
}

type SeatSandboxRegistry = Pick<
  EventStore,
  | 'claimSymposiumSeatLifecycle'
  | 'releaseSymposiumSeatLifecycle'
  | 'reserveSymposiumSeatSandbox'
  | 'markSymposiumSeatSandboxCreationStarted'
  | 'rollbackUndispatchedSymposiumSeatCreation'
  | 'markSymposiumSeatSandboxCreationCompleted'
  | 'confirmSymposiumSeatSandbox'
  | 'getSymposiumSeatSandbox'
  | 'listUnstoppedSymposiumSeatSandboxes'
  | 'confirmSymposiumSeatSandboxStopped'
  | 'confirmAbsentSymposiumSeatSandboxStopped'
> &
  Partial<
    Pick<
      EventStore,
      'recordSymposiumSeatSandboxTerminalCreate' | 'recordSymposiumSeatCreationDiagnostic'
    >
  >;

/** One owner serializes all seat/provider mutations for the shared session sandbox. */
export class SymposiumSharedSandboxOwner {
  readonly readOnlyEnforced: {
    openaiApi: boolean;
    claudeVertex: boolean;
    chatgptSubscription?: boolean;
  };
  private tail: Promise<void> = Promise.resolve();

  constructor(private deps: SymposiumSharedSandboxOwnerDeps) {
    this.readOnlyEnforced = deps.readOnlyEnforced;
    if (deps.readOnlyEnforced.claudeVertex)
      throw new Error('Claude native read-only wrapper has not been verified');
    if (
      deps.runtimeConfig.serviceProviders.length ||
      deps.runtimeConfig.grantableServiceProviders.length
    )
      throw new Error('Symposium service provider grants require a separate shared-scope review');
  }

  ensure(sessionId: string, signal: AbortSignal) {
    if (sessionId !== this.deps.sessionId)
      throw new Error('Shared sandbox owner belongs to another Symposium session');
    const work = this.tail.then(async () => {
      signal.throwIfAborted();
      const snapshot = snapshotSymposiumProviderUnion(
        sessionId,
        this.deps.facts,
        this.deps.currentProfiles ?? this.deps.profiles,
        this.deps.hostGrants,
        this.deps.resolveProviderIdentity,
        this.deps.runtimeConfig.workspace,
      );
      if (snapshot.logicalProviders.includes('openai-codex'))
        throw new Error('Personal ChatGPT requires an isolated per-seat sandbox');
      if (snapshot.logicalProviders.includes('anthropic-vertex'))
        throw new Error(
          'Private Claude seat state isolation is not verified in the shared sandbox',
        );
      // Gateway provider placeholders are sandbox-wide. A host-pinned route
      // cannot stop one native process from using another seat's provider.
      if (snapshot.seatCount > 1)
        throw new Error(
          'Private native seat state isolation is not verified in the shared sandbox',
        );
      const manager = (
        this.deps.managerFactory ?? ((config) => new OpenShellRuntimeManager(config))
      )({
        ...this.deps.runtimeConfig,
        account: snapshot.owner,
        accountProviderBindings: snapshot.bindings,
        verifyAccountProviderUnion: snapshot.verify,
      });
      const sandbox = await manager.ensure(sessionId, signal);
      snapshot.verify();
      return sandbox;
    });
    this.tail = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }
}

/** Exact, current-generation provider binding for one isolated seat sandbox. */
export function snapshotSymposiumSeatProvider(
  sessionId: string,
  seatId: string,
  facts: SymposiumDispatchFacts,
  profiles: AccountProfiles | (() => AccountProfiles),
  hostGrants: SymposiumHostGrantVerifier,
  resolveProviderIdentity: SymposiumProviderIdentityResolver,
  workspace: string,
  phase: SeatProviderPhase = 'confirmed',
) {
  const read = () => {
    const config = facts.getActiveSymposiumConfig(sessionId);
    if (config.version !== 2 || config.state !== 'active')
      throw new Error('Seat sandbox requires active Symposium v2');
    const seat = config.seats.find((candidate) => candidate.id === seatId);
    if (!seat) throw new Error('Symposium seat is no longer configured');
    const membership = facts.getLatestSymposiumMembership(sessionId, seatId);
    if (
      membership?.state !== 'active' ||
      ((phase === 'confirmed' || phase === 'retained') &&
        membership.reconciliation !== 'confirmed') ||
      (phase === 'candidate' && membership.reconciliation !== 'pending') ||
      (phase === 'reconciling' &&
        membership.reconciliation !== 'pending' &&
        membership.reconciliation !== 'confirmed')
    )
      throw new Error('Symposium seat membership is not confirmed');
    const narrowedFacts: SymposiumDispatchFacts = {
      assertSymposiumArtifactWorkAllowed: (...args) =>
        facts.assertSymposiumArtifactWorkAllowed(...args),
      getActiveSymposiumConfig: () => ({ ...config, seats: [seat], anchorSeatId: seatId }),
      getLatestSymposiumMembership: (...args) => facts.getLatestSymposiumMembership(...args),
      getLatestSymposiumAdmission: (...args) => facts.getLatestSymposiumAdmission(...args),
      getSymposiumDelivery: (...args) => facts.getSymposiumDelivery(...args),
    };
    const union = snapshotSymposiumProviderUnion(
      sessionId,
      narrowedFacts,
      profiles,
      hostGrants,
      resolveProviderIdentity,
      workspace,
      phase,
    );
    const identity = JSON.stringify([
      sessionId,
      seatId,
      membership.generation,
      // A new config revision can leave this active membership and its seat
      // binding intact. Keep the physical sandbox identity stable in that case;
      // the full seat and physical provider still fence material changes.
      seat,
      union.bindings,
    ]);
    return { union, identity, generation: membership.generation };
  };
  const snapshot = read();
  const runtimeId = `symposium-seat:${createHash('sha256').update(snapshot.identity).digest('hex')}`;
  return {
    runtimeId,
    generation: snapshot.generation,
    account: snapshot.union.owner,
    bindings: snapshot.union.bindings,
    logicalProvider: snapshot.union.logicalProviders[0],
    verify: () => {
      const current = read();
      current.union.verify();
      if (current.identity !== snapshot.identity)
        throw new Error('Symposium seat provider changed during reconciliation');
    },
  };
}

/** Isolated sandbox per active seat; no credential is attached for another seat. */
export class SymposiumPerSeatSandboxOwner {
  private seatPolicies = new Map<
    string,
    { policy: SymposiumSeatPolicy; sandboxName: string; sandboxId: string }
  >();
  verifySeatPolicy(sessionId: string, seatId: string): void {
    if (sessionId !== this.deps.sessionId) throw new Error('Seat policy session changed');
    const policy = this.seatPolicies.get(seatId);
    if (!policy) throw new Error('Owned Vertex seat policy unavailable');
    policy.policy.verifyInstalled(policy);
  }
  /** Same-owner terminal proof for cleanup only; never restored from inventories/restart. */
  private readonly terminalCreates = new Map<
    string,
    { sandboxName: string; sandboxId: string; lease?: ArtifactLease }
  >();
  readonly readOnlyEnforced: {
    openaiApi: boolean;
    claudeVertex: boolean;
    chatgptSubscription?: boolean;
  };
  private tails = new Map<string, Promise<void>>();

  private async withDurableSeatFence<T>(
    sessionId: string,
    seatId: string,
    signal: AbortSignal,
    operation: (fenceToken: string) => Promise<T>,
  ): Promise<T> {
    const registry = this.deps.seatSandboxRegistry!;
    const token = randomUUID();
    const deadline = Date.now() + 10_000;
    while (!registry.claimSymposiumSeatLifecycle(sessionId, seatId, token)) {
      signal.throwIfAborted();
      if (Date.now() >= deadline)
        throw new Error('Symposium seat lifecycle fence requires reconciliation');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, 25);
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('Seat lifecycle aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }
    try {
      signal.throwIfAborted();
      return await operation(token);
    } finally {
      registry.releaseSymposiumSeatLifecycle(sessionId, seatId, token);
    }
  }

  constructor(
    private deps: SymposiumSharedSandboxOwnerDeps & {
      perSeatSandboxVerified?: boolean;
      seatSandboxRegistry?: SeatSandboxRegistry;
      /** Host-selected immutable volume and access for this admitted seat. */
      artifactRequest?: (
        sessionId: string,
        seatId: string,
        generation: number,
        purpose?: 'admission' | 'cleanup',
      ) => ArtifactLeaseRequest;
      artifactLeaseHost?: SqliteArtifactLeaseHost;
      artifactReferenceStore?: EventStore;
    },
  ) {
    this.readOnlyEnforced = deps.readOnlyEnforced;
    if (deps.perSeatSandboxVerified && deps.runtimeConfig.cliContract !== 'v0.1')
      throw new Error('Verified seat sandboxes require the OpenShell 0.1 CLI contract');
    if (deps.perSeatSandboxVerified && !deps.seatSandboxRegistry)
      throw new Error('Verified seat sandboxes require a durable lifecycle registry');
    if (Boolean(deps.artifactRequest) !== Boolean(deps.artifactLeaseHost))
      throw new Error('Artifact request and durable lease host must be configured together');
    if (
      deps.readOnlyEnforced.claudeVertex &&
      (!deps.perSeatSandboxVerified ||
        deps.runtimeConfig.image !== REVIEWED_SYMPOSIUM_CLAUDE_RUNTIME.build.image ||
        !deps.verifyHostCapability?.().claudeProviders?.size)
    )
      throw new Error('Claude native read-only wrapper has not been verified');
    if (
      deps.runtimeConfig.serviceProviders.length ||
      deps.runtimeConfig.grantableServiceProviders.length
    )
      throw new Error('Symposium service provider grants require seat-scoped review');
  }

  ensure(sessionId: string, seatId: string, signal: AbortSignal) {
    const transportRoute = {
      cli: this.deps.runtimeConfig.cli,
      gateway: this.deps.runtimeConfig.gateway,
      workspace: this.deps.runtimeConfig.workspace,
      gatewayEndpoint: this.deps.runtimeConfig.gatewayEndpoint,
      gatewayInsecure: this.deps.runtimeConfig.gatewayInsecure,
      ...(this.deps.runtimeConfig.cliEnvironment
        ? { cliEnvironment: this.deps.runtimeConfig.cliEnvironment }
        : {}),
    };
    if (sessionId !== this.deps.sessionId)
      throw new Error('Seat sandbox owner belongs to another Symposium session');
    if (!this.deps.perSeatSandboxVerified)
      throw new Error('OpenShell per-seat sandbox capability is not verified');
    const prior = this.tails.get(seatId) ?? Promise.resolve();
    const work = prior.then(() =>
      this.withDurableSeatFence(sessionId, seatId, signal, async (fenceToken) => {
        signal.throwIfAborted();
        const snapshot = snapshotSymposiumSeatProvider(
          sessionId,
          seatId,
          this.deps.facts,
          this.deps.currentProfiles ?? this.deps.profiles,
          this.deps.hostGrants,
          this.deps.resolveProviderIdentity,
          this.deps.runtimeConfig.workspace,
          'reconciling',
        );
        if (snapshot.account.kind === 'chatgpt-subscription-native')
          assertNativeSubscriptionCapability(this.deps);
        const binding = snapshot.bindings[0];
        const seatPolicy = this.deps.resolveSeatPolicy?.({
          sessionId,
          seatId,
          generation: snapshot.generation,
        });
        if (binding.type === 'google-vertex-ai' && !seatPolicy)
          throw new Error('Owned Vertex seat policy unavailable');
        const verifySeatCapability = () => {
          seatPolicy?.verify();
          const capability = this.deps.verifyHostCapability?.();
          verifyClaudeSeatCapability(this.deps, sessionId, seatId, capability);
          if (capability)
            assertSymposiumAttestedProvider(capability, {
              ...binding,
              workspace: this.deps.runtimeConfig.workspace,
            });
        };
        // A queued ensure may run long after admission or provider reconciliation.
        verifySeatCapability();
        const reservation = this.deps.seatSandboxRegistry!.reserveSymposiumSeatSandbox({
          sessionId,
          seatId,
          generation: snapshot.generation,
          runtimeId: snapshot.runtimeId,
          workspace: this.deps.runtimeConfig.workspace,
          providerName: binding.name,
          providerId: binding.id,
          providerType: binding.type,
          model: snapshot.account.model,
        });
        if (reservation.state === 'reserved' && reservation.physicalId)
          throw new Error('Created seat configuration incomplete; explicit cleanup required');
        const artifactRequest = this.deps.artifactRequest?.(sessionId, seatId, snapshot.generation);
        if (
          artifactRequest &&
          (artifactRequest.sessionId !== sessionId ||
            artifactRequest.seatId !== seatId ||
            artifactRequest.workspaceId !== this.deps.runtimeConfig.workspace)
        )
          throw new Error('Artifact request does not match admitted seat and workspace');
        // Reuse must retain its original bound lease. Creating a replacement here
        // would block stop recovery after a prior release committed before lifecycle cleanup.
        if (
          reservation.state === 'ready' &&
          (!reservation.creationCompleted || !reservation.physicalId || !reservation.sandboxName)
        )
          throw new Error('Recorded seat sandbox requires reconciliation');
        const lease = artifactRequest
          ? reservation.state === 'ready'
            ? await this.deps.artifactLeaseHost!.requireBoundSandboxLease(
                artifactRequest,
                reservation.sandboxName!,
                reservation.physicalId!,
              )
            : artifactRequest.readerAdmissionId
              ? await (async () => {
                  const reference = this.deps.artifactReferenceStore?.getSymposiumArtifactReference(
                    sessionId,
                    seatId,
                    snapshot.generation,
                  );
                  if (
                    !reference ||
                    !('kind' in reference) ||
                    reference.kind !== 'sealed_reader' ||
                    reference.readerAdmissionId !== artifactRequest.readerAdmissionId ||
                    reference.artifactGenerationId !== artifactRequest.volumeGeneration
                  )
                    throw new Error('Current confirmed sealed reader reference required');
                  return acquireConfirmedSealedReaderLease(
                    this.deps.artifactLeaseHost!,
                    this.deps.artifactReferenceStore!,
                    sessionId,
                    reference,
                  );
                })()
              : await acquireSymposiumArtifactLease(this.deps.artifactLeaseHost!, artifactRequest)
          : undefined;
        const artifactDriverConfig = lease
          ? await artifactDriverConfigForLease(this.deps.artifactLeaseHost!, lease)
          : undefined;
        snapshot.verify();
        let physicalDispatch: (() => void) | undefined;
        let terminalSettled: (() => void) | undefined;
        let creationPhase: 'create' | 'upload' | 'provider' | 'mount' = 'provider';
        const diagnostic = (failed: boolean) =>
          this.deps.seatSandboxRegistry!.recordSymposiumSeatCreationDiagnostic?.({
            sessionId,
            seatId,
            generation: snapshot.generation,
            runtimeId: snapshot.runtimeId,
            phase: creationPhase,
            failed,
          });
        const manager = (
          this.deps.managerFactory ?? ((config) => new OpenShellRuntimeManager(config))
        )({
          ...this.deps.runtimeConfig,
          ...(seatPolicy ? { policy: seatPolicy.path } : {}),
          ...(this.deps.runSandboxCreation
            ? {
                beforeSandboxCreate: () => {
                  if (!physicalDispatch) throw new Error('Missing sandbox dispatch fence');
                  physicalDispatch();
                },
              }
            : {}),
          ...(this.deps.runSandboxCreation &&
          this.deps.runtimeConfig.cliContract === 'v0.1' &&
          ['chatgpt-subscription-native', 'api'].includes(snapshot.account.kind) &&
          this.deps.seatSandboxRegistry!.recordSymposiumSeatSandboxTerminalCreate
            ? {
                onSandboxCreationPhase: (phase) => {
                  creationPhase = phase;
                  diagnostic(false);
                },
                onSandboxCreateSettled: (receipt) => {
                  if (!terminalSettled) throw new Error('Missing terminal create fence');
                  if (
                    receipt.workspace !== this.deps.runtimeConfig.workspace ||
                    receipt.accountProvider !== snapshot.account.provider
                  )
                    throw new Error('Terminal create receipt binding changed');
                  const identity = {
                    sandboxName: receipt.sandboxName,
                    sandboxId: receipt.sandboxId,
                  };
                  this.deps.seatSandboxRegistry!.recordSymposiumSeatSandboxTerminalCreate!({
                    sessionId,
                    seatId,
                    generation: snapshot.generation,
                    runtimeId: snapshot.runtimeId,
                    sandboxName: receipt.sandboxName,
                    physicalId: receipt.sandboxId,
                  });
                  terminalSettled();
                  this.terminalCreates.set(snapshot.runtimeId, {
                    ...identity,
                    ...(lease ? { lease: structuredClone(lease) } : {}),
                  });
                  // Successful native creation is settled before any lease postcheck.
                  // A failed binding retains the original lease for explicit cleanup.
                  if (lease)
                    this.deps.artifactLeaseHost!.bindSandbox(
                      lease.token,
                      lease.revision,
                      receipt.sandboxName,
                      receipt.sandboxId,
                    );
                },
              }
            : {}),
          account: snapshot.account,
          accountProviderBindings: snapshot.bindings,
          verifyAccountProviderUnion: () => {
            verifySeatCapability();
            snapshot.verify();
          },
          ...(artifactDriverConfig
            ? {
                artifactDriverConfig,
                verifyArtifactMount: (name, id, config) =>
                  this.deps.artifactLeaseHost!.verifyPhysicalMount(name, id, config),
              }
            : {}),
        });
        verifySeatCapability();
        if (reservation.state === 'ready') {
          if (
            !reservation.creationCompleted ||
            !reservation.physicalId ||
            !reservation.sandboxName ||
            !manager.inspect
          )
            throw new Error('Recorded seat sandbox requires reconciliation');
          const observed = await manager.inspect(
            snapshot.runtimeId,
            reservation.physicalId,
            signal,
          );
          if (!observed || observed.phase !== 'Ready' || observed.id !== reservation.physicalId)
            throw new Error('Recorded seat sandbox is not Ready');
          // Ready lifecycle metadata does not attest the current provider attachments.
          const sandbox = await manager.ensure(snapshot.runtimeId, signal, {
            sandboxName: reservation.sandboxName,
            sandboxId: reservation.physicalId,
          });
          if (
            sandbox.sandboxId !== reservation.physicalId ||
            sandbox.sandboxName !== reservation.sandboxName
          )
            throw new Error('Recorded seat sandbox physical identity changed');
          if (lease) {
            await this.deps.artifactLeaseHost!.verifyPhysicalMount(
              reservation.sandboxName,
              reservation.physicalId,
              artifactDriverConfig!,
            );
          }
          if (seatPolicy) {
            seatPolicy.verifyInstalled({
              sandboxName: reservation.sandboxName,
              sandboxId: reservation.physicalId,
            });
            this.seatPolicies.set(seatId, {
              policy: seatPolicy,
              sandboxName: reservation.sandboxName,
              sandboxId: reservation.physicalId,
            });
          }
          snapshot.verify();
          return {
            ...transportRoute,
            sandboxName: reservation.sandboxName,
            sandboxId: reservation.physicalId,
            workdir: this.deps.runtimeConfig.workdir,
          };
        }
        signal.throwIfAborted();
        verifySeatCapability();
        snapshot.verify();
        const markCreationStarted = () => {
          if (lease) {
            // This durable write precedes every possible gateway create. A crash
            // after it leaves an unbound lease closed until explicit reconciliation.
            this.deps.artifactLeaseHost!.markCreationStarted(
              lease.token,
              lease.revision,
              sandboxNameForConversation(
                snapshot.runtimeId,
                this.deps.runtimeConfig.sandboxIdLength,
              ),
            );
          }
          this.deps.seatSandboxRegistry!.markSymposiumSeatSandboxCreationStarted({
            sessionId,
            seatId,
            generation: snapshot.generation,
            runtimeId: snapshot.runtimeId,
          });
        };
        const create = async (markDispatched?: () => void, markSettled?: () => void) => {
          terminalSettled = markSettled;
          let started = false;
          physicalDispatch = () => {
            if (started) throw new Error('Seat creation dispatch already recorded');
            let localMarkersComplete = false;
            try {
              markCreationStarted();
              localMarkersComplete = true;
              markDispatched?.();
            } catch (error) {
              if (localMarkersComplete && !(error instanceof SandboxCreationPreflightError))
                throw error;
              // Only local write rejection or the retained fence's explicit pre-write
              // proof permits rollback. A failed uncertainty write stays quarantined.
              this.deps.seatSandboxRegistry!.rollbackUndispatchedSymposiumSeatCreation({
                sessionId,
                seatId,
                generation: snapshot.generation,
                runtimeId: snapshot.runtimeId,
                fenceToken,
              });
              if (lease)
                this.deps.artifactLeaseHost!.rollbackUndispatchedCreation(
                  lease.token,
                  lease.revision,
                  sandboxNameForConversation(
                    snapshot.runtimeId,
                    this.deps.runtimeConfig.sandboxIdLength,
                  ),
                );
              throw error;
            }
            started = true;
          };
          if (!this.deps.runSandboxCreation) physicalDispatch();
          let created;
          try {
            diagnostic(false);
            created = await manager.ensure(snapshot.runtimeId, signal);
          } catch (error) {
            diagnostic(true);
            throw error;
          }
          if (!started) throw new Error('Seat creation did not record external dispatch');
          if (!created.sandboxId)
            throw new Error('OpenShell seat sandbox has no physical identity');
          return created;
        };
        const verifyBeforeCreate = () => {
          signal.throwIfAborted();
          verifySeatCapability();
          snapshot.verify();
        };
        const sandbox = this.deps.runSandboxCreation
          ? await this.deps.runSandboxCreation(verifyBeforeCreate, create)
          : await create();
        if (!sandbox.sandboxId) throw new Error('OpenShell seat sandbox has no physical identity');
        if (lease) {
          creationPhase = 'mount';
          try {
            // A custom manager must attest the mount too. Duplicate attestation is
            // intentional; the host is the authoritative physical verifier.
            await this.deps.artifactLeaseHost!.verifyPhysicalMount(
              sandbox.sandboxName,
              sandbox.sandboxId,
              artifactDriverConfig!,
            );
            this.deps.artifactLeaseHost!.bindSandbox(
              lease.token,
              lease.revision,
              sandbox.sandboxName,
              sandbox.sandboxId,
            );
          } catch (error) {
            diagnostic(true);
            throw error;
          }
        }
        if (seatPolicy) {
          creationPhase = 'provider';
          diagnostic(false);
          try {
            seatPolicy.verifyInstalled(
              { sandboxName: sandbox.sandboxName, sandboxId: sandbox.sandboxId },
              true,
            );
          } catch (error) {
            diagnostic(true);
            throw error;
          }
          this.seatPolicies.set(seatId, {
            policy: seatPolicy,
            sandboxName: sandbox.sandboxName,
            sandboxId: sandbox.sandboxId,
          });
        }
        this.deps.seatSandboxRegistry!.confirmSymposiumSeatSandbox({
          sessionId,
          seatId,
          generation: snapshot.generation,
          runtimeId: snapshot.runtimeId,
          sandboxName: sandbox.sandboxName,
          physicalId: sandbox.sandboxId,
        });
        if (!this.terminalCreates.has(snapshot.runtimeId))
          this.deps.seatSandboxRegistry!.markSymposiumSeatSandboxCreationCompleted({
            sessionId,
            seatId,
            generation: snapshot.generation,
            runtimeId: snapshot.runtimeId,
            physicalId: sandbox.sandboxId,
          });
        // A revocation during gateway creation leaves the exact physical ID
        // retained in the registry for the waiting stop operation.
        snapshot.verify();
        return { ...sandbox, ...transportRoute };
      }),
    );
    const tail = work.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(seatId, tail);
    void tail.then(() => {
      if (this.tails.get(seatId) === tail) this.tails.delete(seatId);
    });
    return work;
  }

  creationDiagnostic(seatId: string) {
    const member = this.deps.facts.getLatestSymposiumMembership(this.deps.sessionId, seatId);
    if (!member) return null;
    const record = this.deps.seatSandboxRegistry!.getSymposiumSeatSandbox(
      this.deps.sessionId,
      seatId,
      member.generation,
    );
    if (!record?.creationFailureCode || !['reserved', 'stopped'].includes(record.state))
      return null;
    let canCleanup = false;
    try {
      this.assertCreationCleanup(seatId, member.generation);
      canCleanup = true;
    } catch {
      /* Retained metadata does not establish current host custody. */
    }
    return {
      phase: record.creationPhase ?? 'create',
      code: record.creationFailureCode,
      canCleanup,
    };
  }
  assertCreationCleanup(seatId: string, generation: number) {
    this.deps.verifyHostCapability?.();
    const record = this.deps.seatSandboxRegistry!.getSymposiumSeatSandbox(
      this.deps.sessionId,
      seatId,
      generation,
    );
    const retained = record && this.terminalCreates.get(record.runtimeId);
    if (
      !record ||
      !retained ||
      retained.sandboxId !== record.physicalId ||
      retained.sandboxName !== record.sandboxName ||
      !record.creationCompleted ||
      !record.creationFailureCode ||
      !['reserved', 'stopped'].includes(record.state)
    )
      throw new Error('Retained exact failed creation receipt unavailable');
  }

  /** Stop exactly the retained physical sandboxes, including a prior generation after revocation. */
  stop(sessionId: string, seatId: string, generation: number, signal: AbortSignal): Promise<void> {
    if (sessionId !== this.deps.sessionId)
      throw new Error('Seat sandbox owner belongs to another Symposium session');
    if (!this.deps.perSeatSandboxVerified)
      throw new Error('OpenShell per-seat sandbox capability is not verified');
    const prior = this.tails.get(seatId) ?? Promise.resolve();
    const work = prior.then(() =>
      this.withDurableSeatFence(sessionId, seatId, signal, async () => {
        for (const original of this.deps.seatSandboxRegistry!.listUnstoppedSymposiumSeatSandboxes(
          sessionId,
          seatId,
        )) {
          if (original.generation > generation) continue;
          let record: SymposiumSeatSandboxRecord = original;
          if (record.state === 'reserved' && record.creationCompleted && record.physicalId) {
            const terminal = this.terminalCreates.get(record.runtimeId);
            if (
              !terminal ||
              terminal.sandboxId !== record.physicalId ||
              terminal.sandboxName !== record.sandboxName
            )
              throw new Error(
                'Incomplete seat cleanup requires retained terminal creation custody',
              );
          }
          if (record.workspace !== this.deps.runtimeConfig.workspace)
            throw new Error('Seat sandbox workspace changed before stop');
          const retained = this.terminalCreates.get(record.runtimeId);
          if (record.state === 'reserved' && retained?.lease && this.deps.artifactLeaseHost) {
            const request = this.deps.artifactRequest?.(
              sessionId,
              seatId,
              record.generation,
              'cleanup',
            );
            if (!request || JSON.stringify(request) !== JSON.stringify(retained.lease.request))
              throw new Error('Retained artifact cleanup request changed');
            this.deps.artifactLeaseHost.bindRetainedSandboxForCleanup(
              retained.lease,
              retained.sandboxName,
              retained.sandboxId,
            );
          }

          const manager = (
            this.deps.managerFactory ?? ((config) => new OpenShellRuntimeManager(config))
          )({
            ...this.deps.runtimeConfig,
            account: { kind: 'api', provider: record.providerName, model: record.model },
            accountProviderBindings: [
              { name: record.providerName, type: record.providerType, id: record.providerId },
            ],
            verifyAccountProviderUnion: () => undefined,
          });
          if (!manager.inspect || !manager.inspectReserved || !manager.stop)
            throw new Error('OpenShell seat sandbox lifecycle interface is unavailable');
          let physicalId = record.physicalId;
          if (!physicalId) {
            const discovered = await manager.inspectReserved(record.runtimeId, signal);
            if (!discovered) {
              if (record.creationStarted)
                throw new Error(
                  'Seat sandbox creation may still complete; reconciliation required',
                );
              if (this.deps.artifactLeaseHost) {
                if (!this.deps.artifactRequest)
                  throw new Error('Artifact lease request is unavailable');
                const request = this.deps.artifactRequest(
                  sessionId,
                  seatId,
                  record.generation,
                  'cleanup',
                );
                if (
                  request.sessionId !== sessionId ||
                  request.seatId !== seatId ||
                  request.workspaceId !== record.workspace
                )
                  throw new Error(
                    'Artifact lease request changed before pre-create reconciliation',
                  );
                await this.deps.artifactLeaseHost.releaseUnstartedForAbsentSeat(
                  request,
                  async () => {
                    if (await manager.inspectReserved!(record.runtimeId, signal))
                      throw new Error(
                        'OpenShell seat sandbox appeared during pre-create reconciliation',
                      );
                  },
                );
              }
              this.deps.seatSandboxRegistry!.confirmAbsentSymposiumSeatSandboxStopped(record);
              continue;
            }
            this.deps.seatSandboxRegistry!.confirmSymposiumSeatSandbox({
              sessionId,
              seatId,
              generation: record.generation,
              runtimeId: record.runtimeId,
              sandboxName: discovered.name,
              physicalId: discovered.id,
            });
            // The durable registry may return detached row objects (as SQLite
            // does). Use its newly confirmed identity for deletion and lease
            // release rather than the original unbound reservation snapshot.
            const confirmed = this.deps.seatSandboxRegistry!.getSymposiumSeatSandbox(
              sessionId,
              seatId,
              record.generation,
            );
            if (
              confirmed?.runtimeId !== record.runtimeId ||
              confirmed.sandboxName !== discovered.name ||
              confirmed.physicalId !== discovered.id
            )
              throw new Error('Discovered seat sandbox identity changed after confirmation');
            record = confirmed;
            physicalId = discovered.id;
          }
          if (record.creationStarted && !record.creationCompleted)
            throw new Error('Seat sandbox creation outcome is uncertain; reconciliation required');
          const observed = await manager.inspect(record.runtimeId, physicalId, signal);
          if (!observed && !this.deps.artifactLeaseHost)
            throw new Error('Recorded seat sandbox disappeared before confirmed stop');
          if (observed?.phase === 'Ready') await manager.stop(record.runtimeId, physicalId, signal);
          else if (observed && observed.phase !== 'Stopped')
            throw new Error(`Seat sandbox is ${observed.phase}, not Ready or Stopped`);
          if (observed) {
            const stopped = await manager.inspect(record.runtimeId, physicalId, signal);
            if (!stopped || stopped.phase !== 'Stopped')
              throw new Error('Seat sandbox physical stop is not confirmed');
          }
          if (this.deps.artifactLeaseHost) {
            if (!manager.delete || !record.sandboxName || !this.deps.artifactRequest)
              throw new Error('Artifact seat deletion interface or identity is unavailable');
            const expectedName = sandboxNameForConversation(
              record.runtimeId,
              this.deps.runtimeConfig.sandboxIdLength,
            );
            if (record.sandboxName !== expectedName)
              throw new Error('Artifact seat sandbox name changed before deletion');
            const request = this.deps.artifactRequest(
              sessionId,
              seatId,
              record.generation,
              'cleanup',
            );
            if (
              request.sessionId !== sessionId ||
              request.seatId !== seatId ||
              request.workspaceId !== record.workspace
            )
              throw new Error('Artifact lease request changed before deletion');
            // An earlier delete may have succeeded while the process crashed before
            // lease release. In that case, absence is reconciled below.
            if (observed) await manager.delete(record.runtimeId, physicalId, signal);
            const verifyGatewayAbsent = async () => {
              if (await manager.inspectReserved!(record.runtimeId, signal))
                throw new Error('OpenShell seat sandbox remains or was replaced after delete');
            };
            await this.deps.artifactLeaseHost.releaseBoundSandbox(
              request,
              record.sandboxName,
              physicalId,
              verifyGatewayAbsent,
            );
          }
          this.deps.seatSandboxRegistry!.confirmSymposiumSeatSandboxStopped({
            sessionId,
            seatId,
            generation: record.generation,
            runtimeId: record.runtimeId,
            physicalId,
          });
        }
      }),
    );
    const tail = work.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(seatId, tail);
    void tail.then(() => {
      if (this.tails.get(seatId) === tail) this.tails.delete(seatId);
    });
    return work;
  }
}

/** Only completed text delivered to this exact seat grant and generation may cross into a replacement thread. */
export function symposiumSeatRolloverHistory(
  store: Pick<EventStore, 'getSymposiumDeliveries' | 'getSymposiumRecipientAttempts'>,
  execution: import('./symposium-orchestrator.js').SymposiumSeatExecution,
  completeAttemptHistory = false,
) {
  const identity = (value: Record<string, unknown>) => {
    const rest = { ...value };
    delete rest.capturedAt;
    delete rest.configRevision;
    return JSON.stringify(rest);
  };
  const expected = identity(execution.provenance as unknown as Record<string, unknown>);
  const matching = store
    .getSymposiumDeliveries(execution.sessionId)
    .flatMap((delivery) =>
      store.getSymposiumRecipientAttempts(delivery.deliveryId, execution.seat.id),
    )
    .filter(
      (attempt) =>
        attempt.status === 'delivered' &&
        attempt.provenance &&
        identity(attempt.provenance as unknown as Record<string, unknown>) === expected,
    )
    .sort((a, b) => a.attemptId - b.attemptId);
  if (
    completeAttemptHistory &&
    matching.some((attempt) => attempt.dispatchedContent === null || attempt.resultContent === null)
  )
    throw new Error('Attempt continuity contains incomplete delivered history');
  const completed = matching.filter(
    (attempt) => attempt.dispatchedContent !== null && attempt.resultContent !== null,
  );
  return (completeAttemptHistory ? completed : completed.slice(-20)).flatMap((attempt) => [
    { role: 'user' as const, text: attempt.dispatchedContent! },
    { role: 'assistant' as const, text: attempt.resultContent! },
  ]);
}

export interface SymposiumSessionRuntimeDeps extends Omit<
  SymposiumSharedSandboxOwnerDeps,
  'facts'
> {
  store: EventStore;
  applicationPolicy?: SymposiumOpenShellSeatExecutorDeps['applicationPolicy'];
  assertArtifactAdmissionCurrent?: SymposiumOpenShellSeatExecutorDeps['assertArtifactAdmissionCurrent'];
  claimIdFactory?: import('./symposium-orchestrator.js').SymposiumOrchestratorDeps['claimIdFactory'];
  codexStore: CodexConversationStore;
  profileCatalogStore?: Pick<SymposiumProfileStore, 'list' | 'get'>;
  profileProposalStore?: Pick<SymposiumProfileProposalStore, 'propose'>;
  reviewStore?: Pick<
    SymposiumReviewStore,
    'applicationWorkflowForSession' | 'getApplicationPreparation' | 'readReviewPage'
  >;
  recordAccepted: SymposiumOpenShellSeatExecutorDeps['recordAccepted'];
  /** Trusted override owns durable persistence and live publication when supplied. */
  recordEvent?: SymposiumOpenShellSeatExecutorDeps['recordEvent'];
  /** Publish the default durable sink's client events to live session subscribers. */
  broadcastEvent?: (sessionId: string, event: Record<string, unknown>) => void;
  /** Trusted host registry; required by the real Claude controller launch path. */
  attemptRegistry?: SymposiumAttemptRegistry;
  /** Must come from image/controller attestation; no default launcher is inferred. */
  verifiedCodexControllerCommand?: readonly string[];
  openNative?: SymposiumOpenShellSeatExecutorDeps['openNative'];
  /** Explicit host attestation of exact OpenShell 0.1 seat isolation and attachment semantics. */
  perSeatSandboxVerified?: boolean;
  /** Roles certified by the host capability gate. A production gate supplies this explicitly. */
  allowedSeatRoles?: ReadonlySet<'implementer' | 'coder' | 'reviewer'>;
  allowedAccountProviders?: ReadonlySet<'openai' | 'anthropic-vertex' | 'openai-codex'>;
  /** Re-probe selected host capability before every provider mutation/admission. */
  artifactRequest?: (
    sessionId: string,
    seatId: string,
    generation: number,
    purpose?: 'admission' | 'cleanup',
  ) => ArtifactLeaseRequest;
  artifactLeaseHost?: SqliteArtifactLeaseHost;
  /** Trusted owner proves a sealed imported source has no executable predecessor. */
  preinitialSource?: (sessionId: string) => boolean;
  /** A sealed source needs a confirmed child reference before execution. */
  artifactReady?: (sessionId: string, seatId: string, generation: number) => boolean;
}

/** Host-held factory. Callers must supply durable grants, exact receipts, and verified policy. */
const sealRuntimeBindings = new WeakMap<
  object,
  {
    store: EventStore;
    leaseHost: unknown;
    sessionId: string;
    drain: (signal: AbortSignal) => Promise<void>;
  }
>();
/** Accept only a runtime created here, bound to this exact host/store/session. */
export function assertSymposiumRuntimeForArtifactSeal(
  runtime: object,
  store: EventStore,
  leaseHost: unknown,
  sessionId: string,
): void {
  const binding = sealRuntimeBindings.get(runtime);
  if (
    !binding ||
    binding.store !== store ||
    binding.leaseHost !== leaseHost ||
    binding.sessionId !== sessionId
  )
    throw new Error('Artifact seal runtime custody is unavailable');
}

export async function drainSymposiumRuntimeForArtifactSeal(
  runtime: object,
  store: EventStore,
  leaseHost: unknown,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  assertSymposiumRuntimeForArtifactSeal(runtime, store, leaseHost, sessionId);
  await sealRuntimeBindings.get(runtime)!.drain(signal);
}

export function createSymposiumSessionRuntime(deps: SymposiumSessionRuntimeDeps) {
  let draining = false;
  const originalVerify = deps.verifyHostCapability;
  deps = {
    ...deps,
    verifyHostCapability: () => {
      if (draining) throw new Error('Symposium runtime is shutting down');
      return originalVerify?.();
    },
  } as SymposiumSessionRuntimeDeps;
  const defaultEvents = new SymposiumNativeEventSink(deps.store, deps.broadcastEvent ?? (() => {}));
  const recordEvent: NonNullable<SymposiumOpenShellSeatExecutorDeps['recordEvent']> =
    deps.recordEvent ?? ((execution, event) => defaultEvents!.record(execution, event));
  const owner = new SymposiumPerSeatSandboxOwner({
    ...deps,
    facts: deps.store,
    artifactReferenceStore: deps.store,
    seatSandboxRegistry: deps.store,
  });
  const cache = new Map<string, SymposiumOpenShellSeatExecutor>();
  const executors = new Proxy({} as Record<string, SymposiumSeatExecutor>, {
    get(_target, seatId) {
      if (typeof seatId !== 'string') return undefined;
      let executor = cache.get(seatId);
      if (!executor) {
        executor = new SymposiumOpenShellSeatExecutor({
          facts: deps.store,
          applicationPolicy: deps.applicationPolicy,
          assertArtifactAdmissionCurrent: deps.assertArtifactAdmissionCurrent,
          attemptRegistry: deps.attemptRegistry,
          profiles: deps.profiles,
          currentProfiles: deps.currentProfiles,
          hostGrants: deps.hostGrants,
          owner,
          verifyHostCapability: deps.verifyHostCapability,
          recordAccepted: deps.recordAccepted,
          migrateThread: (claim, previous, next) =>
            deps.store.migrateSymposiumSeatThread(claim, previous, next),
          recordEvent,
          releaseAttempt: (claimToken) => defaultEvents.release(claimToken),
          openNative:
            deps.openNative ??
            ((input) => {
              const verifyNativeToolCurrent = () => {
                const capability = deps.verifyHostCapability?.();
                assertSymposiumProfileAttemptCurrent(deps.store, input.execution);
                const current = admitSymposiumSeatDispatch(
                  deps.store,
                  deps.currentProfiles?.() ?? deps.profiles,
                  input.execution,
                  deps.hostGrants,
                );
                if (JSON.stringify(current) !== JSON.stringify(input.route))
                  throw new Error('Symposium seat route changed before host tool');
                if (capability)
                  assertSymposiumAttestedProvider(capability, {
                    name: current.provider,
                    id: current.providerId,
                    type:
                      current.kind === 'chatgpt-subscription-native'
                        ? 'codex'
                        : current.kind === 'openai-api'
                          ? 'openai'
                          : 'google-vertex-ai',
                  });
              };
              const profileTools =
                input.execution.seat.role === 'reviewer'
                  ? deps.reviewStore
                    ? createSymposiumNativeReviewTool({
                        reviews: deps.reviewStore,
                        execution: input.execution,
                        verifyCurrent: verifyNativeToolCurrent,
                      })
                    : undefined
                  : deps.profileProposalStore
                    ? createSymposiumNativeProfileTools({
                        store: deps.profileProposalStore,
                        catalogStore: deps.profileCatalogStore,
                        owner: 'user',
                        execution: input.execution,
                        verifyCurrent: verifyNativeToolCurrent,
                      })
                    : undefined;
              const loadConversationHistory = () =>
                symposiumSeatRolloverHistory(
                  deps.store,
                  input.execution,
                  input.route.kind !== 'openai-api',
                );
              const resolveAttempt = (claim: string) => {
                const attempt = deps.store.getSymposiumRecipientAttemptByClaimToken(claim);
                if (
                  !attempt ||
                  deps.store.getSymposiumDelivery(attempt.deliveryId)?.sessionId !== deps.sessionId
                )
                  throw new Error('Native checkpoint claim belongs to another session');
                return attempt;
              };
              return input.route.kind === 'openai-api'
                ? createOpenAiCodexSeat({
                    ...input,
                    store: deps.codexStore,
                    loadConversationHistory,
                    resolveAttempt,
                    profileTools,
                    attemptRegistry: deps.attemptRegistry,
                    verifiedControllerCommand: deps.verifiedCodexControllerCommand,
                  })
                : input.route.kind === 'chatgpt-subscription-native'
                  ? createChatGptSubscriptionSeat({
                      ...input,
                      store: deps.codexStore,
                      loadConversationHistory,
                      resolveAttempt,
                      profileTools,
                      attemptRegistry: deps.attemptRegistry,
                      verifiedControllerCommand: deps.verifiedSubscriptionControllerCommand,
                      verifyPrivateAuth: deps.verifySubscriptionPrivateAuth!,
                      assertSubscriptionDispatch: deps.assertSubscriptionDispatch,
                    })
                  : createClaudeVertexSeat({
                      ...input,
                      route: input.route,
                      loadConversationHistory,
                      requireModelReceipts: true,
                      verifiedLauncher: true,
                      attemptRegistry: deps.attemptRegistry,
                    });
            }),
        });
        cache.set(seatId, executor);
      }
      return executor;
    },
  });
  const stopSeat = async ({
    sessionId,
    seatId,
    generation,
  }: {
    sessionId: string;
    seatId: string;
    generation: number;
  }) => {
    if (sessionId !== deps.sessionId) throw new Error('Symposium stop belongs to another session');
    const attempts = deps.store.getUnsettledSymposiumSeatExecutions(sessionId, seatId);
    const cancellations = await Promise.allSettled(
      attempts.map(async (attempt) => {
        if (!attempt.claimToken) throw new Error('Legacy native attempt cleanup is unknown');
        await executors[seatId].cancel!({
          idempotencyKey: attempt.idempotencyKey,
          attemptId: attempt.attemptId,
          claimToken: attempt.claimToken,
        });
        // Persist each confirmed stop independently. One uncertain sibling must
        // not make already-stopped attempts impossible to reconcile later.
        deps.store.confirmSymposiumAttemptCleanup(attempt.attemptId, attempt.idempotencyKey);
      }),
    );
    const physical = await Promise.allSettled([
      owner.stop(sessionId, seatId, generation, new AbortController().signal),
    ]);
    if ([...cancellations, ...physical].some((result) => result.status === 'rejected'))
      throw new Error('Symposium seat cleanup incomplete');
  };
  const orchestrator = new SymposiumOrchestrator({
    store: deps.store,
    executors,
    claimIdFactory: deps.claimIdFactory,
    artifactReady: deps.artifactReady,
    admitSeat: ({ sessionId, seatId, generation, retained }) => {
      if (sessionId !== deps.sessionId)
        throw new Error('Symposium admission belongs to another session');
      deps.store.assertSymposiumArtifactWorkAllowed(sessionId);
      const config = deps.store.getActiveSymposiumConfig(sessionId);
      if (config.version !== 2 || config.state !== 'active')
        throw new Error('Native admission requires active Symposium v2');
      if (!deps.perSeatSandboxVerified)
        throw new Error('OpenShell per-seat sandbox capability is not verified');
      const capability = deps.verifyHostCapability?.();
      const seat = config.seats.find((candidate) => candidate.id === seatId);
      if (!seat) throw new Error('Symposium seat is no longer configured');
      if (
        deps.allowedSeatRoles &&
        !deps.allowedSeatRoles.has(seat.role as 'implementer' | 'coder' | 'reviewer')
      )
        throw new Error('Symposium seat role is outside the verified native capability');
      const membership = deps.store.getLatestSymposiumMembership(sessionId, seatId);
      if (membership?.generation !== generation || membership.state !== 'active')
        throw new Error('Symposium membership changed before admission');
      deps.hostGrants.verifySeat({ sessionId, seat, membershipGeneration: generation });
      const binding = seat.accountBinding;
      if (!binding || !['openai', 'anthropic-vertex', 'openai-codex'].includes(binding.provider))
        throw new Error('Symposium native account provider is unsupported');
      if (binding.provider === 'openai-codex') assertNativeSubscriptionCapability(deps);
      if (
        deps.allowedAccountProviders &&
        !deps.allowedAccountProviders.has(
          binding.provider as 'openai' | 'anthropic-vertex' | 'openai-codex',
        )
      )
        throw new Error('Symposium account provider is outside the verified native capability');
      if (
        (seat.role === 'reviewer' ||
          seat.authorityGrant?.filesystem !== 'write' ||
          seat.authorityGrant?.tools !== 'write') &&
        !(binding.provider === 'openai'
          ? deps.readOnlyEnforced.openaiApi
          : binding.provider === 'openai-codex'
            ? deps.readOnlyEnforced.chatgptSubscription
            : deps.readOnlyEnforced.claudeVertex)
      )
        throw new Error('Reviewer native read-only policy is not verified');
      const snapshot = snapshotSymposiumSeatProvider(
        sessionId,
        seatId,
        deps.store,
        deps.currentProfiles ?? deps.profiles,
        deps.hostGrants,
        deps.resolveProviderIdentity,
        deps.runtimeConfig.workspace,
        retained ? 'retained' : 'candidate',
      );
      if (capability)
        for (const binding of snapshot.bindings)
          assertSymposiumAttestedProvider(capability, {
            ...binding,
            workspace: deps.runtimeConfig.workspace,
          });
      verifyClaudeSeatCapability({ ...deps, facts: deps.store }, sessionId, seatId, capability);
      if (binding.provider === 'anthropic-vertex') {
        const policy = deps.resolveSeatPolicy?.({ sessionId, seatId, generation });
        if (!policy) throw new Error('Owned Vertex seat policy unavailable');
        policy.verify();
      }
      snapshot.verify();
      orchestrator.recordProviderAdmission({
        sessionId,
        seatId,
        decision: 'admitted',
        idempotencyKey: `host-native:${config.revision}:${generation}:${seatId}`,
      });
    },
    reconcileProviders: async ({ sessionId, requiredProviders }) => {
      if (!deps.perSeatSandboxVerified)
        throw new Error('OpenShell per-seat sandbox capability is not verified');
      const capability = deps.verifyHostCapability?.();
      const config = deps.store.getActiveSymposiumConfig(sessionId);
      const active = config.seats.filter(
        (candidate) =>
          deps.store.getLatestSymposiumMembership(sessionId, candidate.id)?.state === 'active',
      );
      if (
        deps.allowedSeatRoles &&
        active.some(
          (seat) => !deps.allowedSeatRoles!.has(seat.role as 'implementer' | 'coder' | 'reviewer'),
        )
      )
        throw new Error('Symposium seat role is outside the verified native capability');
      if (
        deps.allowedAccountProviders &&
        active.some(
          (seat) =>
            !seat.accountBinding ||
            !deps.allowedAccountProviders!.has(
              seat.accountBinding.provider as 'openai' | 'anthropic-vertex' | 'openai-codex',
            ),
        )
      )
        throw new Error('Symposium account provider is outside the verified native capability');
      const snapshots = active.map((candidate) =>
        snapshotSymposiumSeatProvider(
          sessionId,
          candidate.id,
          deps.store,
          deps.currentProfiles ?? deps.profiles,
          deps.hostGrants,
          deps.resolveProviderIdentity,
          deps.runtimeConfig.workspace,
          'reconciling',
        ),
      );
      if (capability)
        for (const snapshot of snapshots)
          for (const binding of snapshot.bindings)
            assertSymposiumAttestedProvider(capability, {
              ...binding,
              workspace: deps.runtimeConfig.workspace,
            });
      if (
        JSON.stringify(
          [...new Set(snapshots.map((snapshot) => snapshot.logicalProvider))].sort(),
        ) !== JSON.stringify([...requiredProviders].sort())
      )
        throw new Error('Symposium required provider union changed before reconciliation');
      // A sealed import is a read-only parent. Confirm provider and membership
      // authority without ever reserving or mounting a seat on that volume.
      if (!deps.preinitialSource?.(sessionId)) {
        for (const candidate of active) {
          const membership = deps.store.getLatestSymposiumMembership(sessionId, candidate.id);
          // The first child can exist for one seat while another still has only
          // the sealed source. Do not reserve a sandbox against that source.
          if (
            deps.artifactReady &&
            (!membership || !deps.artifactReady(sessionId, candidate.id, membership.generation))
          )
            continue;
          await owner.ensure(sessionId, candidate.id, new AbortController().signal);
        }
      }
      for (const snapshot of snapshots) snapshot.verify();
    },
    retainedProviders: () => [],
    stopSeat,
    creationRecovery:
      owner instanceof SymposiumPerSeatSandboxOwner
        ? {
            diagnostic: (sessionId, seatId) =>
              sessionId === deps.sessionId ? owner.creationDiagnostic(seatId) : null,
            assertRetained: (sessionId, seatId, generation) => {
              if (sessionId !== deps.sessionId)
                throw new Error('Creation recovery session changed');
              owner.assertCreationCleanup(seatId, generation);
            },
          }
        : undefined,
  });
  const runtime = {
    orchestrator,
    owner,
    executors,
    beginShutdown() {
      draining = true;
      for (const executor of cache.values()) executor.beginShutdown();
    },
    async drain(signal: AbortSignal) {
      draining = true;
      for (const executor of cache.values()) executor.beginShutdown();
      const native = await Promise.allSettled(
        [...cache.values()].map((executor) => executor.drain(signal)),
      );
      const seats = new Map<string, number>();
      for (const record of deps.store.listSymposiumSessionSandboxes(deps.sessionId))
        seats.set(record.seatId, Math.max(seats.get(record.seatId) ?? 0, record.generation));
      for (const member of deps.store.getSymposiumMembershipHistory(deps.sessionId))
        seats.set(member.seatId, Math.max(seats.get(member.seatId) ?? 0, member.generation));
      const results = await Promise.allSettled(
        [...seats].map(async ([seatId, generation]) => {
          signal.throwIfAborted();
          await stopSeat({ sessionId: deps.sessionId, seatId, generation });
        }),
      );
      signal.throwIfAborted();
      if ([...native, ...results].some((result) => result.status === 'rejected'))
        throw new Error('Symposium seat cleanup incomplete');
    },
  };
  sealRuntimeBindings.set(runtime, {
    store: deps.store,
    leaseHost: deps.artifactLeaseHost,
    sessionId: deps.sessionId,
    drain: runtime.drain,
  });
  return runtime;
}
