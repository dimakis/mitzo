import { z } from 'zod';
import {
  SessionRuntimeBindingV1Schema,
  SessionRuntimeBindingV2Schema,
} from './session-runtime-binding.js';
import { LocalCodexFirstCommandSchema } from './local-codex-first-command.js';
import { ORDINARY_WORKSPACE_CAPABILITIES } from './ordinary-workspace.js';

const reference = SessionRuntimeBindingV1Schema.shape.account.shape.accountId;
/** Silent intent only. Actual readiness/capabilities belong to the server owner. */
export const OrdinaryWorkspacePreparationRequestSchema = z.strictObject({
  version: z.literal(1),
  model: reference,
  runOn: z.enum(['local', 'openshell']),
  runtime: z.strictObject({
    account: SessionRuntimeBindingV1Schema.shape.account,
    harness: SessionRuntimeBindingV1Schema.shape.harness.shape.implementation,
    targetId: reference,
  }),
});
export const OrdinaryWorkspacePreparationReceiptSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal('ordinary'),
  preparationId: z.uuid(),
  runtimeBinding: SessionRuntimeBindingV2Schema,
  capabilities: z
    .array(z.enum(ORDINARY_WORKSPACE_CAPABILITIES))
    .length(ORDINARY_WORKSPACE_CAPABILITIES.length)
    .refine((values) => new Set(values).size === values.length, 'Duplicate ordinary capabilities'),
});
/** Explicit command for an already prepared session. No path or repository grant. */
export const OrdinaryWorkspaceFirstCommandSchema = z
  .strictObject({
    version: z.literal(2),
    runOn: z.enum(['local', 'openshell']),
    sessionId: reference,
    workspace: z.strictObject({ kind: z.literal('ordinary'), workspaceId: z.uuid() }),
    clientMsgId: LocalCodexFirstCommandSchema.shape.clientMsgId,
    capabilityRevision: LocalCodexFirstCommandSchema.shape.capabilityRevision,
    runtime: LocalCodexFirstCommandSchema.shape.runtime,
    selection: LocalCodexFirstCommandSchema.shape.selection,
    payload: LocalCodexFirstCommandSchema.shape.payload,
  })
  .superRefine((request, ctx) => {
    if (request.runtime.mode !== request.selection.permission.mode)
      ctx.addIssue({ code: 'custom', message: 'Permission selection mismatch' });
    if (new TextEncoder().encode(JSON.stringify(request)).length > 1048576)
      ctx.addIssue({ code: 'custom', message: 'Command exceeds bound' });
  });
/** The server's distinct continuation entry verifies existing native custody. */
export const OrdinaryWorkspaceContinuationCommandSchema = OrdinaryWorkspaceFirstCommandSchema;
export type OrdinaryWorkspacePreparationRequest = z.infer<
  typeof OrdinaryWorkspacePreparationRequestSchema
>;
export type OrdinaryWorkspacePreparationReceipt = z.infer<
  typeof OrdinaryWorkspacePreparationReceiptSchema
>;
export type OrdinaryWorkspaceFirstCommand = z.infer<typeof OrdinaryWorkspaceFirstCommandSchema>;
export type OrdinaryWorkspaceContinuationCommand = z.infer<
  typeof OrdinaryWorkspaceContinuationCommandSchema
>;
