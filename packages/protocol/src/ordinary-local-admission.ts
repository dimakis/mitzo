import { z } from 'zod';
import { AgentProfileSelectionSchema } from './agent-library.js';
import { SessionRuntimeBindingV2Schema } from './session-runtime-binding.js';
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
      b.account.provider === 'openai-codex' &&
      b.harness.implementation === 'codex' &&
      b.execution.location === 'local',
    'Ordinary local Codex route required',
  ),
  workspace: z.strictObject({ workspaceId: reference, cwd: z.string().min(1) }),
  selection: OrdinaryLocalCommandSelectionSchema,
  requestFingerprint: z.string().min(1),
  state: z.enum(['reserved', 'uncertain', 'consumed']),
});
export type OrdinaryLocalCommandSelection = z.infer<typeof OrdinaryLocalCommandSelectionSchema>;
export type OrdinaryLocalCommandAdmission = z.infer<typeof OrdinaryLocalCommandAdmissionSchema>;

/** Local API adapter reuses the existing ordinary command ledger. */
export const OrdinaryLocalResponsesCommandAdmissionSchema =
  OrdinaryLocalCommandAdmissionSchema.extend({
    binding: SessionRuntimeBindingV2Schema.refine(
      (b) =>
        b.account.provider === 'openai' &&
        b.harness.implementation === 'responses' &&
        b.execution.location === 'local',
      'Ordinary Local Responses route required',
    ),
  });
