import { z } from 'zod';
import { TelosWorkIdSchema } from './telos-work-api.js';
import { CollaborationSnapshotSelectionSchema } from './collaboration-conversation.js';

const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const TelosWorkAdvisorDraftProposalSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  desiredOutcome: z.string().trim().min(1).max(2000),
  type: z.enum(['coordinator', 'outcome', 'work_item']),
  category: z.string().trim().min(1).max(200),
});
export const TelosWorkAdvisorDraftPreviewRequestSchema = z
  .strictObject({
    requestId: z.uuid(),
    operation: z.enum(['refine', 'child']),
    itemId: TelosWorkIdSchema,
    advisorConversationId: TelosWorkIdSchema,
    expectedRevision: revision,
    parentId: TelosWorkIdSchema.nullable(),
    expectedParentRevision: revision.nullable(),
    proposed: TelosWorkAdvisorDraftProposalSchema,
    selection: CollaborationSnapshotSelectionSchema,
  })
  .superRefine((value, ctx) => {
    if (value.selection.sourceConversationId !== value.advisorConversationId)
      ctx.addIssue({
        code: 'custom',
        message: 'Draft source must be its bound advisor conversation',
      });
    if ((value.parentId === null) !== (value.expectedParentRevision === null))
      ctx.addIssue({ code: 'custom', message: 'Exact parent revision required' });
    if (
      value.operation === 'child' &&
      (value.parentId !== value.itemId || value.expectedParentRevision !== value.expectedRevision)
    )
      ctx.addIssue({ code: 'custom', message: 'Child draft requires the exact selected parent' });
  });
export const TelosWorkAdvisorDraftSaveRequestSchema =
  TelosWorkAdvisorDraftPreviewRequestSchema.safeExtend({ previewSha256: revision });
export type TelosWorkAdvisorDraftPreviewRequest = z.infer<
  typeof TelosWorkAdvisorDraftPreviewRequestSchema
>;
export type TelosWorkAdvisorDraftSaveRequest = z.infer<
  typeof TelosWorkAdvisorDraftSaveRequestSchema
>;
