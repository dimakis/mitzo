import { z } from 'zod';

export type SessionType = 'chat' | 'symposium';
export type TurnMode = 'round-robin' | 'directed' | 'budgeted';
export type InterceptMode = 'auto' | 'manual';

// A connection reference, never credentials. Runtime must resolve authorization
// and model availability before sending any context through this account.
const AccountBindingSchema = z.strictObject({
  accountId: z.string().min(1),
  accountLabel: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  profileRevision: z.string().min(1),
});

export const SeatConfigSchema = z
  .strictObject({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    model: z.string().trim().min(1),
    systemPrompt: z.string(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    accountBinding: AccountBindingSchema.optional(),
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
    seats: z.tuple([SeatConfigSchema, SeatConfigSchema]),
    turnRules: TurnRulesSchema,
    interceptMode: z.enum(['auto', 'manual']),
  })
  .refine((config) => config.seats[0].id !== config.seats[1].id, {
    message: 'Seats must have distinct identities',
    path: ['seats'],
  });

export type SeatConfig = z.infer<typeof SeatConfigSchema>;
export type TurnRules = z.infer<typeof TurnRulesSchema>;
export type SymposiumConfig = z.infer<typeof SymposiumConfigSchema>;
