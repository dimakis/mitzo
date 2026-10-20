import { z } from 'zod';
import { SessionRuntimeBindingV2Schema } from './session-runtime-binding.js';
import { OrdinaryLocalCommandSelectionSchema } from './ordinary-local-admission.js';

/** Explicit ordinary intent. Existing repository/collaboration V1 remains strict. */
export const OrdinaryWorkspaceSettingsSchema = z.strictObject({
  version: z.literal(2),
  binding: SessionRuntimeBindingV2Schema,
  selection: OrdinaryLocalCommandSelectionSchema,
  workspace: z.strictObject({ kind: z.literal('ordinary'), preparationId: z.uuid() }),
});
export type OrdinaryWorkspaceSettings = z.infer<typeof OrdinaryWorkspaceSettingsSchema>;

/** Server-derived capabilities, never request-side permission grants. */
export const ORDINARY_WORKSPACE_CAPABILITIES = [
  'ordinary_conversation',
  'writable_files',
  'retained_artifacts',
  'task_execution',
] as const;
export type OrdinaryWorkspaceCapability = (typeof ORDINARY_WORKSPACE_CAPABILITIES)[number];
