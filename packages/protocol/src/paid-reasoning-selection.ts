import { z } from 'zod';
import { SessionRuntimeBindingV2Schema } from './session-runtime-binding.js';
const reference = z.string().min(1).max(200).regex(/^\S+$/);
/** Reviewed per-role route, never inferred from a model prefix or another role's account. */
export const PaidReasoningPhaseSelectionSchema = z.strictObject({
  role: z.enum([
    'proposer',
    'challenger',
    'panel-0',
    'panel-1',
    'panel-2',
    'panel-3',
    'panel-4',
    'panel-5',
    'judge',
    'synthesizer',
  ]),
  binding: SessionRuntimeBindingV2Schema.refine(
    (binding) => binding.harness.implementation !== 'responses',
    'Custom Responses execution is retired',
  ),
  model: reference,
  thinking: reference.nullable(),
  outputPolicy: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('native-default'),
      acknowledgeProviderDefaults: z.literal(true),
    }),
    z.strictObject({
      kind: z.literal('exact-token-ceiling'),
      maxTokens: z.number().int().min(1).max(32768),
    }),
  ]),
});
export const PaidReasoningPhaseSelectionsSchema = z
  .array(PaidReasoningPhaseSelectionSchema)
  .min(2)
  .max(10)
  .refine(
    (phases) => new Set(phases.map((phase) => phase.role)).size === phases.length,
    'Duplicate reasoning role',
  );
export type PaidReasoningPhaseSelection = z.infer<typeof PaidReasoningPhaseSelectionSchema>;
