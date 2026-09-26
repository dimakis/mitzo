import { z } from 'zod';
import { AccountBindingSchema, AccountProviderSchema } from './account-binding.js';

export type SessionType = 'chat' | 'symposium';
export type TurnMode = 'round-robin' | 'directed' | 'budgeted';
export type InterceptMode = 'auto' | 'manual';
export type SymposiumState = 'draft' | 'active';
export type SymposiumAdmissionDecision = 'admitted' | 'refused';
export type SymposiumIntervention = 'approve' | 'edit' | 'replace' | 'drop' | 'retry';
export type SymposiumDeliveryStatus =
  | 'awaiting_intervention'
  | 'ready'
  | 'delivering'
  | 'delivered'
  | 'dropped'
  | 'failed'
  | 'cancelled'
  | 'recovery_required';
export type SymposiumRecipientStatus =
  'pending' | 'executing' | 'delivered' | 'failed' | 'cancelled' | 'recovery_required';
export type SymposiumMembershipState = 'active' | 'suspended' | 'removed';
export type SymposiumReconciliationStatus = 'pending' | 'confirmed' | 'recovery_required';
export type SymposiumMembershipAction = 'admit' | 'suspend' | 'remove' | 'restore' | 'replace';

/** Every transition is immutable; generation fences work already staged for this seat. */
export interface SymposiumMembershipRecord {
  sessionId: string;
  seatId: string;
  generation: number;
  state: SymposiumMembershipState;
  action: SymposiumMembershipAction;
  configRevision: number;
  bindingKey: string;
  actor: string;
  reason: string;
  idempotencyKey: string;
  occurredAt: number;
  reconciliation: SymposiumReconciliationStatus;
  replacesSeatId: string | null;
  replacedBySeatId: string | null;
}

export const ProfileBindingSchema = z.strictObject({
  profileId: z.string().trim().min(1),
  profileRevision: z.string().trim().min(1),
});

/** Advisory setup recipe. Sources must still be explicitly selected and granted per review.
 * Skill/tool names are references, never executable instructions or permission grants.
 */
export const SymposiumProfileRecipeSchema = z.strictObject({
  version: z.literal(1),
  context: z.strictObject({
    include: z
      .array(z.enum(['task', 'diff', 'acceptance-criteria', 'artifacts', 'prior-findings']))
      .max(5),
    sources: z.array(z.enum(['workspace', 'contexgin'])).max(2),
  }),
  skillRefs: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/),
    )
    .max(20),
  toolDefaults: z.strictObject({
    mode: z.literal('read-only'),
    preferredTools: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/),
      )
      .max(20),
  }),
  compatibleProviders: z.array(AccountProviderSchema).min(1).max(4),
  reviewerTemplate: z.enum(['general', 'architecture', 'security', 'testability']),
});
export type SymposiumProfileRecipe = z.infer<typeof SymposiumProfileRecipeSchema>;

/** Portable role guidance only. Runtime identity and grants remain session-scoped. */
export const SymposiumProfileDefinitionSchema = z.strictObject({
  name: z.string().trim().min(1),
  role: z.enum(['planner', 'architect', 'coder', 'reviewer', 'research', 'synthesis']),
  instructions: z.string().trim().min(1),
  expectedOutput: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  modelPolicyRole: z.string().trim().min(1),
  recipe: SymposiumProfileRecipeSchema.optional(),
});
export type SymposiumProfileDefinition = z.infer<typeof SymposiumProfileDefinitionSchema>;

export const ContextGrantSchema = z.strictObject({
  grantId: z.string().trim().min(1),
  revision: z.number().int().positive(),
  classification: z.enum(['public', 'personal', 'work', 'mixed']),
  sourceRefs: z.array(z.string().trim().min(1)),
});

export const AuthorityGrantSchema = z.strictObject({
  grantId: z.string().trim().min(1),
  revision: z.number().int().positive(),
  filesystem: z.enum(['none', 'read', 'write']),
  tools: z.enum(['none', 'read', 'write']),
  network: z.enum(['none', 'restricted']),
});

export const IsolationRequestSchema = z.strictObject({
  trustDomainId: z.string().trim().min(1),
  revision: z.number().int().positive(),
  placement: z.enum(['reuse-compatible', 'dedicated']),
});

/** Historical attribution. Fields absent in old rows remain unknown on replay. */
const LegacySymposiumProvenanceSchema = z.strictObject({
  seatId: z.string().trim().min(1),
  configRevision: z.number().int().positive(),
  accountProfileRevision: z.string().trim().min(1),
  seatProfileRevision: z.string().trim().min(1),
  contextGrantRevision: z.number().int().positive(),
  authorityGrantRevision: z.number().int().positive(),
  isolationDomainId: z.string().trim().min(1),
  isolationDomainRevision: z.number().int().positive(),
  membershipGeneration: z.number().int().nonnegative().optional(),
});

