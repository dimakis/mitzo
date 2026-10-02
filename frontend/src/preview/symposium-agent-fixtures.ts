// In-memory UI simulation only. No native admission, provider execution, or persistence.
import {
  SeatConfigSchema,
  type SymposiumConfig,
  type SymposiumDeliveryRecord,
} from '@mitzo/protocol';
import { account } from './fixtures';
import { symposiumStatus } from './symposium-fixtures';

type Fixture = {
  config: SymposiumConfig;
  deliveries: SymposiumDeliveryRecord[];
  admitted: Set<string>;
};
const fixtures = new Map<string, Fixture>();
function fixtureFor(sessionId: string): Fixture {
  let fixture = fixtures.get(sessionId);
  if (!fixture) {
    const config = structuredClone(symposiumStatus(sessionId).config) as unknown as SymposiumConfig;
    if (sessionId === 'preview-1')
      config.seats = config.seats.filter((seat) => seat.id !== 'implementer');
    fixture = { config, deliveries: [], admitted: new Set(config.seats.map((seat) => seat.id)) };
    fixtures.set(sessionId, fixture);
  }
  return fixture;
}
function statusFor(sessionId: string, fixture: Fixture) {
  return {
    ...symposiumStatus(sessionId),
    config: fixture.config,
    simulated: true,
    reservedSeats: fixture.config.seats.length,
    capacityRemaining: 3 - fixture.config.seats.length,
    deliveries: fixture.deliveries,
    seats: fixture.config.seats.map((seat) => ({
      seatId: seat.id,
      seat,
      admitted: fixture.admitted.has(seat.id),
      membership: fixture.admitted.has(seat.id)
        ? { generation: 1, state: 'active', reconciliation: 'confirmed' }
        : null,
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
    fixture.config = {
      ...fixture.config,
      revision: fixture.config.revision + 1,
      activeSeatCap: 3,
      seats: [...fixture.config.seats, parsed.data],
    } as SymposiumConfig;
    return Response.json(fixture.config);
  }
  if (suffix === 'admissions/refresh') return Response.json({ simulated: true, inference: false });
  if (
    suffix === 'membership' &&
    typeof body.seatId === 'string' &&
    fixture.config.seats.some((seat) => seat.id === body.seatId)
  ) {
    fixture.admitted.add(body.seatId);
    return Response.json({ simulated: true });
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
        membershipGeneration: 1,
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
