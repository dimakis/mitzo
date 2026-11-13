import { z } from 'zod';
import { TelosWorkIdSchema } from './telos-work-api.js';
import { TelosWorkItemSchema } from './telos-work.js';

const id = TelosWorkIdSchema;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const TelosListItemsInputSchema = z.strictObject({
  query: z.string().trim().max(256).optional(),
  status: TelosWorkItemSchema.shape.status.optional(),
  parentId: id.nullable().optional(),
  view: z.enum(['active', 'archive', 'trash', 'all']).default('active'),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: id.optional(),
});
export const TelosListItemsResultSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id,
        summary: z.string(),
        summaryTruncated: z.boolean(),
        status: TelosWorkItemSchema.shape.status,
        parentId: id.nullable(),
        updatedAt: z.string().nullable(),
        effectiveDisposition: z.enum(['active', 'archived', 'trashed']),
      }),
    )
    .max(100),
  nextCursor: id.nullable(),
});
export const TelosRecordsInputSchema = z.strictObject({ itemIds: z.array(id).max(100) });
export const TelosRecordsResultSchema = z.strictObject({
  records: z.array(TelosWorkItemSchema).max(100),
  failures: z
    .array(z.strictObject({ itemId: id, code: z.string(), status: z.number().int() }))
    .max(100),
});
export const TelosCreateFeatureInputSchema = z.strictObject({
  requestId: id.describe('Unique creation request; retry only with this exact input and ID'),
  summary: z.string().trim().min(1).max(240),
  intent: z.string().trim().min(1).max(8000),
  rationale: z.string().trim().min(1).max(8000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(30),
  note: z.string().trim().min(1).max(4000),
});
export const TelosCreateChildInputSchema = z.strictObject({
  parentId: id.describe('Existing parent inspected with TelosManageItem read'),
  expectedParentRevision: revision.describe(
    'Parent item.revision from inspection, or parentRevision from the previous successful child creation',
  ),
  ...TelosCreateFeatureInputSchema.shape,
});
export const TelosEditItemInputSchema = z
  .strictObject({
    itemId: id,
    requestId: id,
    expectedRevision: revision,
    workLevel: z
      .enum(['outcome', 'feature', 'slice'])
      .optional()
      .describe(
        'Classify an existing unclassified item before lead/worker setup; does not reassign chats or convert an existing level',
      ),
    summary: z.string().trim().min(1).max(240).optional(),
    intent: z.string().trim().min(1).max(8000).optional(),
    rationale: z.string().trim().min(1).max(8000).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(30).optional(),
    note: z.string().trim().min(1).max(4000),
  })
  .refine(
    (v) =>
      [v.summary, v.intent, v.rationale, v.acceptanceCriteria, v.workLevel].some(
        (value) => value !== undefined,
      ),
    'Supply a brief field or an unclassified work level to edit',
  );
export const TelosManageItemInputSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('read'),
    itemId: id,
    view: z
      .enum(['overview', 'full'])
      .optional()
      .describe(
        'Prefer overview for current status, responsibility, children and revision without historical payloads. Full preserves the complete legacy read and fragment paging.',
      ),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  TelosEditItemInputSchema.safeExtend({ operation: z.literal('edit') }),
  z.strictObject({
    operation: z.literal('update'),
    itemId: id,
    requestId: id,
    expectedRevision: revision,
    status: z.enum(['active', 'acknowledged', 'completed']).optional(),
    note: z.string().trim().min(1).max(4000),
  }),
  z.strictObject({
    operation: z.enum(['archive', 'unarchive', 'restore']),
    itemId: id,
    requestId: id,
    expectedRevision: revision,
  }),
]);
export type TelosListItemsInput = z.input<typeof TelosListItemsInputSchema>;
export type TelosRecordsResult = z.infer<typeof TelosRecordsResultSchema>;
export type TelosEditItemInput = z.infer<typeof TelosEditItemInputSchema>;
export type TelosCreateChildInput = z.infer<typeof TelosCreateChildInputSchema>;
export type TelosCreateFeatureInput = z.infer<typeof TelosCreateFeatureInputSchema>;
