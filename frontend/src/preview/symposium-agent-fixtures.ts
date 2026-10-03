// In-memory UI simulation only. No native admission, provider execution, or persistence.
import {
  SeatConfigSchema,
  SymposiumConfigSchema,
  SymposiumConfigurationOperationSchema,
  SymposiumConfigurationOperationKeySchema,
  SymposiumConfigurationOperationReceiptSchema,
  canonicalConfigurationOperationJson,
  type SeatConfig,
  type SymposiumConfigurationOperationReceipt,
  type SymposiumConfig,
  type SymposiumDeliveryRecord,
  type SymposiumMembershipRecord,
} from '@mitzo/protocol';
import { account } from './fixtures';
import { symposiumStatus } from './symposium-fixtures';

type PreviewMembership = SymposiumMembershipRecord & { simulated: true };
type Fixture = {
  config: SymposiumConfig;
  deliveries: SymposiumDeliveryRecord[];
  admitted: Set<string>;
  memberships: Map<string, PreviewMembership>;
  membershipReceipts: Map<string, PreviewMembership>;
  configurationReceipts: Map<string, SymposiumConfigurationOperationReceipt>;
};
const fixtures = new Map<string, Fixture>();
function simulatedGrantedSeat(seat: SeatConfig): SeatConfig {
  return {
    ...seat,
    profileBinding: seat.profileBinding ?? {
      profileId: `preview-${seat.id}`,
      profileRevision: '1',
    },
    contextGrant: {
      grantId: `preview-context:${seat.id}`,
      revision: 1,
      classification: 'mixed',
      sourceRefs: [],
    },
    authorityGrant: {
      grantId: `preview-authority:${seat.id}`,
      revision: 1,
      filesystem: seat.authorityRequest?.filesystem ?? 'read',
      tools: seat.authorityRequest?.tools ?? 'read',
      network: 'restricted',
    },
    isolationRequest: {
      trustDomainId: 'preview-shared',
      revision: 1,
      placement: 'reuse-compatible',
    },
  };
}
function fixtureFor(sessionId: string): Fixture {
  let fixture = fixtures.get(sessionId);
  if (!fixture) {
    const config = structuredClone(symposiumStatus(sessionId).config) as unknown as SymposiumConfig;
    if (sessionId === 'preview-1')
      config.seats = config.seats.filter((seat) => seat.id !== 'implementer');
    config.seats = config.seats.map(simulatedGrantedSeat);
    fixture = {
      config: SymposiumConfigSchema.parse(config),
      deliveries: [],
      membershipReceipts: new Map(),
      configurationReceipts: new Map(),
      admitted: new Set(config.seats.map((seat) => seat.id)),
      memberships: new Map(
        config.seats.map((seat) => [
          seat.id,
          {
            sessionId,
            seatId: seat.id,
            configRevision: config.revision,
            generation: 1,
            action: 'admit',
            reason: 'Configured preview agent',
            state: 'active',
            reconciliation: 'confirmed',
            actor: 'preview-fixture',
            bindingKey: 'preview-simulated',
            idempotencyKey: `preview-initial:${sessionId}:${seat.id}`,
            occurredAt: Date.now(),
            replacesSeatId: null,
            replacedBySeatId: null,
            simulated: true,
          },
        ]),
      ),
    };
    for (const record of fixture.memberships.values())
      fixture.membershipReceipts.set(record.idempotencyKey, record);
    fixtures.set(sessionId, fixture);
  }
  return fixture;
}
function statusFor(sessionId: string, fixture: Fixture) {
  return {
    ...symposiumStatus(sessionId),
    config: fixture.config,
    symposiumRevision: fixture.config.revision,
    simulated: true,
    reservedSeats: fixture.config.seats.length,
    capacityRemaining: 3 - fixture.config.seats.length,
    deliveries: fixture.deliveries,
    seats: fixture.config.seats.map((seat) => ({
      seatId: seat.id,
      seat,
      admitted: fixture.admitted.has(seat.id),
      membership: fixture.memberships.get(seat.id) ?? null,
    })),
  };
}
export function symposiumAgentPreviewResponse(
  path: string,
  method: string,
  body: Record<string, unknown> = {},
): Response | null {
  const match = /^\/api\/sessions\/(preview-[13])\/symposium(?:\/(.*))?$/.exec(path);
  if (!match) return null;
  const [, sessionId, suffix = ''] = match;
  const fixture = fixtureFor(sessionId);
  const denied = () =>
    Response.json(
      { error: 'Unsupported simulated agent request', simulated: true },
      { status: 405 },
    );
  if (suffix.startsWith('configuration-operations/') && method === 'GET') {
    let key: string;
    try {
      key = decodeURIComponent(suffix.slice('configuration-operations/'.length));
    } catch {
      return denied();
    }
    if (!SymposiumConfigurationOperationKeySchema.safeParse(key).success) return denied();
    return Response.json({
      receipt: fixture.configurationReceipts.get(key) ?? null,
      simulated: true,
    });
  }
  if (suffix === 'status' && method === 'GET') {
    const saved = statusFor(sessionId, fixture);
    return Response.json({
      ...saved,
      statusMode: 'durable',
      runtimeVerification: 'not_checked',
      runtimeAvailable: false,
      seats: saved.seats.map((seat) => ({
        ...seat,
        admitted: false,
        admissionRecorded: seat.admitted,
        savedRuntimeState: seat.admitted ? 'ready' : null,
      })),
    });
  }
  if (!suffix && method === 'GET') return Response.json(statusFor(sessionId, fixture));
  if (method !== 'POST') return null;
  if (suffix === 'context-package') {
    if (body.mode === 'independent') return Response.json({ content: '', simulated: true });
    if (body.mode === 'summary' && typeof body.summary === 'string')
      return Response.json({ content: body.summary, simulated: true });
    if (
      body.mode === 'full-context' ||
      (body.mode === 'selected-turns' && Array.isArray(body.turnIds))
    )
      return Response.json({
        content: 'Agreed acceptance criteria: preserve isolated accounts and explicit context.',
        simulated: true,
      });
    return denied();
  }
  if (suffix === 'seats/revise') {
    const parsedOperation =
      body.idempotencyKey === undefined
        ? undefined
        : SymposiumConfigurationOperationSchema.safeParse({
            version: 1,
            actor: 'preview-fixture',
            action: 'seats/revise',
            idempotencyKey: body.idempotencyKey,
            expectedRevision: body.expectedRevision,
            request: body,
          });
    if (parsedOperation && !parsedOperation.success) return denied();
    const operation = parsedOperation?.success ? parsedOperation.data : undefined;
    if (operation) {
      const saved = fixture.configurationReceipts.get(operation.idempotencyKey);
      if (saved) {
        const savedOperation = {
          version: saved.version,
          actor: saved.actor,
          action: saved.action,
          idempotencyKey: saved.idempotencyKey,
          expectedRevision: saved.expectedRevision,
          request: saved.request,
        };
        if (
          canonicalConfigurationOperationJson(savedOperation) !==
          canonicalConfigurationOperationJson(operation)
        )
          return Response.json(
            { error: 'Simulated configuration operation key conflict', simulated: true },
            { status: 409 },
          );
        return Response.json(saved.config);
      }
    }
    if (fixture.config.seats.length >= 3)
      return Response.json(
        {
          error: 'Active agent capacity is full (3 seats)',
          simulated: true,
          seatMutation: 'not-started',
        },
        { status: 409 },
      );
    if (
      body.expectedRevision !== fixture.config.revision ||
      body.sharedBoundaryAcknowledged !== true ||
      body.accountId !== account.id ||
      body.model !== account.models[0].id ||
      body.crossAccountConfirmation !== 'ADD CROSS-ACCOUNT SEAT'
    )
      return denied();
    const parsed = SeatConfigSchema.safeParse({
      id: body.seatId,
      name: body.name,
      role: body.role,
      model: body.model,
      systemPrompt: body.systemPrompt,
      expectedOutput: body.expectedOutput,
      acceptanceCriteria: body.acceptanceCriteria,
      authorityRequest: body.authorityRequest,
      color: body.color,
      reasoningEffort: body.reasoningEffort,
      ...(body.profileSelection && typeof body.profileSelection === 'object'
        ? {
            profileBinding: {
              profileId: (body.profileSelection as { profileId: unknown }).profileId,
              profileRevision: String((body.profileSelection as { revision: unknown }).revision),
            },
          }
        : {}),
      accountBinding: {
        accountId: account.id,
        accountLabel: account.label,
        provider: 'openai',
        model: body.model,
        profileRevision: 'preview',
      },
    });
    if (!parsed.success || fixture.config.seats.some((seat) => seat.id === parsed.data.id))
      return denied();
    const next = SymposiumConfigSchema.safeParse({
      ...fixture.config,
      revision: fixture.config.revision + 1,
      activeSeatCap: 3,
      seats: [...fixture.config.seats, simulatedGrantedSeat(parsed.data)],
    });
    if (!next.success) return denied();
    const receipt = operation
      ? SymposiumConfigurationOperationReceiptSchema.safeParse({
          ...operation,
          sessionId,
          config: next.data,
          completedAt: Date.now(),
        })
      : undefined;
    if (receipt && !receipt.success) return denied();
    // The config and its exact proof change together within this synchronous simulation.
    fixture.config = next.data;
    if (receipt?.success)
      fixture.configurationReceipts.set(receipt.data.idempotencyKey, receipt.data);
    return Response.json(fixture.config);
  }
  if (suffix === 'admissions/refresh') return Response.json({ simulated: true, inference: false });
  if (
    suffix === 'membership' &&
    typeof body.seatId === 'string' &&
    fixture.config.seats.some((seat) => seat.id === body.seatId)
  ) {
    if (
      !['admit', 'restore', 'suspend', 'remove'].includes(String(body.action)) ||
      !Number.isInteger(body.expectedGeneration) ||
      Number(body.expectedGeneration) < 0 ||
      typeof body.configRevision !== 'number' ||
      typeof body.reason !== 'string' ||
      typeof body.idempotencyKey !== 'string' ||
      !body.idempotencyKey
    )
      return denied();
    const replay = fixture.membershipReceipts.get(body.idempotencyKey);
    if (replay) {
      if (
        replay.seatId !== body.seatId ||
        replay.action !== body.action ||
        replay.configRevision !== body.configRevision ||
        replay.generation !== Number(body.expectedGeneration) + 1 ||
        replay.reason !== body.reason
      )
        return denied();
      return Response.json(replay);
    }
    const previous = fixture.memberships.get(body.seatId);
    if (
      body.configRevision !== fixture.config.revision ||
      body.expectedGeneration !== (previous?.generation ?? 0) ||
      (body.action === 'admit' && previous) ||
      (body.action === 'restore' && previous?.state !== 'suspended') ||
      (['suspend', 'remove'].includes(String(body.action)) && previous?.state !== 'active')
    )
      return denied();
    const record: PreviewMembership = {
      sessionId,
      seatId: body.seatId,
      configRevision: body.configRevision,
      generation: Number(body.expectedGeneration) + 1,
      action: body.action as SymposiumMembershipRecord['action'],
      reason: body.reason,
      state:
        body.action === 'suspend' ? 'suspended' : body.action === 'remove' ? 'removed' : 'active',
      reconciliation: 'confirmed',
      actor: 'preview-fixture',
      bindingKey: 'preview-simulated',
      idempotencyKey: body.idempotencyKey,
      occurredAt: Date.now(),
      replacesSeatId: null,
      replacedBySeatId: null,
      simulated: true,
    };
    fixture.memberships.set(body.seatId, record);
    fixture.membershipReceipts.set(record.idempotencyKey, record);
    if (record.state === 'active') fixture.admitted.add(body.seatId);
    else fixture.admitted.delete(body.seatId);
    return Response.json(record);
  }
  if (suffix === 'deliveries') {
    if (
      !Array.isArray(body.recipientSeatIds) ||
      !body.recipientSeatIds.length ||
      !body.recipientSeatIds.every((id) => typeof id === 'string' && fixture.admitted.has(id)) ||
      typeof body.originalContent !== 'string' ||
      typeof body.idempotencyKey !== 'string'
    )
      return denied();
    const existing = fixture.deliveries.find(
      (delivery) => delivery.idempotencyKey === body.idempotencyKey,
    );
    if (existing) return Response.json(existing);
    const now = Date.now();
    const deliveryId = `preview-delivery-${fixture.deliveries.length + 1}`;
    const recipients = body.recipientSeatIds as string[];
    const delivery: SymposiumDeliveryRecord = {
      deliveryId,
      sessionId,
      sourceSeatId: null,
      recipientSeatIds: recipients,
      originalContent: body.originalContent,
      deliveredContent: null,
      status: 'awaiting_intervention',
      intervention: null,
      interventionReason: null,
      idempotencyKey: body.idempotencyKey,
      configRevision: fixture.config.revision,
      sourceProvenance: null,
      cancellationReason: null,
      cancellationIdempotencyKey: null,
      cancelledAt: null,
      createdAt: now,
      updatedAt: now,
      recipients: recipients.map((seatId) => ({
        deliveryId,
        seatId,
        membershipGeneration: fixture.memberships.get(seatId)!.generation,
        status: 'pending',
        idempotencyKey: `${body.idempotencyKey}:${seatId}`,
        configRevision: fixture.config.revision,
        accountProfileRevision: 'preview',
        seatProfileRevision: 'preview',
        contextGrantId: 'preview-context',
        contextGrantRevision: 1,
        authorityGrantId: 'preview-authority',
        authorityGrantRevision: 1,
        isolationDomainId: 'preview-simulated',
        isolationDomainRevision: 1,
        providerThreadId: null,
        resultContent: null,
        costUsd: null,
        error: null,
        updatedAt: now,
      })),
    };
    fixture.deliveries.push(delivery);
    return Response.json(delivery);
  }
  const control = /^deliveries\/([^/]+)\/(interventions|dispatch|cancel)$/.exec(suffix);
  if (control) {
    const delivery = fixture.deliveries.find((item) => item.deliveryId === control[1]);
    if (!delivery) return denied();
    if (
      control[2] === 'interventions' &&
      body.action === 'approve' &&
      delivery.status === 'awaiting_intervention'
    ) {
      delivery.status = 'ready';
      delivery.deliveredContent = delivery.originalContent;
      delivery.intervention = 'approve';
    } else if (control[2] === 'dispatch' && delivery.status === 'ready') {
      delivery.status = 'delivering';
      delivery.recipients.forEach((recipient) => {
        recipient.status = 'executing';
      });
    } else if (control[2] === 'cancel' && typeof body.idempotencyKey === 'string') {
      delivery.status = 'cancelled';
      delivery.cancelledAt = Date.now();
      delivery.cancellationIdempotencyKey = body.idempotencyKey;
      delivery.recipients.forEach((recipient) => {
        recipient.status = 'cancelled';
      });
    } else return denied();
    return Response.json(delivery);
  }
  return denied();
}
