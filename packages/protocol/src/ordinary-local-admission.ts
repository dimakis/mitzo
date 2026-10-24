import { z } from 'zod';
import type { MitzoMode } from './types.js';
import { AgentProfileSelectionSchema } from './agent-library.js';
import { SessionRuntimeBindingV2Schema } from './session-runtime-binding.js';
import { PreparedRepositoryTransitionSchema } from './prepared-repository-transition.js';
const reference = z.string().min(1).max(200).regex(/^\S+$/);
/** Frozen per-command choice; no authentication, workspace ownership or readiness assertion. */
export const OrdinaryLocalCommandSelectionSchema = z.strictObject({
  version: z.literal(1),
  agent: AgentProfileSelectionSchema,
  context: z
    .strictObject({
      source: z.enum(['none', 'workspace', 'contexgin', 'packs']),
      revision: reference.nullable(),
    })
    .refine(
      (context) => (context.source === 'none') === (context.revision === null),
      'Absent recipe requires null revision; selected recipe requires a revision',
    ),
  permission: z.strictObject({
    mode: z.enum(['ask', 'agent', 'auto']),
    revision: z.number().int().nonnegative(),
  }),
  model: reference,
  thinking: reference.nullable(),
});
export const OrdinaryLocalCommandAdmissionSchema = z.strictObject({
  version: z.literal(1),
  binding: SessionRuntimeBindingV2Schema.refine(
    (b) =>
      ['openai-codex', 'openai'].includes(b.account.provider) &&
      b.harness.implementation === 'codex' &&
      b.execution.location === 'local',
    'Ordinary local Codex route required',
  ),
  workspace: z.strictObject({ workspaceId: reference, cwd: z.string().min(1) }),
  selection: OrdinaryLocalCommandSelectionSchema,
  requestFingerprint: z.string().min(1),
  state: z.enum(['reserved', 'uncertain', 'consumed']),
  preparedRepositoryTransition: PreparedRepositoryTransitionSchema.optional(),
  /** Existing private continuation owner selected this exact committed primary. */
  preparedRepositoryPrimaryCommandId: reference.optional(),
});
export type OrdinaryLocalCommandSelection = z.infer<typeof OrdinaryLocalCommandSelectionSchema>;
export type OrdinaryLocalCommandAdmission = z.infer<typeof OrdinaryLocalCommandAdmissionSchema>;

/** The existing first-command permission choice; no inherited revision or authorization grant. */
export function createOrdinaryFreshPermission(mode: MitzoMode) {
  return {
    mode: OrdinaryLocalCommandSelectionSchema.shape.permission.shape.mode.parse(mode),
    revision: 0 as const,
  };
}

/** Local API adapter reuses the existing ordinary command ledger. */
export const OrdinaryLocalResponsesCommandAdmissionSchema =
  OrdinaryLocalCommandAdmissionSchema.omit({
    preparedRepositoryTransition: true,
    preparedRepositoryPrimaryCommandId: true,
  }).extend({
    binding: SessionRuntimeBindingV2Schema.refine(
      (b) =>
        ((b.account.provider === 'openai' && b.harness.implementation === 'responses') ||
          (b.account.provider === 'google-vertex' && b.harness.implementation === 'gemini')) &&
        b.execution.location === 'local',
      'Ordinary Local Responses route required',
    ),
  });

/** Safe metadata for native signed-history consumers; no credential or resource identity. */
export const NativeContinuationConstraintSchema = z.strictObject({
  model: reference,
  thinking: z.string().min(1).max(64).nullable(),
  reason: z.literal(
    'Continue with the original Gemini model and thinking. Start another conversation to change them.',
  ),
});
export type NativeContinuationConstraint = z.infer<typeof NativeContinuationConstraintSchema>;
