import {
  CollaborationMessageInputSchema,
  CollaborationApplicationReviewResultSchema,
  type AgentLibraryVersion,
} from '@mitzo/protocol';
import { isAuthSessionCurrent, type AuthSession } from './auth.js';
import { getAgentLibrary } from './agent-library-runtime.js';
import { captureAgentLibraryAuthorization } from './agent-library-transport.js';
import { resolveOrdinaryCodexAgentProfile } from './ordinary-codex-agent-profile.js';
import { loadAccountProfiles } from './account-profiles.js';
import { sessionHarnessForProvider } from './session-harness-routing.js';
import { repositoryWorkspaceSourceInventory } from './repository-workspace-runtime.js';
import type { RepositoryWorkspaceSourceReason } from './repository-workspace-runtime.js';
import { CollaborationApplicationReview } from './collaboration-application-review.js';
import { createApplicationCollaborationJoining } from './collaboration-application-joining.js';
import type { ApplicationCollaborationMessaging } from './collaboration-application-messaging.js';
import type { EventStore } from './event-store.js';
import type { RepositoryWorkspaces } from './repository-workspaces.js';
import { SpecialistConsultationStore } from './specialist-consultation-store.js';
import {
  specialistToolSchema,
  SpecialistRouteSchema,
  ConsultationInputSchema,
  SpecialistAuthorizationInputSchema,
  ConsultationAllowanceSchema,
  type SpecialistRoute,
  type SpecialistPolicy,
  type ConsultationRecord,
} from './specialist-consultation-contract.js';
import { createLogger } from './logger.js';
import { isDeepStrictEqual } from 'node:util';
import { specialistRoleExecution } from './specialist-role-execution.js';
import { specialistDiagnostic } from './specialist-consultation-diagnostics.js';
import { specialistReviewDiversity, specialistReviewerRank } from './specialist-review-routing.js';

const log = createLogger('specialist-consultation');
export type SpecialistApproval = (
  display: Record<string, unknown>,
) => Promise<boolean | Record<string, unknown>>;
export type SpecialistAuthority = {
  leadSessionId: string;
  operatorConnectionId: string;
  auth: AuthSession;
  signal: AbortSignal;
  assertCurrent(): void;
};

/** Catalog refusals for accounts that have no repository source. The entry keeps
 * the harness/code shape the catalog already uses and adds the account it names,
 * so an unassigned Claude account is explicit instead of silently absent. */
export function repositorySourceRefusals(
  entries: readonly {
    harness: string;
    accountId: string;
    inventory: {
      available: boolean;
      repositories: readonly unknown[];
      reason?: RepositoryWorkspaceSourceReason;
    };
  }[],
) {
  const refusals = new Map<string, { harness: string; accountId: string; code: string }>();
  for (const entry of entries) {
    if (entry.inventory.repositories.length || !entry.inventory.reason) continue;
    const refusal = {
      harness: entry.harness,
      accountId: entry.accountId,
      code: entry.inventory.reason,
    };
    refusals.set(JSON.stringify(refusal), refusal);
  }
  return [...refusals.values()];
}

/** Bounded composition over existing Library, repository, context, joining,
 * messaging and ordinary execution owners. No model client or scheduler. */
