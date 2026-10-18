import { z } from 'zod';
import { CollaborationSettingsSchema } from './collaboration-conversation.js';
import { TelosWorkRoleContextSelectionSchema } from './telos-work-role-context.js';
import { TelosWorkAttemptSchema, TelosWorkArtifactReferenceSchema } from './telos-work.js';

const id = z.string().min(1).max(200).regex(/^\S+$/);
/** Lead tool selectors only; the host supplies role, settings and reviewed context. */
export const TelosStartSliceInputSchema = z
  .strictObject({
    requestId: id,
    childItemId: id,
    mode: z.enum(['start', 'retry']),
    predecessorAttemptId: id.nullable(),
    sourceSnapshotIds: z.array(id).max(100).optional(),
    artifactRefs: z.array(TelosWorkArtifactReferenceSchema).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.mode === 'start') !== (value.predecessorAttemptId === null))
      ctx.addIssue({ code: 'custom', message: 'Retry requires an explicit predecessor attempt' });
  });
export type TelosStartSliceInput = z.infer<typeof TelosStartSliceInputSchema>;
/** Explicit exact-child request. Natural language is resolved in the lead chat;
 * the host accepts neither a guessed title nor an outcome-wide start command. */
export const TelosWorkDelegationInputSchema = z
  .strictObject({
    requestId: id,
    leadItemId: id,
    childItemId: id,
    leadConversationId: id,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.enum(['start', 'retry']),
    predecessorAttemptId: id.nullable(),
    settings: CollaborationSettingsSchema,
    contextSelection: TelosWorkRoleContextSelectionSchema,
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
export type TelosWorkDelegationInput = z.infer<typeof TelosWorkDelegationInputSchema>;
export interface TelosWorkDelegationIntent {
  actorId: string;
  input: TelosWorkDelegationInput;
  attemptId: string;
  allocationOperationId: string;
  contextSnapshotId: string;
  recordRevisions: Array<{ itemId: string; sha256: string }>;
}
export const TelosWorkDelegationReceiptSchema = z
  .strictObject({
    version: z.literal(1),
    state: z.literal('chat_ready'),
    attempt: TelosWorkAttemptSchema,
    workerConversationId: id,
    workerPath: z.string().startsWith('/chat/'),
    itemPath: z.string().startsWith('/todos/'),
    leadPath: z.string().startsWith('/chat/'),
    execution: z.literal('not_started'),
    /** Original collaborator identity for the approved worker receipt row. */
    workerDisplay: z
      .strictObject({
        title: z.string().min(1).max(200),
        profile: z.string().min(1).max(200),
        account: z.string().min(1).max(200),
        model: z.string().min(1).max(200),
        thinking: z.string().nullable(),
        target: z.string().min(1).max(200),
      })
      .optional(),
  })
  .superRefine((receipt, ctx) => {
    const attempt = receipt.attempt;
    if (
      attempt.state !== 'chat_ready' ||
      attempt.workerConversationId !== receipt.workerConversationId ||
      attempt.leadConversationId === receipt.workerConversationId ||
      !attempt.allocationReceiptId ||
      !attempt.executionTaskId ||
      attempt.turnCommandId !== null ||
      receipt.workerPath !== `/chat/${encodeURIComponent(receipt.workerConversationId)}` ||
      receipt.itemPath !== `/todos/${encodeURIComponent(attempt.childItemId)}` ||
      receipt.leadPath !== `/chat/${encodeURIComponent(attempt.leadConversationId)}`
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Exact ordinary worker allocation and navigation receipt required',
      });
  });
export type TelosWorkDelegationReceipt = z.infer<typeof TelosWorkDelegationReceiptSchema>;
