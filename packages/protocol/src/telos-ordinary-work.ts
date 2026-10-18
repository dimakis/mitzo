import { z } from 'zod';
import { OrdinaryWorkspaceSettingsSchema } from './ordinary-workspace.js';
import {
  TelosWorkRoleSetupInputSchema,
  TelosWorkRoleSetupIntentSchema,
  TelosWorkIdSchema,
} from './telos-work-api.js';
import { TelosWorkDelegationInputSchema } from './telos-work-delegation.js';
import { TelosWorkRolePresentationRefSchema } from './telos-work-role-presentation.js';

/** Explicit V2 entry points. Existing repository/collaboration V1 stays strict. */
export const TelosOrdinaryWorkRoleSetupInputSchema = z
  .strictObject({
    ...TelosWorkRoleSetupInputSchema.shape,
    version: z.literal(2),
    settings: OrdinaryWorkspaceSettingsSchema,
  })
  .refine(
    (value) => ['lead', 'worker'].includes(value.role) || value.expectedAssignmentRevision === null,
    'Invalid role assignment selection',
  );
export const TelosOrdinaryWorkRoleSetupIntentSchema = TelosWorkRoleSetupIntentSchema.extend({
  input: TelosOrdinaryWorkRoleSetupInputSchema,
});
export const TelosOrdinaryWorkReviewedRoleSetupInputSchema = z.strictObject({
  version: z.literal(2),
  input: TelosOrdinaryWorkRoleSetupInputSchema,
  presentationRef: TelosWorkRolePresentationRefSchema,
});
export const TelosOrdinaryWorkDelegationInputSchema = z
  .strictObject({
    ...TelosWorkDelegationInputSchema.shape,
    version: z.literal(2),
    settings: OrdinaryWorkspaceSettingsSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.contextSelection.role !== 'worker' ||
      value.contextSelection.itemId !== value.childItemId ||
      value.contextSelection.leadConversationId !== value.leadConversationId ||
      value.contextSelection.executionTaskId !== undefined
    )
      ctx.addIssue({ code: 'custom', message: 'Exact immutable worker context required' });
    if ((value.mode === 'start') !== (value.predecessorAttemptId === null))
      ctx.addIssue({ code: 'custom', message: 'Retry requires an explicit predecessor attempt' });
  });
const intentFields = {
  actorId: TelosWorkIdSchema,
  attemptId: z.uuid(),
  allocationOperationId: z.uuid(),
  contextSnapshotId: TelosWorkIdSchema,
  recordRevisions: z.array(
    z.strictObject({ itemId: TelosWorkIdSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  ),
};
export const TelosOrdinaryWorkDelegationIntentSchema = z.strictObject({
  ...intentFields,
  input: TelosOrdinaryWorkDelegationInputSchema,
});
/** Strict readers for the existing journal; no alternate table or request owner. */
export const TelosWorkRoleSetupRequestSchema = z.union([
  TelosWorkRoleSetupInputSchema,
  TelosOrdinaryWorkRoleSetupInputSchema,
]);
export const TelosWorkRoleSetupRequestIntentSchema = z.union([
  TelosWorkRoleSetupIntentSchema,
  TelosOrdinaryWorkRoleSetupIntentSchema,
]);
export const TelosWorkDelegationRequestSchema = z.union([
  TelosWorkDelegationInputSchema,
  TelosOrdinaryWorkDelegationInputSchema,
]);
export const TelosWorkDelegationRequestIntentSchema = z.union([
  z.strictObject({ ...intentFields, input: TelosWorkDelegationInputSchema }),
  TelosOrdinaryWorkDelegationIntentSchema,
]);
export type TelosOrdinaryWorkRoleSetupInput = z.infer<typeof TelosOrdinaryWorkRoleSetupInputSchema>;
export type TelosOrdinaryWorkRoleSetupIntent = z.infer<
  typeof TelosOrdinaryWorkRoleSetupIntentSchema
>;
export type TelosOrdinaryWorkDelegationInput = z.infer<
  typeof TelosOrdinaryWorkDelegationInputSchema
>;
export type TelosOrdinaryWorkDelegationIntent = z.infer<
  typeof TelosOrdinaryWorkDelegationIntentSchema
>;
export type TelosWorkRoleSetupRequest = z.infer<typeof TelosWorkRoleSetupRequestSchema>;
export type TelosWorkRoleSetupRequestIntent = z.infer<typeof TelosWorkRoleSetupRequestIntentSchema>;
export type TelosWorkDelegationRequest = z.infer<typeof TelosWorkDelegationRequestSchema>;
export type TelosWorkDelegationRequestIntent = z.infer<
  typeof TelosWorkDelegationRequestIntentSchema
>;
