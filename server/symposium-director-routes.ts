import {
  buildSymposiumContextPackage,
  SymposiumContextPackageSchema,
} from './symposium-context-package.js';
import { Router } from 'express';
import { z } from 'zod';
import {
  AccountBindingSchema,
  SymposiumConfigSchema,
  type SeatConfig,
  type ValidAccountBinding,
} from '@mitzo/protocol';
import type { EventStore } from './event-store.js';
import type { SymposiumOrchestrator } from './symposium-orchestrator.js';
import {
  SymposiumProfileSelectionSchema,
  type SymposiumProfileSelection,
} from './symposium-host-grants.js';
import type {
  SymposiumPerspective,
  SymposiumPerspectiveItem,
  SymposiumQueuedInput,
} from './symposium-perspectives.js';

type DirectorStore = Pick<
  EventStore,
  | 'getSession'
  | 'getActiveSymposiumConfig'
  | 'getSymposiumMembershipHistory'
  | 'getSymposiumAdmissions'
  | 'getSymposiumDeliveries'
  | 'getSymposiumDelivery'
  | 'getSymposiumSourceMessage'
  | 'setSymposiumConfig'
  | 'getSymposiumInitialProfileSelections'
>;

export interface SymposiumDirectorRouteDeps {
  store: DirectorStore;
  /** The verified session runtime. Null means admission and dispatch are unavailable. */
  getRuntime(sessionId: string): SymposiumOrchestrator | null;
  /** Can fence existing membership even when runtime cleanup is unavailable. */
  getSafetyOrchestrator(sessionId: string): SymposiumOrchestrator;
  validateSelection(seat: SeatConfig): void;
  profileBindingEnforced?: boolean;
  hasOrdinaryRuntime?: (sessionId: string) => boolean;
  /** Must verify grant references against host-held authority, never client claims. */
  validateActiveConfig(sessionId: string, config: z.infer<typeof SymposiumConfigSchema>): void;
  activateDraft(input: {
    sessionId: string;
    expectedRevision: number;
    actor: string;
    contextSourceRefs?: string[];
    profileSelections?: Record<string, SymposiumProfileSelection>;
  }): z.infer<typeof SymposiumConfigSchema>;
  reviseSeat(input: {
    sessionId: string;
    expectedRevision: number;
    actor: string;
    seat: SeatConfig;
    contextSourceRefs?: string[];
    profileSelection?: SymposiumProfileSelection;
  }): z.infer<typeof SymposiumConfigSchema>;
  getPerspective(
    sessionId: string,
    perspective: SymposiumPerspective,
    options: { afterSeq: number; limit: number },
  ): { items: SymposiumPerspectiveItem[]; nextSeq: number | null };
  getQueuedInputs(sessionId: string, perspective: SymposiumPerspective): SymposiumQueuedInput[];
  resolveSelection(accountId: string, model: string, reasoningEffort?: string): ValidAccountBinding;
}

