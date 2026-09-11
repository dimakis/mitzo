import type {
  SeatConfig,
  SymposiumAdmissionDecision,
  SymposiumAdmissionRecord,
  SymposiumConfig,
  SymposiumDeliveryRecord,
  SymposiumIntervention,
  SymposiumProvenance,
} from '@mitzo/protocol';
import { randomUUID } from 'node:crypto';
import type { EventStore } from './event-store.js';

/** Narrow provider boundary. Phase 2 deliberately supplies only fakes.
 * Implementations must reconcile repeated idempotency keys to one provider turn.
 */
export interface SymposiumSeatExecution {
  sessionId: string;
  deliveryId: string;
  seat: SeatConfig;
  content: string;
  idempotencyKey: string;
  providerThreadId?: string;
  provenance: SymposiumProvenance;
  signal: AbortSignal;
}

export interface SymposiumSeatExecutionResult {
  providerThreadId: string;
  content: string;
  costUsd?: number;
}

export interface SymposiumSeatExecutor {
  execute(input: SymposiumSeatExecution): Promise<SymposiumSeatExecutionResult>;
  cancel?(input: { providerThreadId?: string; idempotencyKey: string }): Promise<void>;
}

export interface SymposiumOrchestratorDeps {
  store: EventStore;
  executors: Record<string, SymposiumSeatExecutor>;
  idFactory?: () => string;
  claimIdFactory?: () => string;
  now?: () => number;
}

export class SymposiumOrchestrator {
  private readonly store: EventStore;
  private readonly executors: Record<string, SymposiumSeatExecutor>;
  private readonly idFactory: () => string;
  private readonly claimIdFactory: () => string;
  private readonly now: () => number;
  private readonly running = new Map<string, Promise<SymposiumDeliveryRecord>>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(deps: SymposiumOrchestratorDeps) {
    this.store = deps.store;
    this.executors = deps.executors;
    this.idFactory = deps.idFactory ?? randomUUID;
    this.claimIdFactory = deps.claimIdFactory ?? randomUUID;
    this.now = deps.now ?? Date.now;
  }

  recordProviderAdmission(input: {
    sessionId: string;
    seatId: string;
    decision: SymposiumAdmissionDecision;
    reason?: string;
    idempotencyKey: string;
  }): SymposiumAdmissionRecord {
    requireText(input.idempotencyKey, 'Admission idempotency key');
    const prior = this.store.getSymposiumAdmissionByIdempotencyKey(
      input.sessionId,
      input.idempotencyKey,
    );
    if (prior) {
      if (
        prior.seatId !== input.seatId ||
        prior.decision !== input.decision ||
        prior.reason !== (input.reason?.trim() || null)
      ) {
        throw new Error('Symposium admission idempotency key was reused with different input');
      }
      return prior;
    }
    const config = this.requireDirectedManualConfig(input.sessionId);
    const seat = config.seats.find((candidate) => candidate.id === input.seatId);
    if (!seat) throw new Error('Unknown Symposium seat');
    const binding = requireActiveSeat(seat);
    const record: SymposiumAdmissionRecord = {
      admissionId: `admission:${input.sessionId}:${input.idempotencyKey}`,
      sessionId: input.sessionId,
      seatId: seat.id,
      decision: input.decision,
      reason: input.reason?.trim() || null,
      idempotencyKey: input.idempotencyKey,
      configRevision: config.revision,
      provider: binding.accountBinding.provider,
      accountId: binding.accountBinding.accountId,
      model: binding.accountBinding.model,
      accountProfileRevision: binding.accountBinding.profileRevision,
      isolationDomainId: binding.isolationRequest.trustDomainId,
      isolationDomainRevision: binding.isolationRequest.revision,
      decidedAt: this.now(),
    };
    return this.store.recordSymposiumAdmission(record);
  }