/** Exact execution snapshot, stamped before dispatch and never read from current config on replay. */
export const SymposiumProvenanceV2Schema = LegacySymposiumProvenanceSchema.extend({
  version: z.literal(2),
  seatLabel: z.string().trim().min(1),
  seatRole: z.string().trim().min(1),
  membershipGeneration: z.number().int().nonnegative(),
  capturedAt: z.number().int().nonnegative(),
  accountBinding: AccountBindingSchema,
  reasoningEffort: z.string().trim().min(1).nullable(),
  profileBinding: ProfileBindingSchema,
  contextGrant: z.strictObject({
    grantId: z.string().trim().min(1),
    revision: z.number().int().positive(),
  }),
  authorityGrant: z.strictObject({
    grantId: z.string().trim().min(1),
    revision: z.number().int().positive(),
  }),
});
export const SymposiumProvenanceSchema = z.union([
  SymposiumProvenanceV2Schema,
  LegacySymposiumProvenanceSchema,
]);

export const SeatConfigSchema = z
  .strictObject({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    model: z.string().trim().min(1),
    systemPrompt: z.string(),
    expectedOutput: z.string().trim().min(1).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    role: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    reasoningEffort: z.string().trim().min(1).optional(),
    accountBinding: AccountBindingSchema.optional(),
    profileBinding: ProfileBindingSchema.optional(),
    contextGrant: ContextGrantSchema.optional(),
    authorityGrant: AuthorityGrantSchema.optional(),
    isolationRequest: IsolationRequestSchema.optional(),
  })
  .refine((seat) => !seat.accountBinding || seat.accountBinding.model === seat.model, {
    message: 'Seat model must match its account binding',
    path: ['accountBinding', 'model'],
  });

const BoundedTurnRulesSchema = z.strictObject({
  mode: z.enum(['round-robin', 'directed']),
  maxTurns: z.number().int().positive(),
});

const BudgetedTurnRulesSchema = z.strictObject({
  mode: z.literal('budgeted'),
  maxTurns: z.number().int().positive(),
  budgetUsd: z.number().positive(),
});

export const TurnRulesSchema = z.discriminatedUnion('mode', [
  BoundedTurnRulesSchema,
  BudgetedTurnRulesSchema,
]);

/** An optional capability of an existing chat, with exactly two seats in v1.
 * These are configuration contracts, not runtime grants or scheduler behavior.
 */
