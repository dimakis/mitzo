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
export const TelosWorkControlViewSchema = z
  .strictObject({
    version: z.literal(1),
    controlId: id,
    coordinatorItemId: id,
    coordinatorConversationId: id.nullable(),
    priorityItemId: id.nullable(),
    // Absence on older coordinator receipts retains their original meaning.
    origin: z.literal('operator_pause').optional(),
    scope: TelosWorkControlScopeSchema,
    stage: z.enum(['requested', 'acknowledged', 'applied', 'released']),
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
  })
  .refine(
    (value) =>
      value.origin === 'operator_pause'
        ? value.coordinatorConversationId === null && value.priorityItemId === null
        : value.coordinatorConversationId !== null && value.priorityItemId !== null,
    'Operator pause has no coordinator or priority identity; coordinator controls require both',
  );
export type TelosWorkControlScope = z.infer<typeof TelosWorkControlScopeSchema>;
export type TelosWorkControlView = z.infer<typeof TelosWorkControlViewSchema>;

export const TelosWorkControlCommandSchema = z.discriminatedUnion('operation', [
  TelosWorkControlRequestSchema.extend({ operation: z.literal('request') }),
  TelosWorkControlAcknowledgementSchema.extend({ operation: z.literal('acknowledge') }),
  TelosWorkControlReleaseSchema.extend({ operation: z.literal('release') }),
  z.strictObject({ operation: z.literal('read'), controlId: id }),
  z.strictObject({ operation: z.literal('inbox'), itemId: id }),
]);
export const TelosWorkControlResultSchema = z.union([
  TelosWorkControlViewSchema,
  z.array(TelosWorkControlViewSchema),
]);
export type TelosWorkControlCommand = z.infer<typeof TelosWorkControlCommandSchema>;
export const TelosWorkControlToolInputSchema = z.strictObject({
  command: TelosWorkControlCommandSchema,
});