  stageDelivery(input: {
    sessionId: string;
    sourceSeatId: string | null;
    recipientSeatIds: string[];
    originalContent: string;
    idempotencyKey: string;
  }): SymposiumDeliveryRecord {
    requireText(input.originalContent, 'Original delivery content');
    requireText(input.idempotencyKey, 'Delivery idempotency key');
    const prior = this.store.getSymposiumDeliveryByIdempotencyKey(
      input.sessionId,
      input.idempotencyKey,
    );
    if (prior) {
      if (
        prior.sourceSeatId !== input.sourceSeatId ||
        prior.originalContent !== input.originalContent ||
        !sameMembers(prior.recipientSeatIds, input.recipientSeatIds)
      ) {
        throw new Error('Symposium delivery idempotency key was reused with different input');
      }
      return prior;
    }
    const config = this.requireDirectedManualConfig(input.sessionId);
    const seatIds = new Set(config.seats.map((seat) => seat.id));
    if (input.sourceSeatId !== null && !seatIds.has(input.sourceSeatId)) {
      throw new Error('Unknown Symposium source seat');
    }
    if (
      input.recipientSeatIds.length === 0 ||
      input.recipientSeatIds.length > config.seats.length ||
      new Set(input.recipientSeatIds).size !== input.recipientSeatIds.length ||
      input.recipientSeatIds.some((seatId) => !seatIds.has(seatId))
    ) {
      throw new Error('Delivery recipients must be one or two distinct configured seats');
    }

    const sourceSeat =
      input.sourceSeatId === null
        ? undefined
        : config.seats.find((seat) => seat.id === input.sourceSeatId);
    const recipients = config.seats.filter((seat) => input.recipientSeatIds.includes(seat.id));
    const admittedSeats = config.seats.filter(
      (seat) =>
        seat.id === sourceSeat?.id || recipients.some((recipient) => recipient.id === seat.id),
    );
    for (const seat of admittedSeats) {
      const admission = this.store.getLatestSymposiumAdmission(
        input.sessionId,
        seat.id,
        config.revision,
      );
      if (admission?.decision !== 'admitted') {
        throw new Error(`Provider for Symposium seat ${seat.id} is not admitted`);
      }
    }

    const deliveryId = this.idFactory();
    const timestamp = this.now();
    return this.store.createSymposiumDelivery({
      deliveryId,
      sessionId: input.sessionId,
      sourceSeatId: input.sourceSeatId,
      recipientSeatIds: recipients.map((seat) => seat.id),
      originalContent: input.originalContent,
      deliveredContent: null,
      status: 'awaiting_intervention',
      intervention: null,
      interventionReason: null,
      idempotencyKey: input.idempotencyKey,
      configRevision: config.revision,
      sourceProvenance: sourceSeat ? provenanceFor(sourceSeat, config.revision) : null,
      cancellationReason: null,
      cancellationIdempotencyKey: null,
      cancelledAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      recipients: recipients.map((seat) => {
        const active = requireActiveSeat(seat);
        return {
          deliveryId,
          seatId: seat.id,
          status: 'pending',
          idempotencyKey: `delivery:${deliveryId}:seat:${seat.id}`,
          configRevision: config.revision,
          accountProfileRevision: active.accountBinding.profileRevision,
          seatProfileRevision: active.profileBinding.profileRevision,
          contextGrantId: active.contextGrant.grantId,
          contextGrantRevision: active.contextGrant.revision,
          authorityGrantId: active.authorityGrant.grantId,
          authorityGrantRevision: active.authorityGrant.revision,
          isolationDomainId: active.isolationRequest.trustDomainId,
          isolationDomainRevision: active.isolationRequest.revision,
          providerThreadId: null,
          resultContent: null,
          costUsd: 0,
          error: null,
          updatedAt: timestamp,
        };
      }),
    });
  }