const SelectionBody = z.strictObject({
  accountId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningEffort: z.string().trim().min(1).optional(),
});
const ActivateBody = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  sharedBoundaryAcknowledged: z.literal(true),
  crossAccountConfirmation: z.literal('ADD CROSS-ACCOUNT SEAT').optional(),
  contextSourceRefs: z.array(z.string().trim().min(1)).optional(),
  profileSelections: z.record(z.string().trim().min(1), SymposiumProfileSelectionSchema).optional(),
});
const ReviseSeatBody = z.strictObject({
  expectedRevision: z.number().int().positive(),
  seatId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  role: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  systemPrompt: z.string(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accountId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningEffort: z.string().trim().min(1).optional(),
  contextSourceRefs: z.array(z.string().trim().min(1)).optional(),
  profileSelection: SymposiumProfileSelectionSchema.optional(),
  sharedBoundaryAcknowledged: z.literal(true),
  crossAccountConfirmation: z.literal('ADD CROSS-ACCOUNT SEAT').optional(),
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
const ConfigBody = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  config: SymposiumConfigSchema,
  sharedBoundaryAcknowledged: z.literal(true).optional(),
  crossAccountConfirmation: z.literal('ADD CROSS-ACCOUNT SEAT').optional(),
});
const crossesAnchorAccount = (config: z.infer<typeof SymposiumConfigSchema>, seatId?: string) => {
  const anchor =
    config.version === 2
      ? config.seats.find((seat) => seat.id === config.anchorSeatId)
      : config.seats[0];
  const candidates = seatId ? config.seats.filter((seat) => seat.id === seatId) : config.seats;
  return Boolean(
    anchor?.accountBinding &&
    candidates.some(
      (seat) =>
        seat.accountBinding && seat.accountBinding.accountId !== anchor.accountBinding?.accountId,
    ),
  );
};
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
  // A null author is not visibility proof. Only delivered broadcasts to every
  // active member at creation qualify; private/legacy authored turns fail closed.
  const sharedTurns = (sessionId: string) => {
    const history = deps.store.getSymposiumMembershipHistory(sessionId);
    return deps.store
      .getSymposiumDeliveries(sessionId)
      .filter((delivery) => {
        if (delivery.status !== 'delivered') return false;
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
  router.post('/seats/revise', (req, res) => {
    const parsed = ReviseSeatBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid Symposium seat revision or boundary acknowledgement' });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    if (!deps.store.getSession(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (!deps.getRuntime(sessionId)) {
      res.status(503).json({ error: 'Symposium provider runtime is unavailable' });
      return;
    }
    try {
      const current = deps.store.getActiveSymposiumConfig(sessionId);
      if (current.version !== 2) throw new Error('Multi-seat configuration is required');
      const anchor = current.seats.find((seat) => seat.id === current.anchorSeatId);
      if (!anchor?.accountBinding) throw new Error('Anchor account binding is unavailable');
      const input = parsed.data;
      const binding = deps.resolveSelection(input.accountId, input.model, input.reasoningEffort);
      if (
        input.seatId === current.anchorSeatId &&
        input.accountId !== anchor.accountBinding.accountId
      )
        throw new Error('Anchor must retain the conversation account');
      if (
        input.accountId !== anchor.accountBinding.accountId &&
        input.crossAccountConfirmation !== 'ADD CROSS-ACCOUNT SEAT'
      )
        throw new Error('Typed cross-account seat confirmation is required');
      const seat: SeatConfig = {
        id: input.seatId,
        name: input.name,
        role: input.role,
        systemPrompt: input.systemPrompt,
        color: input.color,
        model: input.model,
        accountBinding: binding,
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      };
      const actorId = (res.locals.authSession as { id?: string } | undefined)?.id;
      res.json(
        deps.reviseSeat({
          sessionId,
          expectedRevision: input.expectedRevision,
          actor: actorId ? `operator:${actorId}` : 'internal-operator',
          seat,
          ...(input.contextSourceRefs ? { contextSourceRefs: input.contextSourceRefs } : {}),
          ...(input.profileSelection ? { profileSelection: input.profileSelection } : {}),
        }),
      );
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Seat revision failed' });
    }
  });
  router.post('/activate', (req, res) => {
    const parsed = ActivateBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(409)
        .json({ error: 'Shared boundary acknowledgement and expected revision are required' });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    const session = deps.store.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const current = session.symposiumConfig
      ? SymposiumConfigSchema.safeParse(JSON.parse(session.symposiumConfig))
      : null;
    if (!current?.success || current.data.state !== 'draft') {
      res.status(409).json({ error: 'A current Symposium draft is required' });
      return;
    }
    if (!deps.getRuntime(sessionId)) {
      res.status(503).json({ error: 'Symposium provider runtime is unavailable' });
      return;
    }
    if (
      crossesAnchorAccount(current.data) &&
      parsed.data.crossAccountConfirmation !== 'ADD CROSS-ACCOUNT SEAT'
    ) {
      res.status(409).json({ error: 'Typed cross-account seat confirmation is required' });
      return;
    }
    const actorId = (res.locals.authSession as { id?: string } | undefined)?.id;
    try {
      res.json(
        deps.activateDraft({
          sessionId,
          expectedRevision: parsed.data.expectedRevision,
          actor: actorId ? `operator:${actorId}` : 'internal-operator',
          ...(parsed.data.contextSourceRefs
            ? { contextSourceRefs: parsed.data.contextSourceRefs }
            : {}),
          ...(parsed.data.profileSelections
            ? { profileSelections: parsed.data.profileSelections }
            : {}),
        }),
      );
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Symposium activation failed' });
    }
  });
  router.post('/draft', (req, res) => {
    if (!z.strictObject({}).safeParse(req.body).success) {
      res.status(400).json({ error: 'Invalid draft request' });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    const session = deps.store.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.symposiumConfig) {
      res.status(409).json({ error: 'Symposium is already configured' });
      return;
    }
    if (
      session.isActive ||
      (session.executionPhase && session.executionPhase !== 'TERMINAL') ||
      deps.hasOrdinaryRuntime?.(sessionId)
    ) {
      res
        .status(409)
        .json({ error: 'Stop the ordinary conversation before creating a Symposium draft' });
      return;
    }
    const binding = AccountBindingSchema.safeParse(session.accountBinding);
    if (!binding.success) {
      res.status(409).json({ error: 'Session account binding is unavailable' });
      return;
    }
    const draft = {
      version: 2 as const,
      revision: (session.symposiumRevision ?? 0) + 1,
      state: 'draft' as const,
      anchorSeatId: 'architect',
      activeSeatCap: 3,
      seats: [
        {
          id: 'architect',
          name: 'Architect',
          role: 'architect',
          model: binding.data.model,
          systemPrompt: '',
          color: '#335577',
          accountBinding: binding.data,
        },
      ],
      turnRules: { mode: 'directed' as const, maxTurns: 8 },
      interceptMode: 'manual' as const,
    };
    try {
      res.json(deps.store.setSymposiumConfig(sessionId, draft, session.symposiumRevision ?? 0));
    } catch {
      res.status(409).json({ error: 'Symposium draft could not be created at this revision' });
    }
  });
  router.post('/selection', (req, res) => {
    const parsed = SelectionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid Symposium seat selection' });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    if (!deps.store.getSession(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    try {
      const { accountId, model, reasoningEffort } = parsed.data;
      res.json({ binding: deps.resolveSelection(accountId, model, reasoningEffort) });
    } catch {
      res
        .status(409)
        .json({ error: 'Selected account, model, or reasoning effort is unavailable' });
    }
  });
  router.get('/', (req, res) => {
    const sessionId = (req.params as { id: string }).id;
    const session = deps.store.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const runtimeAvailable = deps.getRuntime(sessionId) !== null;
    if (session.sessionType !== 'symposium' || !session.symposiumConfig) {
      res.json({
        sessionId,
        config: null,
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
      const admitted = Boolean(
        runtimeAvailable &&
        membership?.state === 'active' &&
        membership.reconciliation === 'confirmed' &&
        admission?.decision === 'admitted' &&
        (config.version === 1 || admission.membershipGeneration === membership.generation),
      );
      return {
        seatId: seat.id,
        seat,
        membership: membership ?? null,
        admission: admission ?? null,
        admitted,
      };
    });
    const reservedSeats = seats.filter((seat) => seat.membership?.state === 'active').length;
    res.json({
      sessionId,
      config,
      seats,
      reservedSeats,
      capacityRemaining:
        config.version === 2 ? config.activeSeatCap - reservedSeats : 2 - reservedSeats,
      runtimeAvailable,
      profileBindingEnforced: deps.profileBindingEnforced === true,
      initialProfileSelections:
        config.state === 'draft' ? deps.store.getSymposiumInitialProfileSelections(sessionId) : {},
      admissions,
      deliveries,
      sharedBoundary: config.seats[0]?.isolationRequest ?? null,
    });
  });

  router.put('/config', (req, res) => {
    const parsed = ConfigBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid Symposium configuration' });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    const session = deps.store.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (
      !session.symposiumConfig &&
      (session.isActive ||
        (session.executionPhase && session.executionPhase !== 'TERMINAL') ||
        deps.hasOrdinaryRuntime?.(sessionId))
    ) {
      res
        .status(409)
        .json({ error: 'Stop the ordinary conversation before creating a Symposium draft' });
      return;
    }
    const { config, expectedRevision } = parsed.data;
    const previous = session.symposiumConfig
      ? SymposiumConfigSchema.safeParse(JSON.parse(session.symposiumConfig))
      : null;
    if (
      session.symposiumRevision === config.revision &&
      session.symposiumConfig === JSON.stringify(config)
    ) {
      res.json(config);
      return;
    }
    if (
      session.symposiumRevision !== expectedRevision ||
      config.revision !== expectedRevision + 1
    ) {
      res.status(409).json({ error: 'Symposium configuration revision conflict' });
      return;
    }
    if (previous?.success && previous.data.state === 'active' && config.state === 'draft') {
      res.status(409).json({ error: 'Active Symposium cannot become an unadmitted draft' });
      return;
    }
    if (
      config.state === 'draft' &&
      config.seats.some(
        (seat) =>
          seat.profileBinding || seat.contextGrant || seat.authorityGrant || seat.isolationRequest,
      )
    ) {
      res.status(409).json({ error: 'Draft seats cannot supply runtime grants' });
      return;
    }
    if (config.state === 'active' && !deps.getRuntime(sessionId)) {
      res.status(503).json({ error: 'Symposium provider runtime is unavailable' });
      return;
    }
    if (config.state === 'active' && !parsed.data.sharedBoundaryAcknowledged) {
      res.status(409).json({ error: 'Shared Symposium boundary acknowledgement is required' });
      return;
    }
    if (
      config.state === 'active' &&
      crossesAnchorAccount(config) &&
      parsed.data.crossAccountConfirmation !== 'ADD CROSS-ACCOUNT SEAT'
    ) {
      res.status(409).json({ error: 'Typed cross-account seat confirmation is required' });
      return;
    }
    try {
      for (const seat of config.seats) {
        if (seat.accountBinding) deps.validateSelection(seat);
      }
      if (config.state === 'active') deps.validateActiveConfig(sessionId, config);
      res.json(deps.store.setSymposiumConfig(sessionId, config, expectedRevision));
    } catch (error) {
      res
        .status(409)
        .json({ error: error instanceof Error ? error.message : 'Configuration failed' });
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
      res.status(503).json({ error: 'Symposium provider runtime is unavailable' });
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