export class SpecialistConsultations {
  readonly receipts: SpecialistConsultationStore;
  private readonly pending = new Map<
    string,
    {
      requestId: string;
      cancel: AbortController;
      result: Promise<ReturnType<SpecialistConsultations['read']>>;
    }
  >();
  constructor(
    private readonly owners: {
      events: EventStore;
      workspaces(): RepositoryWorkspaces;
      messaging: ApplicationCollaborationMessaging;
      databasePath: string;
    },
  ) {
    this.receipts = new SpecialistConsultationStore(owners.databasePath);
  }
  closeIdle() {
    if (this.pending.size) throw Error('Specialist consultation requests are active');
    this.receipts.close();
  }
  private current(a: SpecialistAuthority) {
    a.signal.throwIfAborted();
    a.assertCurrent();
    const captured = captureAgentLibraryAuthorization(a.operatorConnectionId);
    captured.assertCurrent();
    const source = this.owners.events.getSession(a.leadSessionId);
    if (
      !isAuthSessionCurrent(a.auth) ||
      captured.auth.id !== a.auth.id ||
      !source ||
      source.isHidden ||
      source.sessionType === 'symposium' ||
      source.symposiumConfig
    )
      throw Error('Current ordinary lead authorization required');
    // Bounded specialists may not recruit their own specialists.
    if (this.owners.events.getOrdinarySessionPreparationForConversation(a.leadSessionId)) {
      const linked = this.owners.events.listSessionCollaborations(a.leadSessionId).collaborations;
      if (
        linked.some((group) =>
          this.owners.events.collaborationConversation
            .view(group.collaborationId)
            .joins.some((join) => join.sessionId === a.leadSessionId),
        )
      )
        throw Error('Shared specialist participants cannot recruit recursively');
    }
  }
  private async inventory() {
    const { ordinaryRepositoryRuntimeInventory } = await import('./ordinary-local-codex-entry.js');
    return { ordinaryRepositoryRuntimeInventory };
  }
  async catalog(a: SpecialistAuthority) {
    this.current(a);
    const versions = getAgentLibrary().list('user').versions;
    const latest = new Map<string, AgentLibraryVersion>();
    for (const version of versions)
      if ((latest.get(version.profileId)?.revision ?? 0) < version.revision)
        latest.set(version.profileId, version);
    const { ordinaryRepositoryRuntimeInventory } = await this.inventory();
    const routes = [];
    const unavailable = [];
    const repositories = new Map<
      string,
      { connectionId: string; repository: string; accountId: string }
    >();
    const sourceInventory: Parameters<typeof repositorySourceRefusals>[0][number][] = [];
    for (const harness of ['codex', 'claude-sdk'] as const) {
      try {
        const inventory = ordinaryRepositoryRuntimeInventory('local', harness);
        for (const route of inventory.result.routes) {
          if (!route.modes.some((mode) => ['ask', 'agent', 'auto'].includes(String(mode))))
            continue;
          const account = inventory.result.accounts.find(
            (item) => item.account.accountId === route.account.accountId,
          );
          if (!account) continue;
          routes.push({
            accountId: account.account.accountId,
            provider: account.account.provider,
            harness,
            runOn: 'local' as const,
            targetId: route.targetId,
            permissionModes: route.modes,
            models: account.models,
          });
          const binding = inventory.profiles.resolve(
            account.account.accountId,
            account.models[0]?.id,
          );
          const sources = repositoryWorkspaceSourceInventory(binding);
          sourceInventory.push({ harness, accountId: binding.accountId, inventory: sources });
          for (const source of sources.repositories) {
            if (source.connectionId === 'local') continue;
            const item = {
              connectionId: source.connectionId,
              repository: source.repository,
              accountId: binding.accountId,
            };
            repositories.set(JSON.stringify(item), item);
          }
        }
      } catch (cause) {
        log.debug('Specialist catalog route unavailable', {
          err: cause,
          stage: 'catalog',
          code: 'specialist_route_unavailable',
          harness,
          sessionId: a.leadSessionId,
        });
        unavailable.push({ harness, code: 'route_unavailable' });
      }
    }
    this.current(a);
    return {
      profiles: [...latest.values()].map((p) => ({
        profileId: p.profileId,
        revision: p.revision,
        name: p.definition.name,
        role: p.definition.role,
        modelPolicyRole: p.definition.modelPolicyRole,
        contextRecipe: p.definition.contextRecipe?.source ?? null,
      })),
      routes,
      repositories: [...repositories.values()],
      policies: this.receipts.policies(a.leadSessionId),
      modelPolicy: this.receipts.modelPolicies.view(a.leadSessionId),
      unavailable: [
        ...unavailable,
        ...repositorySourceRefusals(sourceInventory),
        { harness: 'openshell', code: 'shared_delivery_not_qualified' },
        { harness: 'gemini', code: 'shared_participant_not_qualified' },
      ],
    };
  }
  private async resolveRoute(raw: unknown) {
    const route = SpecialistRouteSchema.parse(raw);
    if (route.runOn !== 'local')
      throw Error('OpenShell specialist delivery is not qualified; choose an eligible local route');
    const { ordinaryRepositoryRuntimeInventory } = await this.inventory();
    const profiles = loadAccountProfiles();
    const binding = profiles.resolve(route.accountId, route.model);
    profiles.validateModelSelection(binding, route.model, route.reasoningEffort);
    if (binding.provider !== route.provider || binding.profileRevision !== route.accountRevision)
      throw Error('Specialist account changed; review a new policy');
    const harness = sessionHarnessForProvider(binding.provider);
    if (harness === 'gemini') throw Error('Gemini shared specialist delivery is not qualified');
    const inventory = ordinaryRepositoryRuntimeInventory(route.runOn, harness);
    const resolved = inventory.catalog.resolve({
      account: {
        accountId: binding.accountId,
        provider: binding.provider,
        profileRevision: binding.profileRevision,
      },
      harness,
      targetId: route.targetId,
      mode: route.permissionMode ?? 'ask',
    });
    if (resolved.status !== 'compatible') throw Error('Specialist runtime is unavailable');
    const agent = await resolveOrdinaryCodexAgentProfile({
      requested: route.agent,
      provider: binding.provider,
      execution: resolved.binding.execution,
      lookup: async (selection) =>
        getAgentLibrary().version('user', selection.profileId, selection.revision),
    });
    if (!agent || agent.contentHash !== route.profileHash)
      throw Error('Specialist profile changed');
    if (
      agent.definition.contextRecipe &&
      (harness !== 'codex' || agent.definition.contextRecipe.source === 'packs')
    )
      throw Error('This specialist context recipe needs a qualified shared joining route');
    return { binding, runtime: resolved.binding, agent };
  }
  async authorize(a: SpecialistAuthority, raw: unknown, approve: SpecialistApproval) {
    this.current(a);
    const input = specialistToolSchema.parse({ ...(raw as object), operation: 'authorize' });
    if (!input.requestId || !input.routes || !input.repository || !input.connectionId)
      throw Error('Authorization requires requestId, repository, connectionId and routes');
    const authorizationInput = SpecialistAuthorizationInputSchema.parse({
      requestId: input.requestId,
      repository: input.repository,
      connectionId: input.connectionId,
      routes: input.routes,
      durationMinutes: input.durationMinutes,
      maxConsultations: input.maxConsultations,
      maxContextBytes: input.maxContextBytes,
    });
    const prior = this.receipts.findPolicy(a.leadSessionId, input.requestId);
    if (prior) {
      this.receipts.assertPolicy(a.leadSessionId, a.auth.id, input.requestId);
      const original = this.receipts.authorizationInput(a.leadSessionId, input.requestId);
      if (!original)
        throw Error('Original policy request is unavailable; review a new authorization requestId');
      if (!isDeepStrictEqual(original, authorizationInput))
        throw Error('Consultation policy request conflict');
    }
    const versions = prior ? [] : getAgentLibrary().list('user').versions;
    const routes: SpecialistRoute[] = [];
    for (const [index, choice] of authorizationInput.routes.entries()) {
      const binding = loadAccountProfiles().resolve(choice.accountId, choice.model);
      let route: SpecialistRoute;
      if (prior) route = prior.routes[index];
      else {
        const eligible = versions.filter((p) =>
          choice.agent
            ? p.profileId === choice.agent.profileId && p.revision === choice.agent.revision
            : p.definition.modelPolicyRole === choice.role || p.definition.role === choice.role,
        );
        const latest = new Map<string, AgentLibraryVersion>();
        for (const p of eligible)
          if ((latest.get(p.profileId)?.revision ?? 0) < p.revision) latest.set(p.profileId, p);
        if (latest.size !== 1)
          throw Error(
            `Role ${choice.role} needs one exact published specialist; select its agent revision from catalog`,
          );
        const profile = [...latest.values()][0];
        route = SpecialistRouteSchema.parse({
          ...choice,
          agent: { profileId: profile.profileId, revision: profile.revision },
          profileHash: profile.contentHash,
          provider: binding.provider,
          accountRevision: binding.profileRevision,
        });
      }
      await this.resolveRoute(route);
      const sources = repositoryWorkspaceSourceInventory(binding);
      if (
        !sources.repositories.some(
          (source) =>
            source.connectionId === input.connectionId && source.repository === input.repository,
        )
      )
        // Carry the same named reason the catalog shows, so an operator sees one
        // explanation for the same fact rather than a bare refusal.
        throw Error(
          `Repository source is not configured for this specialist account${
            sources.reason ? ` (${sources.reason})` : ''
          }`,
        );
      routes.push(route);
    }
    this.current(a);
    const selection = {
      requestId: input.requestId,
      repository: input.repository,
      connectionId: input.connectionId,
      routes,
      expiresAt:
        prior?.expiresAt ??
        Math.min(a.auth.expiresAt, Date.now() + authorizationInput.durationMinutes * 60000),
      maxConsultations: prior ? prior.maxConsultations : authorizationInput.maxConsultations,
      maxContextBytes: authorizationInput.maxContextBytes,
    };
    const display = {
      ...selection,
      specialistPermissionModes: routes.map((route) => ({
        role: route.role,
        mode: route.permissionMode ?? 'ask',
      })),
      scope:
        'Only this lead may request bounded specialist turns, share selected public messages and artifact versions, and read attributed replies. No tool, repository credential, merge or deployment authority is inherited. Limits count requested turns; no dollar or total-token cap is certified.',
    };
    if (!prior) {
      const decision = await approve(display);
      if (!decision) throw Error('Specialist consultation policy was not approved');
      if (decision !== true) {
        const { maxConsultations, ...rest } = decision;
        const expected: Record<string, unknown> = { ...display };
        delete expected.maxConsultations;
        if (!isDeepStrictEqual(rest, expected))
          throw Error('Consultation approval changed protected fields');
        selection.maxConsultations = ConsultationAllowanceSchema.parse(maxConsultations);
      }
    }
    this.current(a);
    for (const route of routes) await this.resolveRoute(route);
    this.current(a);
    if (prior) this.receipts.assertPolicy(a.leadSessionId, a.auth.id, prior.policyId);
    if (selection.expiresAt <= Date.now()) throw Error('Consultation policy expired');
    const groups = prior
      ? undefined
      : this.owners.events.listSessionCollaborations(a.leadSessionId);
    if (groups && (groups.nextCursor || groups.collaborations.length > 1))
      throw Error('Choose one shared conversation before consulting specialists');
    // Select the final group before saving. A replay or interrupted setup must
    // retain this identity even if the lead has since joined another group.
    const policy =
      prior ??
      this.receipts.authorize(
        a.leadSessionId,
        a.auth.id,
        selection,
        groups?.collaborations[0]?.collaborationId,
        authorizationInput,
      );
    if (!this.owners.events.getSessionCollaboration(policy.collaborationId))
      this.owners.events.collaborationConversation.begin(policy.collaborationId, {
        requestId: policy.requestId,
        sessionId: a.leadSessionId,
      });
    this.assertAudience(policy, null);
    return policy;
  }
  private assertAudience(policy: SpecialistPolicy, recipient: string | null) {
    const view = this.owners.events.collaborationConversation.view(policy.collaborationId);
    if (
      !view.participantSessionIds.includes(policy.leadSessionId) ||
      view.policies.some((p) => p.readsFutureDiscussion && p.sessionId !== recipient)
    )
      throw Error(
        'Review Agents sharing: consultation context cannot be broadcast to other readers',
      );
    return view;
  }
  private independence(a: SpecialistAuthority, record: ConsultationRecord) {
    if (!record.input.reviewOf) return null;
    const original = this.receipts.read(a.leadSessionId, record.input.reviewOf);
    const independent =
      record.route.agent.profileId !== original.route.agent.profileId &&
      record.sessionId !== original.sessionId;
    return {
      independent,
      ...specialistReviewDiversity(record.route, original.route),
    };
  }
  read(a: SpecialistAuthority, requestId: string) {
    this.current(a);
    const receipt = this.receipts.read(a.leadSessionId, requestId);
    const policy = this.receipts.policy(a.leadSessionId, receipt.policyId);
    const input =
      receipt.messageInput && CollaborationMessageInputSchema.parse(receipt.messageInput);
    const observed = input
      ? this.owners.messaging.observe(a.auth, policy.collaborationId, input)
      : null;
    const deliveries = observed?.message?.deliveries.filter((d) => d.purpose === 'reply') ?? [];
    const contributions = deliveries
      .flatMap((delivery) =>
        this.owners.events.collaborationConversation.repliesForDelivery(
          policy.collaborationId,
          observed!.message!.messageId,
          delivery.deliveryId,
        ),
      )
      .map((m) => ({
        sessionId: receipt.sessionId,
        profileId: receipt.route.agent.profileId,
        revision: receipt.route.agent.revision,
        role: receipt.input.role,
        accountId: receipt.route.accountId,
        model: receipt.route.model,
        messageId: m.messageId,
        text: m.text,
        source: m.source,
      }));
    const status =
      receipt.state === 'stopped'
        ? 'stopped'
        : observed?.terminal
          ? deliveries.every((d) => d.outcome === 'completed') && contributions.length
            ? 'completed'
            : 'failed'
          : receipt.state === 'uncertain' ||
              deliveries.some((delivery) => delivery.status === 'uncertain')
            ? 'uncertain'
            : deliveries.length &&
                deliveries.every((delivery) => ['failed', 'unavailable'].includes(delivery.status))
              ? 'failed'
              : receipt.state === 'dispatched'
                ? 'running'
                : 'pending';
    this.current(a);
    return {
      receipt,
      status,
      terminal: observed?.terminal ?? receipt.state === 'stopped',
      contributions,
      deliveries,
      independence: this.independence(a, receipt),
    };
  }
  async consult(
    a: SpecialistAuthority,
    policyId: string,
    raw: unknown,
    approve?: SpecialistApproval,
  ) {
    this.current(a);
    const input = ConsultationInputSchema.parse(raw);
    const policy = this.receipts.assertPolicy(a.leadSessionId, a.auth.id, policyId);
    const previous = this.receipts.find(a.leadSessionId, input.requestId);
    if (previous) {
      if (previous.policyId !== policyId || !isDeepStrictEqual(previous.input, input))
        throw Error('Consultation request conflict');
      // A receipt still `reserved` never started, or lost its runner to a
      // concurrent consult or restart. It holds an allowance slot, so retrying
      // the same requestId resumes it through the original recovery owner
      // (re-approving if its rule changed or its allowance was released).
      // A running one joins its pending result.
      if (previous.state === 'reserved') {
        const pending = this.pending.get(a.leadSessionId);
        if (pending && pending.requestId !== input.requestId)
          throw Error(
            'Another consultation is preparing; retain this requestId and retry after it settles',
          );
        return this.recover(a, input.requestId, approve);
      }
      return this.read(a, input.requestId);
    }
    if (this.pending.has(a.leadSessionId))
      throw Error(
        'Another consultation is preparing; retain this requestId and retry after it settles',
      );
    let candidates = policy.routes.filter((route) => route.role === input.role);
    if (input.reviewOf) {
      const reviewed = this.read(a, input.reviewOf);
      if (reviewed.status !== 'completed')
        throw Error('Independent review requires a completed attributed contribution');
      candidates = candidates.filter(
        (route) => route.agent.profileId !== reviewed.receipt.route.agent.profileId,
      );
      candidates.sort(
        (left, right) =>
          specialistReviewerRank(left, reviewed.receipt.route) -
          specialistReviewerRank(right, reviewed.receipt.route),
      );
    }
    if (!candidates.length)
      throw Error('No eligible independent specialist route is authorized for this role');
    const selected = await this.approveModel(a, policy, candidates, approve);
    const record = this.receipts.reserve(
      a.leadSessionId,
      a.auth.id,
      policyId,
      input,
      this.owners.events.getDurableSessionTranscript(a.leadSessionId).boundary,
      selected.route,
      { modelPolicyRevision: selected.revision },
    );
    if (record.state !== 'reserved' && !this.pending.has(a.leadSessionId))
      return this.read(a, record.requestId);
    return this.run(a, policy, record);
  }
  async recover(a: SpecialistAuthority, requestId: string, approve?: SpecialistApproval) {
    this.current(a);
    let record = this.receipts.read(a.leadSessionId, requestId);
    const observed = this.read(a, requestId);
    if (observed.terminal || record.state === 'stopped') return observed;
    const policy = this.receipts.assertPolicy(a.leadSessionId, a.auth.id, record.policyId);
    // Retained send receipts always reconcile through their original owner.
    // Recovery cannot replay possibly accepted native work.
    if (
      record.messageInput &&
      this.owners.events.collaborationConversation.getMessageForRequest(
        policy.collaborationId,
        record.messageInput,
      )
    )
      return observed;
    const settings = this.receipts.modelPolicies.resolve(
      a.leadSessionId,
      record.route.accountId,
      record.route.model,
    );
    if (record.modelPolicyRevision !== settings.revision || record.allowanceState === 'released') {
      const approved = await this.approveModel(
        a,
        policy,
        [record.route],
        approve,
        record.requestId,
      );
      record = this.receipts.update(a.leadSessionId, requestId, record.revision, {
        modelPolicyRevision: approved.revision,
      });
    }
    return this.run(a, policy, record);
  }
  private async approveModel(
    a: SpecialistAuthority,
    policy: SpecialistPolicy,
    candidates: SpecialistRoute[],
    approve?: SpecialistApproval,
    excludeRequest?: string,
  ) {
    const eligible = candidates.filter(
      (route) =>
        this.receipts.modelPolicies.resolve(a.leadSessionId, route.accountId, route.model)
          .admission !== 'off',
    );
    if (!eligible.length) throw Error('Selected model is Off in the current Symposium policy');
    // Never silently replace the proposed route, even with another approved model.
    const proposed = candidates[0];
    const settings = this.receipts.assertModelAllowance(a.leadSessionId, proposed, excludeRequest);
    let route = proposed;
    // Each route's revision fingerprints its own effective rule.
    let approvedRevision = settings.revision;
    if (settings.admission === 'ask') {
      // The proposed route must be usable. An alternative that cannot resolve
      // or has no allowance left is omitted from the options, so one stale
      // alternative cannot block every Ask admission for this role.
      await this.resolveRoute(proposed);
      const options: { route: SpecialistRoute; revision: string }[] = [
        { route: proposed, revision: settings.revision },
      ];
      for (const candidate of eligible) {
        if (candidate === proposed) continue;
        try {
          const candidateSettings = this.receipts.assertModelAllowance(
            a.leadSessionId,
            candidate,
            excludeRequest,
          );
          await this.resolveRoute(candidate);
          options.push({ route: candidate, revision: candidateSettings.revision });
        } catch (cause) {
          log.info('Specialist alternative omitted from admission options', {
            stage: 'specialist_admission',
            code: 'alternative_unavailable',
            leadSessionId: a.leadSessionId,
            policyId: policy.policyId,
            role: candidate.role,
            accountId: candidate.accountId,
            model: candidate.model,
            err: cause,
          });
        }
      }
      const display = {
        kind: 'specialist_admission',
        policyId: policy.policyId,
        role: proposed.role,
        maxConsultations: policy.maxConsultations,
        modelPolicyRevision: settings.revision,
        routes: options.map(({ route: candidate, revision }) => ({
          ...candidate,
          modelPolicyRevision: revision,
          accountLabel: loadAccountProfiles().resolve(candidate.accountId, candidate.model)
            .accountLabel,
        })),
      };
      const decision = await approve?.(display);
      if (!decision) throw Error('Specialist admission was not approved');
      if (decision !== true) {
        const { routeIndex, ...rest } = decision;
        if (
          !isDeepStrictEqual(rest, display) ||
          !Number.isInteger(routeIndex) ||
          Number(routeIndex) < 0 ||
          Number(routeIndex) >= options.length
        )
          throw Error('Consultation approval changed protected fields');
        ({ route, revision: approvedRevision } = options[Number(routeIndex)]);
      }
    }
    this.current(a);
    const current = this.receipts.assertModelAllowance(a.leadSessionId, route, excludeRequest);
    if (current.revision !== approvedRevision)
      throw Error('Model policy changed during approval; review again');
    await this.resolveRoute(route);
    this.current(a);
    if (
      this.receipts.modelPolicies.resolve(a.leadSessionId, route.accountId, route.model)
        .revision !== current.revision
    )
      throw Error('Model policy changed during approval; review again');
    return { route, revision: current.revision };
  }
  private run(a: SpecialistAuthority, policy: SpecialistPolicy, record: ConsultationRecord) {
    const pending = this.pending.get(a.leadSessionId);
    if (pending) {
      if (pending.requestId !== record.requestId)
        throw Error(
          'Another consultation is preparing; retain this requestId and retry after it settles',
        );
      return pending.result;
    }
    const cancel = new AbortController();
    const result = this.execute(a, policy, record, cancel.signal).finally(() =>
      this.pending.delete(a.leadSessionId),
    );
    this.pending.set(a.leadSessionId, { requestId: record.requestId, cancel, result });
    return result;
  }
  private async execute(
    a: SpecialistAuthority,
    policy: SpecialistPolicy,
    original: ConsultationRecord,
    stopSignal: AbortSignal,
  ) {
    const signal = AbortSignal.any([a.signal, stopSignal]);
    let record = original;
    let stage = 'preparation';
    let chargedHere = false;
    const assertCurrent = () => {
      signal.throwIfAborted();
      this.current(a);
      const latestPolicy = this.receipts.assertPolicy(a.leadSessionId, a.auth.id, policy.policyId);
      this.receipts.assertAllowance(a.leadSessionId, latestPolicy, record.requestId);
      const settings = this.receipts.assertModelAllowance(
        a.leadSessionId,
        record.route,
        record.requestId,
      );
      if (record.modelPolicyRevision !== settings.revision)
        throw Error('Model policy changed before admission; recover the original request');
      const current = this.receipts.read(a.leadSessionId, record.requestId);
      if (current.state === 'stopped') throw Error('Specialist consultation was stopped');
      if (current.revision !== record.revision)
        throw Error('Specialist consultation ownership changed');
      this.assertAudience(policy, record.sessionId);
    };
    const update = (patch: Parameters<SpecialistConsultationStore['update']>[3]) => {
      record = this.receipts.update(a.leadSessionId, record.requestId, record.revision, patch);
    };
    try {
      record = this.receipts.claimAllowance(a.leadSessionId, a.auth.id, record.requestId);
      assertCurrent();
      const resolved = await this.resolveRoute(record.route);
      assertCurrent();
      const routing = specialistRoleExecution(policy, record, loadAccountProfiles());
      if (routing.kind !== 'selected')
        throw Error('Specialist role routing refused: ' + routing.code);
      update({ state: 'preparing', routingAudit: routing.audit });
      const workspace = this.owners.workspaces();
      let reviewed = record.review
        ? CollaborationApplicationReviewResultSchema.parse(record.review)
        : undefined;
      let messageInput = record.messageInput
        ? CollaborationMessageInputSchema.parse(record.messageInput)
        : undefined;
      if (!messageInput && !reviewed) {
        await workspace.preview(
          resolved.binding,
          policy.connectionId,
          policy.repository,
          signal,
          {
            runOn: record.route.runOn,
            runtime: {
              account: resolved.runtime.account,
              harness: resolved.runtime.harness.implementation,
              targetId: resolved.runtime.execution.targetId,
            },
          },
          record.workspaceId,
        );
        assertCurrent();
        await workspace.prepare(record.workspaceId, resolved.binding, signal);
        assertCurrent();
        stage = 'context_review';
        const reviewOwner = new CollaborationApplicationReview({
          store: this.owners.events,
          workspaces: workspace,
          authorizeOperator: () => assertCurrent(),
        });
        const view = this.assertAudience(policy, null);
        reviewed = await reviewOwner.review(
          a.auth,
          a.operatorConnectionId,
          policy.collaborationId,
          {
            selection: {
              requestId: record.reviewRequestId,
              expectedMembershipRevision: view.membershipRevision,
              sourceConversationId: a.leadSessionId,
              boundary: record.boundary,
              mode: 'selected',
              messageIds: record.input.messageIds,
              artifacts: record.input.artifacts,
              purpose: record.input.assignment.slice(0, 4000),
              joiningBrief: record.input.assignment,
            },
            target: {
              runOn: record.route.runOn,
              accountId: record.route.accountId,
              model: record.route.model,
              reasoningEffort: record.route.reasoningEffort,
              agent: record.route.agent,
              repositoryWorkspaceId: record.workspaceId,
              permissionMode: record.route.permissionMode ?? 'ask',
            },
          },
          signal,
        );
        assertCurrent();
        update({ state: 'reviewed', review: reviewed });
      }
      let text = record.input.assignment;
      if (record.input.reviewOf) {
        const previous = this.read(a, record.input.reviewOf);
        if (previous.status !== 'completed')
          throw Error('The original contribution is no longer available');
        text +=
          '\n\nIndependent review of attributed contribution:\n' +
          JSON.stringify(previous.contributions);
      }
      if (
        Buffer.byteLength(JSON.stringify(reviewed?.snapshot ?? null) + text, 'utf8') >
        policy.maxContextBytes
      )
        throw Error('Selected context exceeds the approved byte limit; narrow it explicitly');
      if (!messageInput) {
        if (!reviewed) throw Error('Original consultation review is unavailable');
        stage = 'joining';
        const joined = await createApplicationCollaborationJoining(
          { store: this.owners.events, workspaces: workspace },
          a.auth,
        ).confirm(
          a.auth.id,
          policy.collaborationId,
          {
            requestId: record.joinRequestId,
            expectedMembershipRevision: reviewed.expectedMembershipRevision,
            name: resolved.agent.definition.name,
            settings: reviewed.settings,
            snapshot: {
              snapshotId: reviewed.snapshot.snapshotId,
              sha256: reviewed.snapshot.sha256,
            },
          },
          signal,
        );
        assertCurrent();
        if (joined.state !== 'linked' || !joined.sessionId)
          throw Error('Specialist joining is incomplete; preserve its original join receipt');
        update({ state: 'joined', sessionId: joined.sessionId, joinId: joined.joinId });
        const current = this.assertAudience(policy, joined.sessionId);
        messageInput = CollaborationMessageInputSchema.parse({
          requestId: record.sendRequestId,
          expectedMembershipRevision: current.membershipRevision,
          expectedPolicySequence: current.policySequence,
          text,
          responders: { kind: 'selected', sessionIds: [joined.sessionId] },
          snapshot: null,
        });
        stage = 'delivery';
        update({ messageInput });
      }
      stage = 'delivery';
      assertCurrent();
      chargedHere = record.allowanceState !== 'charged';
      update({ allowanceState: 'charged' });
      await this.owners.messaging.send(
        a.auth,
        policy.collaborationId,
        messageInput,
        signal,
        assertCurrent,
      );
      assertCurrent();
      update({ state: 'dispatched' });
      return this.read(a, record.requestId);
    } catch (cause) {
      const diagnostic = specialistDiagnostic(cause);
      const current = this.receipts.read(a.leadSessionId, record.requestId);
      // Messaging durably retains the request before any dispatch. Absence after
      // send has settled proves this attempt never entered delivery. Never refund
      // legacy or previously uncertain charges on this evidence alone.
      const refusedBeforeDelivery =
        chargedHere &&
        record.messageInput &&
        !this.owners.events.collaborationConversation.getMessageForRequest(
          policy.collaborationId,
          record.messageInput,
        );
      const allowanceState =
        current.allowanceState === 'charged' && !refusedBeforeDelivery ? 'charged' : 'released';
      const details = {
        sessionId: a.leadSessionId,
        requestId: record.requestId,
        policyId: policy.policyId,
        stage,
        code: current.state === 'stopped' ? 'specialist_consultation_stopped' : diagnostic.code,
      };
      if (current.state === 'stopped') log.info('Specialist preparation stopped', details);
      else log.warn('Specialist consultation could not complete', { ...details, err: cause });
      if (current.state !== 'stopped' && current.revision === record.revision)
        this.receipts.update(a.leadSessionId, record.requestId, current.revision, {
          state: 'uncertain',
          allowanceState,
          diagnostic: {
            code: diagnostic.code,
            stage,
            message:
              diagnostic.message +
              ' Read or recover the original request; do not submit a replacement.',
          },
        });
      else if (current.state === 'stopped' && refusedBeforeDelivery)
        this.receipts.update(a.leadSessionId, record.requestId, current.revision, {
          allowanceState,
        });
      this.current(a);
      return this.read(a, record.requestId);
    }
  }
  revoke(a: SpecialistAuthority, policyId: string) {
    this.current(a);
    const policy = this.receipts.revoke(a.leadSessionId, policyId);
    const pending = this.pending.get(a.leadSessionId);
    if (pending && this.receipts.read(a.leadSessionId, pending.requestId).policyId === policyId)
      pending.cancel.abort();
    return policy;
  }
  async stop(a: SpecialistAuthority, requestId: string) {
    this.current(a);
    const record = this.receipts.read(a.leadSessionId, requestId);
    const policy = this.receipts.policy(a.leadSessionId, record.policyId);
    const stopped =
      record.state === 'stopped'
        ? record
        : this.receipts.update(a.leadSessionId, requestId, record.revision, {
            state: 'stopped',
            allowanceState: record.allowanceState === 'charged' ? 'charged' : 'released',
          });
    const pending = this.pending.get(a.leadSessionId);
    if (pending?.requestId === requestId) pending.cancel.abort();
    const accepted =
      stopped.messageInput &&
      this.owners.events.collaborationConversation.getMessageForRequest(
        policy.collaborationId,
        stopped.messageInput,
      );
    const result = accepted
      ? await this.owners.messaging.stop(a.auth, policy.collaborationId, stopped.messageInput)
      : null;
    this.current(a);
    return { ...this.read(a, requestId), stop: result };
  }
}