  intervene(input: {
    deliveryId: string;
    action: SymposiumIntervention;
    content?: string;
    reason?: string;
    idempotencyKey: string;
  }): SymposiumDeliveryRecord {
    requireText(input.idempotencyKey, 'Intervention idempotency key');
    if ((input.action === 'edit' || input.action === 'replace') && !input.content?.trim()) {
      throw new Error(`${input.action} requires delivered content`);
    }
    if (input.action !== 'edit' && input.action !== 'replace' && input.content !== undefined) {
      throw new Error(`${input.action} does not accept replacement content`);
    }
    return this.store.recordSymposiumIntervention({
      deliveryId: input.deliveryId,
      action: input.action,
      content: input.content ?? null,
      reason: input.reason?.trim() || null,
      idempotencyKey: input.idempotencyKey,
      createdAt: this.now(),
    });
  }

  deliver(deliveryId: string): Promise<SymposiumDeliveryRecord> {
    const existing = this.running.get(deliveryId);
    if (existing) return existing;
    const promise = this.executeDelivery(deliveryId).finally(() => {
      this.running.delete(deliveryId);
      this.abortControllers.delete(deliveryId);
    });
    this.running.set(deliveryId, promise);
    return promise;
  }

  async cancel(input: {
    deliveryId: string;
    reason?: string;
    idempotencyKey: string;
  }): Promise<SymposiumDeliveryRecord> {
    requireText(input.idempotencyKey, 'Cancellation idempotency key');
    const before = this.store.getSymposiumDelivery(input.deliveryId);
    if (!before) throw new Error('Unknown Symposium delivery');
    const cancelled = this.store.cancelSymposiumDelivery({
      deliveryId: input.deliveryId,
      reason: input.reason?.trim() || null,
      idempotencyKey: input.idempotencyKey,
      cancelledAt: this.now(),
    });
    this.abortControllers.get(input.deliveryId)?.abort();
    await Promise.all(
      before.recipients
        .filter((recipient) => recipient.status === 'executing')
        .map(async (recipient) => {
          const executor = this.executors[recipient.seatId];
          if (!executor?.cancel) return;
          await executor.cancel({
            providerThreadId: recipient.providerThreadId ?? undefined,
            idempotencyKey: recipient.idempotencyKey,
          });
        }),
    );
    return cancelled;
  }

  recover(): SymposiumDeliveryRecord[] {
    return this.store.recoverSymposiumDeliveries(this.now());
  }

  private async executeDelivery(deliveryId: string): Promise<SymposiumDeliveryRecord> {
    let delivery = this.store.getSymposiumDelivery(deliveryId);
    if (!delivery) throw new Error('Unknown Symposium delivery');
    if (delivery.status !== 'ready') return delivery;
    const config = this.requireDirectedManualConfig(delivery.sessionId);
    if (config.revision !== delivery.configRevision) {
      throw new Error('Delivery configuration revision is stale');
    }
    if (!this.store.claimSymposiumDelivery(deliveryId, config.turnRules.maxTurns)) {
      return this.store.getSymposiumDelivery(deliveryId)!;
    }

    const abortController = new AbortController();
    this.abortControllers.set(deliveryId, abortController);
    delivery = this.store.getSymposiumDelivery(deliveryId)!;
    for (const recipient of delivery.recipients) {
      let currentConfig: SymposiumConfig;
      try {
        currentConfig = this.requireDirectedManualConfig(delivery.sessionId);
        if (currentConfig.revision !== delivery.configRevision) {
          throw new Error('Delivery configuration revision is stale');
        }
        const admission = this.store.getLatestSymposiumAdmission(
          delivery.sessionId,
          recipient.seatId,
          currentConfig.revision,
        );
        if (admission?.decision !== 'admitted') {
          throw new Error(`Provider for Symposium seat ${recipient.seatId} is not admitted`);
        }
      } catch (error) {
        this.store.failSymposiumRecipient({
          deliveryId,
          seatId: recipient.seatId,
          error: error instanceof Error ? error.message : String(error),
          updatedAt: this.now(),
        });
        break;
      }
      const seat = currentConfig.seats.find((candidate) => candidate.id === recipient.seatId)!;
      const executor = this.executors[recipient.seatId];
      if (!executor) {
        this.store.failSymposiumRecipient({
          deliveryId,
          seatId: recipient.seatId,
          error: `No executor was injected for Symposium seat ${recipient.seatId}`,
          updatedAt: this.now(),
        });
        break;
      }
      const bindingKey = seatBindingKey(seat);
      const claim = this.store.claimSymposiumRecipientExecution({
        sessionId: delivery.sessionId,
        deliveryId,
        seatId: seat.id,
        bindingKey,
        recipientIdempotencyKey: recipient.idempotencyKey,
        claimToken: this.claimIdFactory(),
        claimedAt: this.now(),
      });
      if (!claim) break;
      const thread = claim.thread;
      try {
        if (abortController.signal.aborted) return this.store.getSymposiumDelivery(deliveryId)!;
        const result = await executor.execute({
          sessionId: delivery.sessionId,
          deliveryId,
          seat,
          content: delivery.deliveredContent!,
          idempotencyKey: recipient.idempotencyKey,
          providerThreadId: thread?.providerThreadId,
          provenance: provenanceFor(seat, currentConfig.revision),
          signal: abortController.signal,
        });
        const timestamp = this.now();
        delivery = this.store.completeSymposiumRecipient({
          sessionId: delivery.sessionId,
          deliveryId,
          seatId: seat.id,
          bindingKey,
          providerThreadId: result.providerThreadId,
          configRevision: currentConfig.revision,
          threadCreatedAt: thread?.createdAt ?? timestamp,
          resultContent: result.content,
          costUsd: result.costUsd ?? 0,
          updatedAt: timestamp,
          claimToken: claim.claimToken,
        });
      } catch (error) {
        const latest = this.store.getSymposiumDelivery(deliveryId)!;
        if (latest.status === 'cancelled' || abortController.signal.aborted) return latest;
        this.store.failSymposiumRecipient({
          deliveryId,
          seatId: seat.id,
          error: error instanceof Error ? error.message : String(error),
          updatedAt: this.now(),
          claimToken: claim.claimToken,
        });
        break;
      }
    }
    return this.store.getSymposiumDelivery(deliveryId)!;
  }

