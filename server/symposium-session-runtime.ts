import { SymposiumNativeEventSink } from './symposium-native-event-sink.js';
import type { AccountProfiles } from './account-profiles.js';
import type { CodexConversationStore } from './codex-conversation-store.js';
import { spawnSync } from 'node:child_process';
import type { EventStore } from './event-store.js';
import { createClaudeVertexSeat } from './symposium-claude-native.js';
import type { SymposiumAttemptRegistry } from './symposium-attempt-registry.js';
import { createOpenAiCodexSeat } from './symposium-codex-native.js';
import {
  SymposiumOpenShellSeatExecutor,
  type SymposiumOpenShellSeatExecutorDeps,
} from './symposium-openshell-seat-executor.js';
import { SymposiumOrchestrator, type SymposiumSeatExecutor } from './symposium-orchestrator.js';
import {
  OpenShellRuntimeManager,
  type BoundOpenShellRuntimeConfig,
  type OpenShellAccountRoute,
  type OpenShellRuntimeConfig,
} from './openshell-runtime.js';
import type {
  SymposiumDispatchFacts,
  SymposiumHostGrantVerifier,
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
    'cli' | 'gateway' | 'gatewayEndpoint' | 'gatewayInsecure' | 'workspace'
  >,
  run?: (args: readonly string[]) => string,
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
    '--limit',
    '100',
  ];
  const invoke =
    run ??
    (() => {
      const result = spawnSync(config.cli, args, {
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
      rows = JSON.parse(invoke(args));
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

/** Freeze the exact admitted generation and physical provider inventory for one reconciliation. */
export function snapshotSymposiumProviderUnion(
  sessionId: string,
  facts: SymposiumDispatchFacts,
  profiles: AccountProfiles | (() => AccountProfiles),
  hostGrants: SymposiumHostGrantVerifier,
  resolveProviderIdentity: SymposiumProviderIdentityResolver,
  workspace: string,
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
    }> = [];
    for (const seat of config.seats) {
      const membership = facts.getLatestSymposiumMembership(sessionId, seat.id);
      if (membership?.state !== 'active') continue;
      const binding = seat.accountBinding;
      if (!binding) throw new Error('Active Symposium seat lacks account binding');
      const admission = facts.getLatestSymposiumAdmission(sessionId, seat.id, config.revision);
      if (
        admission?.decision !== 'admitted' ||
        admission.membershipGeneration !== membership.generation ||
        admission.accountId !== binding.accountId ||
        admission.provider !== binding.provider ||
        admission.model !== binding.model ||
        admission.accountProfileRevision !== binding.profileRevision
      )
        throw new Error('Active Symposium seat lacks current provider admission');
      hostGrants.verifySeat({ sessionId, seat, membershipGeneration: membership.generation });
      currentProfiles.resume(binding);
      let name: string;
      let id: string;
      if (binding.provider === 'openai') {
        const route = currentProfiles.apiProfile(binding);
        if (!route.sandboxProvider || !route.sandboxProviderId)
          throw new Error('OpenAI seat lacks physical provider binding');
        name = route.sandboxProvider;
        id = route.sandboxProviderId;
      } else if (binding.provider === 'anthropic-vertex') {
        const route = currentProfiles.vertexSandboxRoute(binding);
        name = route.provider;
        id = route.providerId;
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
      const expectedType = binding.provider === 'anthropic-vertex' ? 'google-vertex-ai' : 'openai';
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
      owner: { kind: 'api' as const, provider: anchor.name, model: anchor.model },
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
  sessionId: string;
  facts: SymposiumDispatchFacts;
  profiles: AccountProfiles;
  /** Refresh account binding truth at every admission and async reconciliation boundary. */
  currentProfiles?: () => AccountProfiles;
  hostGrants: SymposiumHostGrantVerifier;
  resolveProviderIdentity: SymposiumProviderIdentityResolver;
  runtimeConfig: OpenShellRuntimeConfig;
  readOnlyEnforced: { openaiApi: boolean; claudeVertex: boolean };
  managerFactory?: (config: BoundOpenShellRuntimeConfig) => {
    ensure(
      sessionId: string,
      signal: AbortSignal,
    ): Promise<{ sandboxName: string; workdir: string }>;
  };
}

/** One owner serializes all seat/provider mutations for the shared session sandbox. */
export class SymposiumSharedSandboxOwner {
  readonly readOnlyEnforced: { openaiApi: boolean; claudeVertex: boolean };
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

export interface SymposiumSessionRuntimeDeps extends Omit<
  SymposiumSharedSandboxOwnerDeps,
  'facts'
> {
  store: EventStore;
  codexStore: CodexConversationStore;
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
}

/** Host-held factory. Callers must supply durable grants, exact receipts, and verified policy. */
export function createSymposiumSessionRuntime(deps: SymposiumSessionRuntimeDeps) {
  const defaultEvents = deps.recordEvent
    ? undefined
    : new SymposiumNativeEventSink(deps.store, deps.broadcastEvent ?? (() => {}));
  const recordEvent: NonNullable<SymposiumOpenShellSeatExecutorDeps['recordEvent']> =
    deps.recordEvent ?? ((execution, event) => defaultEvents!.record(execution, event));
  const owner = new SymposiumSharedSandboxOwner({ ...deps, facts: deps.store });
  const cache = new Map<string, SymposiumOpenShellSeatExecutor>();
  const executors = new Proxy({} as Record<string, SymposiumSeatExecutor>, {
    get(_target, seatId) {
      if (typeof seatId !== 'string') return undefined;
      let executor = cache.get(seatId);
      if (!executor) {
        executor = new SymposiumOpenShellSeatExecutor({
          facts: deps.store,
          attemptRegistry: deps.attemptRegistry,
          profiles: deps.profiles,
          currentProfiles: deps.currentProfiles,
          hostGrants: deps.hostGrants,
          owner,
          recordAccepted: deps.recordAccepted,
          recordEvent,
          openNative:
            deps.openNative ??
            ((input) =>
              input.route.kind === 'openai-api'
                ? createOpenAiCodexSeat({
                    ...input,
                    store: deps.codexStore,
                    attemptRegistry: deps.attemptRegistry,
                    verifiedControllerCommand: deps.verifiedCodexControllerCommand,
                  })
                : createClaudeVertexSeat({
                    ...input,
                    route: input.route,
                    attemptRegistry: deps.attemptRegistry,
                  })),
        });
        cache.set(seatId, executor);
      }
      return executor;
    },
  });
  const orchestrator = new SymposiumOrchestrator({
    store: deps.store,
    executors,
    admitSeat: ({ sessionId, seatId, generation }) => {
      if (sessionId !== deps.sessionId)
        throw new Error('Symposium admission belongs to another session');
      const config = deps.store.getActiveSymposiumConfig(sessionId);
      if (config.version !== 2 || config.state !== 'active')
        throw new Error('Native admission requires active Symposium v2');
      const active = config.seats.filter(
        (candidate) =>
          deps.store.getLatestSymposiumMembership(sessionId, candidate.id)?.state === 'active',
      );
      if (active.length !== 1 || active[0].id !== seatId || config.anchorSeatId !== seatId)
        throw new Error('Private native state isolation permits only the anchor seat');
      const seat = active[0];
      const membership = deps.store.getLatestSymposiumMembership(sessionId, seatId);
      if (membership?.generation !== generation || membership.state !== 'active')
        throw new Error('Symposium membership changed before admission');
      deps.hostGrants.verifySeat({ sessionId, seat, membershipGeneration: generation });
      const binding = seat.accountBinding;
      if (!binding || binding.provider !== 'openai')
        throw new Error('Only OpenAI API native admission is currently verified');
      if (
        (seat.role === 'reviewer' ||
          seat.authorityGrant?.filesystem !== 'write' ||
          seat.authorityGrant?.tools !== 'write') &&
        !deps.readOnlyEnforced.openaiApi
      )
        throw new Error('Reviewer native read-only policy is not verified');
      const profiles = deps.currentProfiles?.() ?? deps.profiles;
      profiles.resume(binding);
      const route = profiles.apiProfile(binding);
      if (!route.sandboxProvider || !route.sandboxProviderId)
        throw new Error('OpenAI seat lacks physical provider binding');
      const physical = deps.resolveProviderIdentity(route.sandboxProvider, route.sandboxProviderId);
      if (
        physical.name !== route.sandboxProvider ||
        physical.id !== route.sandboxProviderId ||
        physical.workspace !== deps.runtimeConfig.workspace ||
        !physical.type
      )
        throw new Error('OpenShell physical provider identity changed');
      if (physical.type !== 'openai')
        throw new Error('OpenShell physical provider type does not match Symposium account');
      orchestrator.recordProviderAdmission({
        sessionId,
        seatId,
        decision: 'admitted',
        idempotencyKey: `host-native:${config.revision}:${generation}:${seatId}`,
      });
    },
    reconcileProviders: async ({ sessionId, requiredProviders }) => {
      const snapshot = snapshotSymposiumProviderUnion(
        sessionId,
        deps.store,
        deps.currentProfiles ?? deps.profiles,
        deps.hostGrants,
        deps.resolveProviderIdentity,
        deps.runtimeConfig.workspace,
      );
      if (
        JSON.stringify(snapshot.logicalProviders) !== JSON.stringify([...requiredProviders].sort())
      )
        throw new Error('Symposium required provider union changed before reconciliation');
      await owner.ensure(sessionId, new AbortController().signal);
      snapshot.verify();
    },
    retainedProviders: () => [],
    stopSeat: async ({ sessionId, seatId }) => {
      if (sessionId !== deps.sessionId)
        throw new Error('Symposium stop belongs to another session');
      const attempts = deps.store.getUnsettledSymposiumSeatExecutions(sessionId, seatId);
      await Promise.all(
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
    },
  });
  return { orchestrator, owner, executors };
}