const LegacySymposiumConfigSchema = z
  .strictObject({
    version: z.literal(1),
    revision: z.number().int().positive(),
    state: z.enum(['draft', 'active']),
    seats: z.tuple([SeatConfigSchema, SeatConfigSchema]),
    turnRules: TurnRulesSchema,
    interceptMode: z.enum(['auto', 'manual']),
  })
  .superRefine((config, ctx) => {
    if (config.seats[0].id === config.seats[1].id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Seats must have distinct identities',
        path: ['seats'],
      });
    }
    if (config.seats[0].role !== 'primary' || config.seats[1].role !== 'reviewer') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Seat 1 must be primary and Seat 2 must be reviewer',
        path: ['seats'],
      });
    }
    if (config.state === 'active') {
      config.seats.forEach((seat, index) => {
        for (const field of [
          'accountBinding',
          'profileBinding',
          'contextGrant',
          'authorityGrant',
          'isolationRequest',
        ] as const) {
          if (!seat[field]) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Active seats require ${field}`,
              path: ['seats', index, field],
            });
          }
        }
      });
      if (
        config.seats[0].isolationRequest?.trustDomainId !==
        config.seats[1].isolationRequest?.trustDomainId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Active Symposium seats must share one trust domain',
          path: ['seats', 1, 'isolationRequest', 'trustDomainId'],
        });
      }
      if (
        config.seats[0].isolationRequest?.revision !== config.seats[1].isolationRequest?.revision
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Active Symposium seats must share one trust-domain revision',
          path: ['seats', 1, 'isolationRequest', 'revision'],
        });
      }
    }
  });

/** V2 keeps the legacy envelope readable while giving membership its own durable ledger. */
const MultiSeatSymposiumConfigSchema = z
  .strictObject({
    version: z.literal(2),
    revision: z.number().int().positive(),
    state: z.enum(['draft', 'active']),
    anchorSeatId: z.string().trim().min(1),
    activeSeatCap: z.number().int().min(1).max(8),
    seats: z.array(SeatConfigSchema).min(1),
    turnRules: TurnRulesSchema,
    interceptMode: z.enum(['auto', 'manual']),
  })
  .superRefine((config, ctx) => {
    const ids = config.seats.map((seat) => seat.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Seats must have distinct identities',
        path: ['seats'],
      });
    }
    if (!ids.includes(config.anchorSeatId)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Anchor must reference a configured seat',
        path: ['anchorSeatId'],
      });
    }
    if (config.state === 'active') {
      const boundary = config.seats[0].isolationRequest;
      config.seats.forEach((seat, index) => {
        for (const field of [
          'accountBinding',
          'profileBinding',
          'contextGrant',
          'authorityGrant',
          'isolationRequest',
        ] as const) {
          if (!seat[field])
            ctx.addIssue({
              code: 'custom',
              message: `Active seats require ${field}`,
              path: ['seats', index, field],
            });
        }
        if (
          seat.isolationRequest?.trustDomainId !== boundary?.trustDomainId ||
          seat.isolationRequest?.revision !== boundary?.revision
        ) {
          ctx.addIssue({
            code: 'custom',
            message: 'Active Symposium seats must share one trust-domain revision',
            path: ['seats', index, 'isolationRequest'],
          });
        }
      });
    }
  });

export const SymposiumConfigSchema = z.union([
  LegacySymposiumConfigSchema,
  MultiSeatSymposiumConfigSchema,
]);

export type ProfileBinding = z.infer<typeof ProfileBindingSchema>;
export type ContextGrant = z.infer<typeof ContextGrantSchema>;
export type AuthorityGrant = z.infer<typeof AuthorityGrantSchema>;
export type IsolationRequest = z.infer<typeof IsolationRequestSchema>;
export type SymposiumProvenance = z.infer<typeof SymposiumProvenanceSchema>;
export type SymposiumProvenanceV2 = z.infer<typeof SymposiumProvenanceV2Schema>;
export type SeatConfig = z.infer<typeof SeatConfigSchema>;
export type TurnRules = z.infer<typeof TurnRulesSchema>;
export type SymposiumConfig = z.infer<typeof SymposiumConfigSchema>;

/** Durable decision to admit one configured provider into the shared Symposium boundary. */
export interface SymposiumAdmissionRecord {
  admissionId: string;
  sessionId: string;
  seatId: string;
  membershipGeneration?: number;
  decision: SymposiumAdmissionDecision;
  reason: string | null;
  idempotencyKey: string;
  configRevision: number;
  provider: string;
  accountId: string;
  model: string;
  accountProfileRevision: string;
  isolationDomainId: string;
  isolationDomainRevision: number;
  decidedAt: number;
}

/** Immutable target snapshot for one delivery attempt. */
export interface SymposiumDeliveryRecipient {
  deliveryId: string;
  seatId: string;
  membershipGeneration?: number;
  status: SymposiumRecipientStatus;
  idempotencyKey: string;
  configRevision: number;
  accountProfileRevision: string;
  seatProfileRevision: string;
  contextGrantId: string;
  contextGrantRevision: number;
  authorityGrantId: string;
  authorityGrantRevision: number;
  isolationDomainId: string;
  isolationDomainRevision: number;
  providerThreadId: string | null;
  resultContent: string | null;
  costUsd: number | null;
  error: string | null;
  updatedAt: number;
}

/** Append-only evidence for each provider execution claim, including retries and recovery. */
export interface SymposiumRecipientAttemptRecord {
  attemptId: number;
  deliveryId: string;
  seatId: string;
  attemptNumber: number;
  idempotencyKey: string;
  claimToken: string | null;
  dispatchedContent: string | null;
  dispatchSeq: number | null;
  provenance: SymposiumProvenance | null;
  status: Exclude<SymposiumRecipientStatus, 'pending'>;
  providerThreadId: string | null;
  providerTurnId: string | null;
  acceptedAt: number | null;
  resultContent: string | null;
  costUsd: number | null;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
  updatedAt: number;
}

/** One directed/manual message, preserving the pre- and post-intervention forms. */
export interface SymposiumDeliveryRecord {
  deliveryId: string;
  sessionId: string;
  sourceSeatId: string | null;
  /** Durable originating message; null for unlinked/director-authored content. */
  sourceMessageId?: string | null;
  recipientSeatIds: string[];
  originalContent: string;
  deliveredContent: string | null;
  status: SymposiumDeliveryStatus;
  intervention: SymposiumIntervention | null;
  interventionReason: string | null;
  idempotencyKey: string;
  configRevision: number;
  sourceProvenance: SymposiumProvenance | null;
  cancellationReason: string | null;
  cancellationIdempotencyKey: string | null;
  cancelledAt: number | null;
  createdAt: number;
  updatedAt: number;
  recipients: SymposiumDeliveryRecipient[];
}

export interface SymposiumInterventionRecord {
  interventionId: number;
  deliveryId: string;
  action: SymposiumIntervention;
  content: string | null;
  reason: string | null;
  idempotencyKey: string;
  createdAt: number;
}

/** Provider conversation binding retained across deliveries for one seat/config binding. */
export interface SymposiumSeatThreadRecord {
  sessionId: string;
  seatId: string;
  bindingKey: string;
  providerThreadId: string;
  configRevision: number;
  createdAt: number;
  updatedAt: number;
}