  private requireDirectedManualConfig(sessionId: string) {
    const config = this.store.getActiveSymposiumConfig(sessionId);
    if (config.turnRules.mode !== 'directed' || config.interceptMode !== 'manual') {
      throw new Error('Phase 2 supports directed turns with manual interception only');
    }
    return config;
  }
}

function requireActiveSeat(seat: SeatConfig) {
  if (
    !seat.accountBinding ||
    !seat.profileBinding ||
    !seat.contextGrant ||
    !seat.authorityGrant ||
    !seat.isolationRequest
  ) {
    throw new Error(`Symposium seat ${seat.id} is not active`);
  }
  return {
    accountBinding: seat.accountBinding,
    profileBinding: seat.profileBinding,
    contextGrant: seat.contextGrant,
    authorityGrant: seat.authorityGrant,
    isolationRequest: seat.isolationRequest,
  };
}

function provenanceFor(seat: SeatConfig, configRevision: number): SymposiumProvenance {
  const active = requireActiveSeat(seat);
  return {
    seatId: seat.id,
    configRevision,
    accountProfileRevision: active.accountBinding.profileRevision,
    seatProfileRevision: active.profileBinding.profileRevision,
    contextGrantRevision: active.contextGrant.revision,
    authorityGrantRevision: active.authorityGrant.revision,
    isolationDomainId: active.isolationRequest.trustDomainId,
    isolationDomainRevision: active.isolationRequest.revision,
  };
}

function seatBindingKey(seat: SeatConfig): string {
  const active = requireActiveSeat(seat);
  return JSON.stringify([
    active.accountBinding.provider,
    active.accountBinding.accountId,
    active.accountBinding.model,
    active.accountBinding.profileRevision,
    active.profileBinding.profileId,
    active.profileBinding.profileRevision,
    active.contextGrant.grantId,
    active.contextGrant.revision,
    active.authorityGrant.grantId,
    active.authorityGrant.revision,
    active.isolationRequest.trustDomainId,
    active.isolationRequest.revision,
  ]);
}

function requireText(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}

function sameMembers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
