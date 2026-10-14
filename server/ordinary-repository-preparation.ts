import { AccountBindingSchema, SessionRuntimeBindingV2Schema } from '@mitzo/protocol';
import { z } from 'zod';

/** Intent only; the server resolves every identity and captures private source proof. */
export const OrdinaryRepositoryRuntimeSelectionSchema = z.strictObject({
  runOn: z.enum(['local', 'openshell']),
  runtime: z.strictObject({
    account: SessionRuntimeBindingV2Schema.shape.account,
    harness: z.enum(['codex', 'responses', 'claude-sdk', 'gemini']),
    targetId: z.string().min(1).max(200).regex(/^\S+$/),
  }),
});
export type OrdinaryRepositoryRuntimeSelection = z.infer<
  typeof OrdinaryRepositoryRuntimeSelectionSchema
>;
/** Private existing preparation-row custody. Original model is never rewritten. */
export const OrdinaryRepositoryPreparationSchema = z.strictObject({
  version: z.literal(1),
  originalBinding: AccountBindingSchema,
  runtimeBinding: SessionRuntimeBindingV2Schema,
  credentialDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceIdentity: z
    .strictObject({ dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative() })
    .optional(),
});
export type OrdinaryRepositoryPreparation = z.infer<typeof OrdinaryRepositoryPreparationSchema>;
