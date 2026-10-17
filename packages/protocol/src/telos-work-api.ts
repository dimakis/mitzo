import { z } from 'zod';
import {
  TelosSourceConversationReferenceSchema,
  TelosWorkSessionLinkSchema,
  TelosWorkAssignmentSchema,
  TelosWorkSourceSnapshotSchema,
  TelosWorkAttemptSchema,
} from './telos-work.js';
import { SessionRuntimeBindingSchema } from './session-runtime-binding.js';
import { OrdinaryLocalCommandSelectionSchema } from './ordinary-local-admission.js';
import { CollaborationSettingsSchema } from './collaboration-conversation.js';
import { TelosWorkRoleContextSelectionSchema } from './telos-work-role-context.js';
import { TelosWorkArtifactReferenceSchema } from './telos-work.js';

export const TelosWorkIdSchema = z.string().min(1).max(200).regex(/^\S+$/);
const id = TelosWorkIdSchema;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const base = { itemId: id, requestId: id, expectedRevision: revision };
export const TelosWorkRoleContextRequestSchema = z
  .strictObject({
    itemId: id,
    role: z.enum(['lead', 'worker', 'advisor', 'reviewer']),
    sourceSnapshotIds: z.array(id),
    artifactRefs: z.array(TelosWorkArtifactReferenceSchema),
    advisorPurpose: z.enum(['refine', 'child']).optional(),
  })
  .refine(
    (value) => value.role === 'advisor' || value.advisorPurpose === undefined,
    'Advisor purpose requires an advisor role',
  );
export type TelosWorkRoleContextRequest = z.infer<typeof TelosWorkRoleContextRequestSchema>;
export const TelosWorkRoleSetupInputSchema = z
  .strictObject({
    ...base,
    role: z.enum(['lead', 'worker', 'advisor', 'reviewer']),
    expectedAssignmentRevision: z.number().int().nonnegative().safe().nullable(),
    settings: CollaborationSettingsSchema,
    contextSelection: TelosWorkRoleContextSelectionSchema,
  })
  .refine(
    (value) => ['lead', 'worker'].includes(value.role) || value.expectedAssignmentRevision === null,
    'Invalid role assignment selection',
  );
export const TelosWorkRoleSetupIntentSchema = z.strictObject({
  actorId: id,
  input: TelosWorkRoleSetupInputSchema,
  allocationOperationId: z.uuid(),
});
export type TelosWorkRoleSetupInput = z.infer<typeof TelosWorkRoleSetupInputSchema>;
export type TelosWorkRoleSetupIntent = z.infer<typeof TelosWorkRoleSetupIntentSchema>;
export const TelosWorkCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    ...base,
    operation: z.literal('classify'),
    kind: z.enum(['coordinator', 'outcome', 'work_item']),
  }),
  z.strictObject({ ...base, operation: z.literal('reparent'), parentId: id.nullable() }),
  z.strictObject({
    ...base,
    operation: z.literal('link'),
    role: z.enum(['origin', 'lead', 'advisor', 'worker', 'reviewer']),
    conversation: TelosSourceConversationReferenceSchema,
  }),
  z.strictObject({
    ...base,
    operation: z.literal('assign'),
    role: z.enum(['lead', 'worker']),
    conversationId: id,
    expectedAssignmentRevision: z.number().int().nonnegative().safe(),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('setup_role'),
    role: z.enum(['lead', 'worker', 'advisor', 'reviewer']),
    conversationId: id,
    expectedAssignmentRevision: z.number().int().nonnegative().safe().nullable(),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('source'),
    snapshot: TelosWorkSourceSnapshotSchema,
  }),
  z.strictObject({
    ...base,
    operation: z.literal('request_attempt'),
    attemptId: id,
    predecessorAttemptId: id.nullable(),
    leadConversationId: id,
    contextSnapshotId: id,
    configuration: z.strictObject({
      binding: SessionRuntimeBindingSchema,
      selection: OrdinaryLocalCommandSelectionSchema,
    }),
  }),
]);
export const TelosWorkViewSchema = z.strictObject({
  itemId: id,
  kind: z.enum(['coordinator', 'outcome', 'work_item']).nullable(),
  parentId: id.nullable(),
  revision,
  links: z.array(TelosWorkSessionLinkSchema),
  assignments: z.array(TelosWorkAssignmentSchema),
  sources: z.array(TelosWorkSourceSnapshotSchema),
  attempts: z.array(TelosWorkAttemptSchema),
});
export const TelosWorkCommandReceiptSchema = z.strictObject({
  commandId: id,
  actorId: id,
  work: TelosWorkViewSchema,
});
export const TelosConversationWorkLinksSchema = z.array(TelosWorkSessionLinkSchema);
export type TelosWorkCommand = z.infer<typeof TelosWorkCommandSchema>;
export type TelosWorkView = z.infer<typeof TelosWorkViewSchema>;
export type TelosWorkCommandReceipt = z.infer<typeof TelosWorkCommandReceiptSchema>;
