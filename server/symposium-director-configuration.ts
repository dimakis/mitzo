import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import {
  agentProfileLabel,
  SymposiumConfigurationOperationSchema,
  SymposiumConfigurationOperationKeySchema,
  canonicalConfigurationOperationJson,
  type SymposiumConfigurationOperation,
  AccountBindingSchema,
  SeatAuthorityRequestSchema,
  SymposiumConfigSchema,
  type SeatConfig,
  type ValidAccountBinding,
} from '@mitzo/protocol';
import { buildAgentProfilePrompt } from './agent-library-prompt.js';
import {
  SymposiumProfileSelectionSchema,
  type SymposiumProfileSelection,
} from './symposium-host-grants.js';
import type { EventStore } from './event-store.js';
import type { SymposiumOrchestrator } from './symposium-orchestrator.js';
/** Configuration handlers borrow application authority and persistence. They do
 * not own stores, grants, runtimes, authentication or router installation. */
export interface SymposiumDirectorConfigurationDependencies {
  store: Pick<
    EventStore,
    | 'getSession'
    | 'getSymposiumConfigurationOperation'
    | 'getActiveSymposiumConfig'
    | 'setSymposiumConfig'
  >;

  /** The verified session runtime. Null means admission and dispatch are unavailable. */
  getRuntime(sessionId: string): SymposiumOrchestrator | null;

  validateSelection(seat: SeatConfig): void;

  hasOrdinaryRuntime?: (sessionId: string) => boolean;

  /** Must verify grant references against host-held authority, never client claims. */
  validateActiveConfig(sessionId: string, config: z.infer<typeof SymposiumConfigSchema>): void;

  activateDraft(input: {
    sessionId: string;
    expectedRevision: number;
    actor: string;
    contextSourceRefs?: string[];
    profileSelections?: Record<string, SymposiumProfileSelection>;
    configurationOperation?: SymposiumConfigurationOperation;
  }): z.infer<typeof SymposiumConfigSchema>;

  reviseSeat(input: {
    sessionId: string;
    expectedRevision: number;
    actor: string;
    seat: SeatConfig;
    contextSourceRefs?: string[];
    profileSelection?: SymposiumProfileSelection;
    configurationOperation?: SymposiumConfigurationOperation;
  }): z.infer<typeof SymposiumConfigSchema>;

  resolveSelection(accountId: string, model: string, reasoningEffort?: string): ValidAccountBinding;
}

const SelectionBody = z.strictObject({
  accountId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningEffort: z.string().trim().min(1).optional(),
});

const ActivateBody = z.strictObject({
  idempotencyKey: SymposiumConfigurationOperationKeySchema.optional(),
  expectedRevision: z.number().int().nonnegative(),
  sharedBoundaryAcknowledged: z.literal(true),
  crossAccountConfirmation: z.literal('ADD CROSS-ACCOUNT SEAT').optional(),
  contextSourceRefs: z.array(z.string().trim().min(1)).optional(),
  profileSelections: z.record(z.string().trim().min(1), SymposiumProfileSelectionSchema).optional(),
});

const ReviseSeatBody = z.strictObject({
  idempotencyKey: SymposiumConfigurationOperationKeySchema.optional(),
  expectedRevision: z.number().int().positive(),
  seatId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  role: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  systemPrompt: z.string(),
  expectedOutput: z.string().trim().min(1).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1).optional(),
  authorityRequest: SeatAuthorityRequestSchema.optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accountId: z.string().trim().min(1),
  model: z.string().trim().min(1),
  reasoningEffort: z.string().trim().min(1).optional(),
  contextSourceRefs: z.array(z.string().trim().min(1)).optional(),
  profileSelection: SymposiumProfileSelectionSchema.optional(),
  sharedBoundaryAcknowledged: z.literal(true),
  crossAccountConfirmation: z.literal('ADD CROSS-ACCOUNT SEAT').optional(),
});

const ConfigBody = z.strictObject({
  idempotencyKey: SymposiumConfigurationOperationKeySchema.optional(),
  expectedRevision: z.number().int().nonnegative(),
  config: SymposiumConfigSchema,
  sharedBoundaryAcknowledged: z.literal(true).optional(),
  crossAccountConfirmation: z.literal('ADD CROSS-ACCOUNT SEAT').optional(),
});

