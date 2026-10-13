import {
  createSymposiumDirectorConfigurationHandlers,
  crossesAnchorAccount,
  type SymposiumDirectorConfigurationDependencies,
} from './symposium-director-configuration.js';
import { registerAuthSession, type AuthSession } from './auth.js';
import {
  recentAppReauthorizationHandlers,
  requireSameOriginJson,
  requireRecentConnectionAuthorization,
} from './connections-router.js';
import {
  buildSymposiumContextPackage,
  SymposiumContextPackageSchema,
} from './symposium-context-package.js';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { AccountBindingSchema, SymposiumConfigSchema } from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { SymposiumOrchestrator } from './symposium-orchestrator.js';
import type {
  SymposiumPerspective,
  SymposiumPerspectiveItem,
  SymposiumQueuedInput,
} from './symposium-perspectives.js';

type DirectorStore = Pick<
  EventStore,
  | 'getSymposiumConfigurationOperation'
  | 'getSession'
  | 'getActiveSymposiumConfig'
  | 'getSymposiumMembershipHistory'
  | 'getSymposiumAdmissions'
  | 'getSymposiumDeliveries'
  | 'getSymposiumDelivery'
  | 'getSymposiumSourceMessage'
  | 'setSymposiumConfig'
  | 'getSymposiumInitialProfileSelections'
  | 'getSymposiumSeatSandbox'
>;

export interface SymposiumDirectorRouteDeps extends SymposiumDirectorConfigurationDependencies {
  store: DirectorStore;
  artifactReady?: (sessionId: string, seatId: string, generation: number) => boolean;
  /** Can fence existing membership even when runtime cleanup is unavailable. */
  getSafetyOrchestrator(sessionId: string): SymposiumOrchestrator;
  profileBindingEnforced?: boolean;
  getPerspective(
    sessionId: string,
    perspective: SymposiumPerspective,
    options: { afterSeq: number; limit: number },
  ): { items: SymposiumPerspectiveItem[]; nextSeq: number | null };
  getQueuedInputs(sessionId: string, perspective: SymposiumPerspective): SymposiumQueuedInput[];
}
const TransferPrimaryBody = z.strictObject({
  fromSeatId: z.string().trim().min(1),
  toSeatId: z.string().trim().min(1),
  expectedRevision: z.number().int().positive(),
  expectedGeneration: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1000),
  idempotencyKey: z.string().trim().min(1).max(200),
  confirmation: z.literal('TRANSFER PRIMARY SEAT'),
});
const PerspectiveQuery = z.strictObject({
  kind: z.enum(['all', 'seat']),
  seatId: z.string().trim().min(1).optional(),
  afterSeq: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(200).default(200),
});

const MembershipBody = z.strictObject({
  seatId: z.string().trim().min(1),
  action: z.enum(['admit', 'suspend', 'remove', 'restore', 'replace']),
  expectedGeneration: z.number().int().nonnegative(),
  configRevision: z.number().int().positive(),
  reason: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1),
  replacesSeatId: z.string().trim().min(1).optional(),
  sharedBoundaryAcknowledged: z.literal(true).optional(),
  crossAccountConfirmation: z.literal('ADD CROSS-ACCOUNT SEAT').optional(),
});
const StageBody = z.strictObject({
  sourceSeatId: z.null(),
  recipientSeatIds: z.array(z.string().trim().min(1)).min(1),
  originalContent: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1),
});
const ShareExcerptBody = z.strictObject({
  sourceMessageId: z.string().trim().min(1),
  sourceSeatId: z.string().trim().min(1),
  sourceMembershipGeneration: z.number().int().nonnegative().optional(),
  excerpt: z.string().trim().min(1),
  recipientSeatIds: z.array(z.string().trim().min(1)).min(1),
  idempotencyKey: z.string().trim().min(1),
});
const InterventionBody = z.strictObject({
  action: z.enum(['approve', 'edit', 'replace', 'drop', 'retry']),
  content: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().trim().min(1),
});
const CancelBody = z.strictObject({
  reason: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().trim().min(1),
});

