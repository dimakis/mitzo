import { z } from 'zod';
import { TelosWorkIdSchema } from './telos-work-api.js';
const id = TelosWorkIdSchema;
export const TelosWorkControlScopeSchema = z.enum([
  'publication',
  'new_worker_dispatch',
  'safe_point',
]);
export const TelosWorkControlRequestSchema = z.strictObject({
  requestId: id,
  coordinatorItemId: id,
  priorityItemId: id,
  targetItemIds: z.array(id).min(1).max(100),
  scope: TelosWorkControlScopeSchema,
});
export const TelosWorkControlAcknowledgementSchema = z.strictObject({
  requestId: id,
  controlId: id,
  itemId: id,
  assignmentRevision: z.number().int().nonnegative().safe(),
});
export const TelosWorkControlReleaseSchema = z.strictObject({ requestId: id, controlId: id });
const evidence = z.strictObject({
  eventId: id,
  itemId: id,
  role: z.enum(['lead', 'worker']),
  conversationId: id,
  assignmentRevision: z.number().int().nonnegative().safe(),
  stage: z.enum(['acknowledged', 'applied']),
  evidenceRef: id,
});
const worker = z.strictObject({
  itemId: id,
  conversationId: id.nullable(),
  assignmentRevision: z.number().int().nonnegative().safe(),
  stage: z.enum(['requested', 'acknowledged', 'applied']),
});
export const TelosWorkControlViewSchema = z.strictObject({
  version: z.literal(1),
  controlId: id,
  coordinatorItemId: id,
  coordinatorConversationId: id,
  priorityItemId: id,
  scope: TelosWorkControlScopeSchema,
  stage: z.enum(['requested', 'released']),
  publicationRevalidation: z.enum(['not_applicable', 'required']),
  targets: z.array(
    z.strictObject({
      itemId: id,
      leadConversationId: id.nullable(),
      assignmentRevision: z.number().int().nonnegative().safe(),
      stage: z.enum(['requested', 'acknowledged', 'applied']),
      workers: z.array(worker),
    }),
  ),
  history: z.array(evidence),
});
export type TelosWorkControlScope = z.infer<typeof TelosWorkControlScopeSchema>;
export type TelosWorkControlView = z.infer<typeof TelosWorkControlViewSchema>;
