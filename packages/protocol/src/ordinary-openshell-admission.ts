import { z } from 'zod';
import { OrdinaryLocalCommandSelectionSchema } from './ordinary-local-admission.js';
import { SessionRuntimeBindingV2Schema } from './session-runtime-binding.js';
const reference = SessionRuntimeBindingV2Schema.shape.execution.shape.targetId;
/** Same frozen per-command selection contract as Local; no second model/profile registry. */
export const OrdinaryOpenShellCommandSelectionSchema = OrdinaryLocalCommandSelectionSchema;
export const OrdinaryOpenShellCommandAdmissionSchema = z.strictObject({
  version: z.literal(1),
  binding: SessionRuntimeBindingV2Schema.refine(
    (binding) =>
      binding.harness.implementation === 'codex' &&
      binding.execution.location === 'openshell' &&
      ['openai-codex', 'openai'].includes(binding.account.provider),
    'Ordinary OpenShell Codex route required',
  ),
  workspace: z.strictObject({
    workspaceId: reference,
    cwd: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^\/sandbox\/workspaces\/[^\r\n\0]+$/),
  }),
  selection: OrdinaryOpenShellCommandSelectionSchema,
  requestFingerprint: z.string().min(1),
  state: z.enum(['reserved', 'uncertain', 'consumed']),
});
export type OrdinaryOpenShellCommandSelection = z.infer<
  typeof OrdinaryOpenShellCommandSelectionSchema
>;
export type OrdinaryOpenShellCommandAdmission = z.infer<
  typeof OrdinaryOpenShellCommandAdmissionSchema
>;
