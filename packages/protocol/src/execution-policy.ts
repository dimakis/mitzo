import { z } from 'zod';
import { ProfileBindingSchema } from './symposium.js';

const Id = z.string().trim().min(1);
const GrantRef = z.strictObject({ grantId: Id, revision: z.number().int().positive() });
export const ExecutionSelectionSchema = z.strictObject({
  accountId: Id,
  model: Id,
  reasoningEffort: Id.nullable(),
});
export const ExecutionPolicySchema = z.strictObject({
  version: z.literal(1),
  policyId: Id,
  revision: Id,
  role: Id,
  profileBinding: ProfileBindingSchema,
  primary: ExecutionSelectionSchema,
  /** Alternatives are explicit selections, never inferred model tiers. */
  alternatives: z
    .array(
      ExecutionSelectionSchema.extend({
        mode: z.enum(['fallback', 'escalation']),
        reason: Id,
      }),
    )
    .default([]),
  contextGrant: GrantRef,
  authorityGrant: GrantRef,
  requiredCapabilities: z.strictObject({
    tools: z.boolean(),
    context: z.boolean(),
    route: z.boolean(),
  }),
  limits: z.strictObject({
    maxAttempts: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    maxCostUsd: z.number().finite().nonnegative().nullable(),
    maxReplans: z.number().int().nonnegative(),
    maxFallbacks: z.number().int().nonnegative(),
    maxEscalations: z.number().int().nonnegative(),
    unknownCostPolicy: z.enum(['decision', 'allow_with_token_cap']),
  }),
});
export const ExecutionOverrideSchema = z.strictObject({
  selection: ExecutionSelectionSchema.optional(),
  profileBinding: ProfileBindingSchema.optional(),
  contextGrant: GrantRef.optional(),
  authorityGrant: GrantRef.optional(),
});
export type ExecutionSelection = z.infer<typeof ExecutionSelectionSchema>;
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;
export type ExecutionOverride = z.infer<typeof ExecutionOverrideSchema>;