/** Shared by configuration activation and the retained membership admission route. */
export const crossesAnchorAccount = (
  config: z.infer<typeof SymposiumConfigSchema>,
  seatId?: string,
) => {
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
export function createSymposiumDirectorConfigurationHandlers(
  deps: SymposiumDirectorConfigurationDependencies,
) {
  const actorFor = (res: Response) => {
    const id = (res.locals.authSession as { id?: string } | undefined)?.id;
    return id ? `operator:${id}` : 'internal-operator';
  };

  const operationFor = (
    action: SymposiumConfigurationOperation['action'],
    request: Record<string, unknown>,
    res: Response,
  ): SymposiumConfigurationOperation | undefined | null => {
    if (request.idempotencyKey === undefined) return undefined;
    const parsed = SymposiumConfigurationOperationSchema.safeParse({
      version: 1,
      action,
      actor: actorFor(res),
      idempotencyKey: request.idempotencyKey,
      expectedRevision: request.expectedRevision,
      request: JSON.parse(JSON.stringify(request)),
    });
    if (parsed.success) return parsed.data;
    res.status(400).json({
      error: 'Invalid configuration operation identity or size',
      ...(action === 'activate'
        ? { activationMutation: 'not-started' }
        : { seatMutation: 'not-started' }),
    });
    return null;
  };

  const replayOperation = (
    sessionId: string,
    operation: SymposiumConfigurationOperation | undefined,
    res: Response,
  ) => {
    if (!operation) return false;
    let receipt;
    try {
      receipt = deps.store.getSymposiumConfigurationOperation(sessionId, operation.idempotencyKey);
    } catch {
      res.status(409).json({ error: 'Configuration operation proof is unavailable' });
      return true;
    }
    if (!receipt) return false;
    if (receipt.actor !== operation.actor) {
      res.status(403).json({ error: 'Configuration operation belongs to another operator' });
      return true;
    }
    const config = receipt.config;
    const original = {
      version: receipt.version,
      actor: receipt.actor,
      action: receipt.action,
      idempotencyKey: receipt.idempotencyKey,
      expectedRevision: receipt.expectedRevision,
      request: receipt.request,
    };
    if (
      canonicalConfigurationOperationJson(original) !==
      canonicalConfigurationOperationJson(operation)
    )
      res.status(409).json({ error: 'Configuration operation key conflict' });
    else res.json(config);
    return true;
  };
  const operationReceipt: RequestHandler = (req, res) => {
    const sessionId = (req.params as unknown as { id: string }).id;
    const key = SymposiumConfigurationOperationKeySchema.safeParse(req.params.key);
    if (!key.success) {
      res.status(400).json({ error: 'Invalid configuration operation key' });
      return;
    }
    if (!deps.store.getSession(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    let receipt;
    try {
      receipt = deps.store.getSymposiumConfigurationOperation(sessionId, key.data);
    } catch {
      res.status(409).json({ error: 'Configuration operation proof is unavailable' });
      return;
    }
    if (receipt && receipt.actor !== actorFor(res)) {
      res.status(403).json({ error: 'Configuration operation belongs to another operator' });
      return;
    }
    res.json({ receipt: receipt ?? null });
  };
  const reviseSeat: RequestHandler = (req, res) => {
    const parsed = ReviseSeatBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid Symposium seat revision or boundary acknowledgement',
        seatMutation: 'not-started',
      });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    if (!deps.store.getSession(sessionId)) {
      res.status(404).json({ error: 'Session not found', seatMutation: 'not-started' });
      return;
    }
    const operation = operationFor('seats/revise', parsed.data, res);
    if (operation === null) return;
    if (replayOperation(sessionId, operation, res)) return;
    if (!deps.getRuntime(sessionId)) {
      res
        .status(503)
        .json({ error: 'Symposium provider runtime is unavailable', seatMutation: 'not-started' });
      return;
    }
    let mutationStarted = false;
    try {
      const current = deps.store.getActiveSymposiumConfig(sessionId);
      if (current.version !== 2) throw new Error('Multi-seat configuration is required');
      const anchor = current.seats.find((seat) => seat.id === current.anchorSeatId);
      if (!anchor?.accountBinding) throw new Error('Anchor account binding is unavailable');
      const input = parsed.data;
      const prior = current.seats.find((seat) => seat.id === input.seatId);
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
        // Older editors omit these optional fields. Omission preserves the
        // existing request/guidance; it must not select role-based authority.
        ...((input.expectedOutput ?? prior?.expectedOutput) !== undefined
          ? { expectedOutput: input.expectedOutput ?? prior?.expectedOutput }
          : {}),
        ...((input.acceptanceCriteria ?? prior?.acceptanceCriteria) !== undefined
          ? { acceptanceCriteria: input.acceptanceCriteria ?? prior?.acceptanceCriteria }
          : {}),
        ...((input.authorityRequest ?? prior?.authorityRequest) !== undefined
          ? { authorityRequest: input.authorityRequest ?? prior?.authorityRequest }
          : {}),
        color: input.color,
        model: input.model,
        accountBinding: binding,
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      };
      const actorId = (res.locals.authSession as { id?: string } | undefined)?.id;
      mutationStarted = true;
      res.json(
        deps.reviseSeat({
          sessionId,
          expectedRevision: input.expectedRevision,
          actor: actorId ? `operator:${actorId}` : 'internal-operator',
          seat,
          ...(operation ? { configurationOperation: operation } : {}),
          ...(input.contextSourceRefs ? { contextSourceRefs: input.contextSourceRefs } : {}),
          ...(input.profileSelection ? { profileSelection: input.profileSelection } : {}),
        }),
      );
    } catch (error) {
      res.status(409).json({
        error: error instanceof Error ? error.message : 'Seat revision failed',
        ...(!mutationStarted ? { seatMutation: 'not-started' } : {}),
      });
    }
  };
  const activate: RequestHandler = (req, res) => {
    const parsed = ActivateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(409).json({
        error: 'Shared boundary acknowledgement and expected revision are required',
        activationMutation: 'not-started',
      });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    const session = deps.store.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found', activationMutation: 'not-started' });
      return;
    }
    const operation = operationFor('activate', parsed.data, res);
    if (operation === null) return;
    if (replayOperation(sessionId, operation, res)) return;
    const current = session.symposiumConfig
      ? SymposiumConfigSchema.safeParse(JSON.parse(session.symposiumConfig))
      : null;
    if (!current?.success || current.data.state !== 'draft') {
      res.status(409).json({
        error: 'A current Symposium draft is required',
        activationMutation: 'not-started',
      });
      return;
    }
    if (!deps.getRuntime(sessionId)) {
      res.status(503).json({
        error: 'Symposium provider runtime is unavailable',
        activationMutation: 'not-started',
      });
      return;
    }
    if (
      crossesAnchorAccount(current.data) &&
      parsed.data.crossAccountConfirmation !== 'ADD CROSS-ACCOUNT SEAT'
    ) {
      res.status(409).json({
        error: 'Typed cross-account seat confirmation is required',
        activationMutation: 'not-started',
      });
      return;
    }
    const actorId = (res.locals.authSession as { id?: string } | undefined)?.id;
    try {
      res.json(
        deps.activateDraft({
          sessionId,
          expectedRevision: parsed.data.expectedRevision,
          ...(operation ? { configurationOperation: operation } : {}),
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
  };
  const draft: RequestHandler = (req, res) => {
    const body = z
      .strictObject({
        expectedAccountId: z.string().min(1).max(200).optional(),
        expectedRevision: z.number().int().nonnegative().optional(),
        idempotencyKey: SymposiumConfigurationOperationKeySchema.optional(),
      })
      .refine((value) => !value.idempotencyKey || value.expectedRevision !== undefined)
      .safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: 'Invalid draft request', seatMutation: 'not-started' });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    const session = deps.store.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found', seatMutation: 'not-started' });
      return;
    }
    const operation = operationFor('draft', body.data, res);
    if (operation === null) return;
    if (replayOperation(sessionId, operation, res)) return;
    if (
      body.data.expectedRevision !== undefined &&
      body.data.expectedRevision !== (session.symposiumRevision ?? 0)
    ) {
      res.status(409).json({ error: 'Draft revision conflict', seatMutation: 'not-started' });
      return;
    }
    if (session.symposiumConfig) {
      res
        .status(409)
        .json({ error: 'Symposium is already configured', seatMutation: 'not-started' });
      return;
    }
    if (
      session.isActive ||
      (session.executionPhase && session.executionPhase !== 'TERMINAL') ||
      deps.hasOrdinaryRuntime?.(sessionId)
    ) {
      res.status(409).json({
        error: 'Stop the ordinary conversation before creating a Symposium draft',
        seatMutation: 'not-started',
      });
      return;
    }
    const binding = AccountBindingSchema.safeParse(session.accountBinding);
    if (!binding.success) {
      res
        .status(409)
        .json({ error: 'Session account binding is unavailable', seatMutation: 'not-started' });
      return;
    }
    if (body.data.expectedAccountId && body.data.expectedAccountId !== binding.data.accountId) {
      res.status(409).json({
        error: 'Conversation account changed before draft creation',
        seatMutation: 'not-started',
      });
      return;
    }
    const primaryProfile = session.agentProfile?.definition;
    const draft = {
      version: 2 as const,
      revision: (session.symposiumRevision ?? 0) + 1,
      state: 'draft' as const,
      anchorSeatId: 'architect',
      activeSeatCap: 3,
      seats: [
        {
          id: 'architect',
          name: primaryProfile ? agentProfileLabel(primaryProfile) : 'Primary agent',
          role: 'implementer',
          model: binding.data.model,
          systemPrompt: primaryProfile ? buildAgentProfilePrompt(primaryProfile) : '',
          ...(primaryProfile
            ? {
                expectedOutput: primaryProfile.expectedOutput,
                acceptanceCriteria: primaryProfile.acceptanceCriteria,
              }
            : {}),
          color: '#335577',
          accountBinding: binding.data,
        },
      ],
      turnRules: { mode: 'directed' as const, maxTurns: 8 },
      interceptMode: 'manual' as const,
    };
    try {
      res.json(
        operation
          ? deps.store.setSymposiumConfig(
              sessionId,
              draft,
              session.symposiumRevision ?? 0,
              operation,
            )
          : deps.store.setSymposiumConfig(sessionId, draft, session.symposiumRevision ?? 0),
      );
    } catch {
      res.status(409).json({ error: 'Symposium draft could not be created at this revision' });
    }
  };
  const selection: RequestHandler = (req, res) => {
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
  };
  const config: RequestHandler = (req, res) => {
    const parsed = ConfigBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid Symposium configuration', seatMutation: 'not-started' });
      return;
    }
    const sessionId = (req.params as { id: string }).id;
    const session = deps.store.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found', seatMutation: 'not-started' });
      return;
    }
    const operation = operationFor('config', parsed.data, res);
    if (operation === null) return;
    if (replayOperation(sessionId, operation, res)) return;
    if (
      !session.symposiumConfig &&
      (session.isActive ||
        (session.executionPhase && session.executionPhase !== 'TERMINAL') ||
        deps.hasOrdinaryRuntime?.(sessionId))
    ) {
      res.status(409).json({
        error: 'Stop the ordinary conversation before creating a Symposium draft',
        seatMutation: 'not-started',
      });
      return;
    }
    const { config, expectedRevision } = parsed.data;
    const previous = session.symposiumConfig
      ? SymposiumConfigSchema.safeParse(JSON.parse(session.symposiumConfig))
      : null;
    if (
      !operation &&
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
      res
        .status(409)
        .json({ error: 'Symposium configuration revision conflict', seatMutation: 'not-started' });
      return;
    }
    if (previous?.success && previous.data.state === 'active' && config.state === 'draft') {
      res.status(409).json({
        error: 'Active Symposium cannot become an unadmitted draft',
        seatMutation: 'not-started',
      });
      return;
    }
    if (
      config.state === 'draft' &&
      config.seats.some(
        (seat) =>
          seat.profileBinding || seat.contextGrant || seat.authorityGrant || seat.isolationRequest,
      )
    ) {
      res
        .status(409)
        .json({ error: 'Draft seats cannot supply runtime grants', seatMutation: 'not-started' });
      return;
    }
    if (config.state === 'active' && !deps.getRuntime(sessionId)) {
      res
        .status(503)
        .json({ error: 'Symposium provider runtime is unavailable', seatMutation: 'not-started' });
      return;
    }
    if (config.state === 'active' && !parsed.data.sharedBoundaryAcknowledged) {
      res.status(409).json({
        error: 'Shared Symposium boundary acknowledgement is required',
        seatMutation: 'not-started',
      });
      return;
    }
    if (
      config.state === 'active' &&
      crossesAnchorAccount(config) &&
      parsed.data.crossAccountConfirmation !== 'ADD CROSS-ACCOUNT SEAT'
    ) {
      res.status(409).json({
        error: 'Typed cross-account seat confirmation is required',
        seatMutation: 'not-started',
      });
      return;
    }
    let mutationStarted = false;
    try {
      for (const seat of config.seats) {
        if (seat.accountBinding) deps.validateSelection(seat);
      }
      if (config.state === 'active') deps.validateActiveConfig(sessionId, config);
      mutationStarted = true;
      res.json(
        operation
          ? deps.store.setSymposiumConfig(sessionId, config, expectedRevision, operation)
          : deps.store.setSymposiumConfig(sessionId, config, expectedRevision),
      );
    } catch (error) {
      res.status(409).json({
        error: error instanceof Error ? error.message : 'Configuration failed',
        ...(!mutationStarted ? { seatMutation: 'not-started' } : {}),
      });
    }
  };
  return { operationReceipt, reviseSeat, activate, draft, selection, config };
}
