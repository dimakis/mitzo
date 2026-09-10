import { z } from 'zod';
import { AccountBindingSchema } from './account-binding.js';

export type SessionType = 'chat' | 'symposium';
export type TurnMode = 'round-robin' | 'directed' | 'budgeted';
export type InterceptMode = 'auto' | 'manual';
export type SymposiumState = 'draft' | 'active';

export const ProfileBindingSchema = z.strictObject({
  profileId: z.string().trim().min(1),
  profileRevision: z.string().trim().min(1),
});

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
  placement: z.enum(['reuse-compatible', 'dedicated']),
});

/** Immutable attribution stamped onto Symposium delivery events. */
export const SymposiumProvenanceSchema = z.strictObject({
  seatId: z.string().trim().min(1),
  configRevision: z.number().int().positive(),
  accountProfileRevision: z.string().trim().min(1),
  seatProfileRevision: z.string().trim().min(1),
  contextGrantRevision: z.number().int().positive(),
  authorityGrantRevision: z.number().int().positive(),
  isolationDomainId: z.string().trim().min(1),
});

export const SeatConfigSchema = z
  .strictObject({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    model: z.string().trim().min(1),
    systemPrompt: z.string(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    role: z.enum(['primary', 'reviewer']),
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

export const TurnRulesSchema = z.strictObject({
  mode: z.enum(['round-robin', 'directed', 'budgeted']),
  maxTurns: z.number().int().positive(),
  budgetUsd: z.number().positive().optional(),
});

/** An optional capability of an existing chat, with exactly two seats in v1.
 * These are configuration contracts, not runtime grants or scheduler behavior.
 */
export const SymposiumConfigSchema = z
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
    }
  });

export type ProfileBinding = z.infer<typeof ProfileBindingSchema>;
export type ContextGrant = z.infer<typeof ContextGrantSchema>;
export type AuthorityGrant = z.infer<typeof AuthorityGrantSchema>;
export type IsolationRequest = z.infer<typeof IsolationRequestSchema>;
export type SymposiumProvenance = z.infer<typeof SymposiumProvenanceSchema>;
export type SeatConfig = z.infer<typeof SeatConfigSchema>;
export type TurnRules = z.infer<typeof TurnRulesSchema>;
export type SymposiumConfig = z.infer<typeof SymposiumConfigSchema>;
