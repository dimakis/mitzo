import { z } from 'zod';
import { TelosWorkSourceSnapshotSchema, TelosWorkArtifactReferenceSchema } from './telos-work.js';

const id = z.string().min(1);
export const TelosWorkRoleContextSelectionSchema = z
  .strictObject({
    version: z.literal(1),
    itemId: id,
    // Absent on historical selections; never backfill their retained bytes.
    itemKind: z.enum(['coordinator', 'outcome', 'work_item']).nullable().optional(),
    role: z.enum(['lead', 'advisor', 'worker', 'reviewer']),
    brief: z.strictObject({
      revision: id,
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      text: z.string(),
    }),
    parentCriteria: z.array(
      z.strictObject({ itemId: id, revision: id, criteria: z.array(z.string()) }),
    ),
    overallGoal: z.strictObject({ itemId: id, revision: id, text: z.string() }),
    sources: z.array(TelosWorkSourceSnapshotSchema),
    artifacts: z.array(TelosWorkArtifactReferenceSchema),
    executionTaskId: id.optional(),
    leadConversationId: id.optional(),
    advisorPurpose: z.enum(['refine', 'child']).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.advisorPurpose && value.role !== 'advisor')
      ctx.addIssue({
        code: 'custom',
        message: 'Only advisor context can select an advisor purpose',
      });
    if (value.role === 'worker' && !value.leadConversationId)
      ctx.addIssue({
        code: 'custom',
        message: 'Worker context requires its selected lead conversation',
      });
    if (value.role !== 'worker' && value.executionTaskId)
      ctx.addIssue({ code: 'custom', message: 'Only a worker can select an execution task' });
    if (value.sources.some((source) => source.itemId !== value.itemId))
      ctx.addIssue({ code: 'custom', message: 'Source selection belongs to another item' });
  });
export type TelosWorkRoleContextSelection = z.infer<typeof TelosWorkRoleContextSelectionSchema>;