export function createSymposiumDirectorRouter(deps: SymposiumDirectorRouteDeps): Router {
  const router = Router({ mergeParams: true });
  router.post('/creation/recovery/app-reauthorize', ...recentAppReauthorizationHandlers());
  const configuration = createSymposiumDirectorConfigurationHandlers(deps);
  router.get('/configuration-operations/:key', configuration.operationReceipt);
  // A null author is not visibility proof. Only delivered broadcasts to every
  // active member at creation qualify; private/legacy authored turns fail closed.
  const sharedTurns = (sessionId: string) => {
    const history = deps.store.getSymposiumMembershipHistory(sessionId);
    return deps.store
      .getSymposiumDeliveries(sessionId)
      .filter((delivery) => {
        if (delivery.status !== 'delivered') return false;
        // Timestamps do not order changes within one millisecond. Without an
        // immutable cross-stream sequence, a tied membership boundary cannot
        // prove that this delivery's fixed audience included every active seat.
        if (history.some((member) => member.occurredAt === delivery.createdAt)) return false;
        const latest = new Map<string, (typeof history)[number]>();
        for (const member of history) {
          if (member.occurredAt > delivery.createdAt) continue;
          const previous = latest.get(member.seatId);
          if (!previous || previous.generation < member.generation)
            latest.set(member.seatId, member);
        }
        const active = [...latest.values()].filter((member) => member.state === 'active');
        return (
          active.length > 1 &&
          active.every((member) => delivery.recipientSeatIds.includes(member.seatId))
        );
      })
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((delivery) => ({
        id: `delivery:${delivery.deliveryId}`,
        content: delivery.deliveredContent ?? delivery.originalContent,
        shareable: true,
      }));
  };
  router.get('/context-turns', (req, res) => {
    const sessionId = (req.params as { id: string }).id;
    if (!deps.store.getSession(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    try {
      res.json({ turns: sharedTurns(sessionId) });
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Context unavailable' });
    }
  });
  router.post('/context-package', (req, res) => {
    const sessionId = (req.params as { id: string }).id;
    if (!deps.store.getSession(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const parsed = SymposiumContextPackageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid context package' });
      return;
    }
    try {
      const turns = ['independent', 'summary'].includes(parsed.data.mode)
        ? []
        : sharedTurns(sessionId);
      res.json({
        content: buildSymposiumContextPackage(parsed.data, turns),
        mode: parsed.data.mode,
      });
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Context unavailable' });
    }
  });
  router.get('/perspectives', (req, res) => {
    const parsed = PerspectiveQuery.safeParse(req.query);
    if (
      !parsed.success ||
      (parsed.data.kind === 'seat' && !parsed.data.seatId) ||
      (parsed.data.kind === 'all' && parsed.data.seatId)
    ) {
      res.status(400).json({ error: 'Invalid Symposium perspective' });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    const session = deps.store.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const config = session.symposiumConfig
      ? SymposiumConfigSchema.safeParse(JSON.parse(session.symposiumConfig))
      : null;
    if (!config?.success) {
      res.status(404).json({ error: 'Symposium is not configured' });
      return;
    }
    const perspective: SymposiumPerspective =
      parsed.data.kind === 'seat' ? { kind: 'seat', seatId: parsed.data.seatId! } : { kind: 'all' };
    if (
      perspective.kind === 'seat' &&
      !config.data.seats.some((seat) => seat.id === perspective.seatId)
    ) {
      res.status(404).json({ error: 'Symposium seat not found' });
      return;
    }
    try {
      const page = deps.getPerspective(sessionId, perspective, {
        afterSeq: parsed.data.afterSeq,
        limit: parsed.data.limit,
      });
      res.json({ ...page, queued: deps.getQueuedInputs(sessionId, perspective) });
    } catch {
      res.status(409).json({ error: 'Symposium perspective needs recovery' });
    }
  });
  router.post('/seats/revise', configuration.reviseSeat);
  router.post('/activate', configuration.activate);
  router.post('/draft', configuration.draft);
  router.post('/selection', configuration.selection);
  // Saved facts are useful for display but never establish current host authority.
  // Routine roster polling must not enter the synchronous production gate.
  const statusHandler =
    (durable: boolean): RequestHandler =>
    (req, res) => {
      const sessionId = (req.params as { id: string }).id;
      const session = deps.store.getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const runtime = durable ? null : deps.getRuntime(sessionId);
      const runtimeAvailable = runtime !== null;
      const projection = durable
        ? { statusMode: 'durable', runtimeVerification: 'not_checked' }
        : {};
      if (session.sessionType !== 'symposium' || !session.symposiumConfig) {
        const binding = AccountBindingSchema.safeParse(session.accountBinding);
        res.json({
          ...projection,
          sessionId,
          config: null,
          symposiumRevision: session.symposiumRevision ?? 0,
          ordinaryAccountId: binding.success ? binding.data.accountId : null,
          seats: [],
          reservedSeats: 0,
          capacityRemaining: 0,
          runtimeAvailable,
          admissions: [],
          deliveries: [],
        });
        return;
      }
      const config = SymposiumConfigSchema.parse(JSON.parse(session.symposiumConfig));
      const history = deps.store.getSymposiumMembershipHistory(sessionId);
      const admissions = deps.store.getSymposiumAdmissions(sessionId);
      const deliveries = deps.store.getSymposiumDeliveries(sessionId);
      const seats = config.seats.map((seat) => {
        const membership = history
          .filter((record) => record.seatId === seat.id)
          .sort((a, b) => b.generation - a.generation)[0];
        const admission = [...admissions]
          .reverse()
          .find((record) => record.seatId === seat.id && record.configRevision === config.revision);
        const admissionRecorded = Boolean(
          membership?.state === 'active' &&
          membership.reconciliation === 'confirmed' &&
          admission?.decision === 'admitted' &&
          (config.version === 1 || admission.membershipGeneration === membership.generation),
        );
        const admitted = runtimeAvailable && admissionRecorded;
        const savedSandbox =
          durable && membership
            ? deps.store.getSymposiumSeatSandbox(sessionId, seat.id, membership.generation)
            : undefined;
        const diagnosticActor = (res.locals.authSession as { id?: string } | undefined)?.id;
        const creationDiagnostic = durable
          ? savedSandbox?.creationFailureCode &&
            ['reserved', 'stopped'].includes(savedSandbox.state)
            ? {
                phase: savedSandbox.creationPhase ?? 'create',
                code: savedSandbox.creationFailureCode,
                canCleanup: false,
              }
            : null
          : (runtime?.creationDiagnostic?.(
              sessionId,
              seat.id,
              diagnosticActor ? `operator:${diagnosticActor}` : undefined,
            ) ?? null);
        let executable = false;
        if (admitted && !creationDiagnostic && membership) {
          try {
            executable = deps.artifactReady?.(sessionId, seat.id, membership.generation) ?? true;
          } catch {
            executable = false;
          }
        }
        return {
          seatId: seat.id,
          seat,
          membership: membership ?? null,
          admission: admission ?? null,
          admitted: executable,
          creationDiagnostic,
          ...(durable
            ? {
                admissionRecorded: config.state === 'active' && admissionRecorded,
                savedRuntimeState: savedSandbox?.state ?? null,
              }
            : {}),
        };
      });
      const reservedSeats = seats.filter((seat) => seat.membership?.state === 'active').length;
      res.json({
        ...projection,
        sessionId,
        config,
        seats,
        reservedSeats,
        capacityRemaining:
          config.version === 2 ? config.activeSeatCap - reservedSeats : 2 - reservedSeats,
        runtimeAvailable,
        profileBindingEnforced: deps.profileBindingEnforced === true,
        initialProfileSelections:
          config.state === 'draft'
            ? deps.store.getSymposiumInitialProfileSelections(sessionId)
            : {},
        admissions,
        deliveries,
        sharedBoundary: config.seats[0]?.isolationRequest ?? null,
      });
    };
  router.get('/status', statusHandler(true));
  router.get('/', statusHandler(false));

  router.put('/config', configuration.config);

  router.post('/admissions/refresh', (req, res) => {
    const parsed = z
      .strictObject({ expectedRevision: z.number().int().positive() })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Expected roster revision is required' });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    if (!deps.store.getSession(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const runtime = deps.getRuntime(sessionId);
    if (!runtime) {
      res.status(503).json({ error: 'Symposium provider runtime is unavailable' });
      return;
    }
    try {
      res.json({
        seatIds: runtime.refreshActiveAdmissions(sessionId, parsed.data.expectedRevision),
      });
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Admission refresh failed' });
    }
  });

  router.post('/primary/transfer', (req, res) => {
    const parsed = TransferPrimaryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Explicit primary transfer confirmation is required' });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    if (!deps.store.getSession(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const runtime = deps.getRuntime(sessionId);
    if (!runtime) {
      res.status(503).json({ error: 'Symposium provider runtime is unavailable' });
      return;
    }
    const actorId = (res.locals.authSession as { id?: string } | undefined)?.id;
    const input = parsed.data;
    try {
      res.json(
        runtime.transferPrimary({
          fromSeatId: input.fromSeatId,
          toSeatId: input.toSeatId,
          expectedRevision: input.expectedRevision,
          expectedGeneration: input.expectedGeneration,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          sessionId,
          actor: actorId ? `operator:${actorId}` : 'internal-operator',
        }),
      );
    } catch (error) {
      res.status(409).json({
        error: error instanceof Error ? error.message : 'Primary transfer requires recovery',
      });
    }
  });

  router.post('/creation/recovery/reauthorize', requireSameOriginJson, async (req, res) => {
    if (!requireRecentConnectionAuthorization(res, req.header('x-csrf-token') ?? '')) return;
    const parsed = z
      .strictObject({
        seatId: z.string().trim().min(1),
        expectedRevision: z.number().int().positive(),
        expectedGeneration: z.number().int().positive(),
        operationId: z.string().regex(/^[a-f0-9]{64}$/),
        expectedAuthorizationRevision: z.number().int().nonnegative(),
        idempotencyKey: z.string().trim().min(1).max(200),
        confirmation: z.literal('RESUME FAILED SEAT CLEANUP'),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Exact pending cleanup and typed reauthorization required' });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    if (!deps.store.getSession(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const runtime = deps.getRuntime(sessionId);
    if (!runtime) {
      res.status(503).json({ error: 'Retained creation cleanup custody unavailable' });
      return;
    }
    const auth = res.locals.authSession as AuthSession;
    let invalidated = false;
    const unregister = registerAuthSession(auth, () => {
      invalidated = true;
    });
    const authorize = () => {
      if (invalidated) {
        res.status(401).json({ error: 'App authentication expired or revoked' });
        throw new Error('Authorization invalidated');
      }
      if (!requireRecentConnectionAuthorization(res, req.header('x-csrf-token') ?? ''))
        throw new Error('Recent reauthorization required');
    };
    try {
      const scope = {
        seatId: parsed.data.seatId,
        expectedRevision: parsed.data.expectedRevision,
        expectedGeneration: parsed.data.expectedGeneration,
        operationId: parsed.data.operationId,
        expectedAuthorizationRevision: parsed.data.expectedAuthorizationRevision,
        idempotencyKey: parsed.data.idempotencyKey,
      };
      res.json(
        await runtime.reauthorizeCreationRecovery(
          {
            ...scope,
            sessionId,
            actor: `operator:${auth.id}`,
          },
          authorize,
        ),
      );
    } catch {
      if (res.headersSent) return;
      res.status(409).json({
        error:
          'Cleanup reauthorization is stale, busy, or lacks retained host custody. Refresh status.',
      });
    } finally {
      unregister();
    }
  });

  router.post('/creation/recover', async (req, res) => {
    const parsed = z
      .strictObject({
        seatId: z.string().trim().min(1),
        expectedRevision: z.number().int().positive(),
        expectedGeneration: z.number().int().positive(),
        idempotencyKey: z.string().trim().min(1).max(200),
        confirmation: z.literal('CLEAN UP FAILED SEAT'),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Typed failed-seat cleanup confirmation is required' });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    if (!deps.store.getSession(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const runtime = deps.getRuntime(sessionId);
    if (!runtime) {
      res.status(503).json({ error: 'Creation cleanup capability unavailable' });
      return;
    }
    const actorId = (res.locals.authSession as { id?: string } | undefined)?.id;
    if (!actorId) {
      res.status(401).json({ error: 'Authenticated operator required' });
      return;
    }
    try {
      const input = {
        seatId: parsed.data.seatId,
        expectedRevision: parsed.data.expectedRevision,
        expectedGeneration: parsed.data.expectedGeneration,
        idempotencyKey: parsed.data.idempotencyKey,
      };
      res.json(
        await runtime.recoverCreation({ ...input, sessionId, actor: `operator:${actorId}` }),
      );
    } catch {
      // Native/subprocess output is never returned by the cleanup boundary.
      res.status(409).json({
        error:
          'Failed-seat cleanup is incomplete or stale. Refresh status; retained host custody is required.',
      });
    }
  });

  router.post('/membership', async (req, res) => {
    const parsed = MembershipBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid Symposium membership request' });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    if (!deps.store.getSession(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const input = parsed.data;
    const activating = ['admit', 'restore', 'replace'].includes(input.action);
    const runtime = deps.getRuntime(sessionId);
    if (activating && !runtime) {
      res.status(503).json({ error: 'Symposium provider runtime is unavailable' });
      return;
    }
    if (activating && !input.sharedBoundaryAcknowledged) {
      res.status(409).json({ error: 'Shared Symposium boundary acknowledgement is required' });
      return;
    }
    if (activating) {
      let config: z.infer<typeof SymposiumConfigSchema>;
      try {
        config = deps.store.getActiveSymposiumConfig(sessionId);
      } catch {
        res.status(409).json({ error: 'Symposium draft has not been activated' });
        return;
      }
      if (
        crossesAnchorAccount(config, input.seatId) &&
        input.crossAccountConfirmation !== 'ADD CROSS-ACCOUNT SEAT'
      ) {
        res.status(409).json({ error: 'Typed cross-account seat confirmation is required' });
        return;
      }
    }
    const actorId = (res.locals.authSession as { id?: string } | undefined)?.id;
    try {
      const record = await (runtime ?? deps.getSafetyOrchestrator(sessionId)).transitionMembership({
        sessionId,
        seatId: input.seatId,
        action: input.action,
        expectedGeneration: input.expectedGeneration,
        configRevision: input.configRevision,
        actor: actorId ? `operator:${actorId}` : 'internal-operator',
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        ...(input.replacesSeatId ? { replacesSeatId: input.replacesSeatId } : {}),
      });
      res.json(record);
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Membership transition failed' });
    }
  });

  router.post('/deliveries', (req, res) => {
    const parsed = StageBody.safeParse(req.body);
    if (
      !parsed.success ||
      new Set(parsed.data.recipientSeatIds).size !== parsed.data.recipientSeatIds.length
    ) {
      res.status(400).json({ error: 'Invalid directed delivery request' });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    if (!deps.store.getSession(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const runtime = deps.getRuntime(sessionId);
    if (!runtime) {
      res.status(503).json({ error: 'Symposium provider runtime is unavailable' });
      return;
    }
    try {
      res.json(runtime.stageDelivery({ sessionId, ...parsed.data }));
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Delivery staging failed' });
    }
  });

  router.post('/share-excerpt', (req, res) => {
    const parsed = ShareExcerptBody.safeParse(req.body);
    if (
      !parsed.success ||
      new Set(parsed.data.recipientSeatIds).size !== parsed.data.recipientSeatIds.length
    ) {
      res.status(400).json({ error: 'Invalid excerpt sharing request' });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    if (!deps.store.getSession(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const source = deps.store.getSymposiumSourceMessage(sessionId, parsed.data.sourceMessageId, {
      seatId: parsed.data.sourceSeatId,
      membershipGeneration: parsed.data.sourceMembershipGeneration,
    });
    if (!source || !source.content.includes(parsed.data.excerpt)) {
      res.status(409).json({ error: 'Excerpt is not part of a completed source message' });
      return;
    }
    const runtime = deps.getRuntime(sessionId);
    if (!runtime) {
      res.status(503).json({ error: 'Symposium provider runtime is unavailable' });
      return;
    }
    try {
      res.json(
        runtime.stageDelivery({
          sessionId,
          sourceSeatId: source.seatId,
          sourceMessageId: source.messageId,
          ...(parsed.data.sourceMembershipGeneration !== undefined
            ? { sourceMembershipGeneration: parsed.data.sourceMembershipGeneration }
            : {}),
          recipientSeatIds: parsed.data.recipientSeatIds,
          originalContent: parsed.data.excerpt,
          idempotencyKey: parsed.data.idempotencyKey,
        }),
      );
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Excerpt sharing failed' });
    }
  });

  const scopedDelivery = (sessionId: string, deliveryId: string) =>
    deps.store.getSymposiumDelivery(deliveryId)?.sessionId === sessionId;

  router.post('/deliveries/:deliveryId/interventions', (req, res) => {
    const parsed = InterventionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid Symposium intervention' });
      return;
    }
    const { id: sessionId, deliveryId } = req.params as { id: string; deliveryId: string };
    if (!scopedDelivery(sessionId, deliveryId)) {
      res.status(404).json({ error: 'Delivery not found' });
      return;
    }
    try {
      res.json(deps.getSafetyOrchestrator(sessionId).intervene({ deliveryId, ...parsed.data }));
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Intervention failed' });
    }
  });

  router.post('/deliveries/:deliveryId/dispatch', async (req, res) => {
    const { id: sessionId, deliveryId } = req.params as { id: string; deliveryId: string };
    if (!scopedDelivery(sessionId, deliveryId)) {
      res.status(404).json({ error: 'Delivery not found' });
      return;
    }
    const runtime = deps.getRuntime(sessionId);
    if (!runtime) {
      res.status(503).json({
        error: 'Symposium provider runtime is unavailable',
        dispatch: 'not-started',
      });
      return;
    }
    try {
      res.json(await runtime.deliver(deliveryId));
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : 'Dispatch failed' });
    }
  });

  router.post('/deliveries/:deliveryId/cancel', async (req, res) => {
    const parsed = CancelBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid Symposium cancellation' });
      return;
    }
    const { id: sessionId, deliveryId } = req.params as { id: string; deliveryId: string };
    if (!scopedDelivery(sessionId, deliveryId)) {
      res.status(404).json({ error: 'Delivery not found' });
      return;
    }
    try {
      res.json(
        await (deps.getRuntime(sessionId) ?? deps.getSafetyOrchestrator(sessionId)).cancel({
          deliveryId,
          ...parsed.data,
        }),
      );
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Cancellation failed' });
    }
  });
  return router;
}
