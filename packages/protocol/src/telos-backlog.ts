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
export const TelosCreateChildInputSchema = z.strictObject({
  parentId: id.describe('Existing parent inspected with TelosManageItem read'),
  expectedParentRevision: revision.describe(
    'Parent item.revision from inspection, or parentRevision from the previous successful child creation',
  ),
  requestId: id.describe('Unique creation request; retry only with this exact input and ID'),
  summary: z.string().trim().min(1).max(240),
  intent: z.string().trim().min(1).max(8000),
  rationale: z.string().trim().min(1).max(8000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(30),
  note: z.string().trim().min(1).max(4000),
});
export const TelosEditItemInputSchema = z
  .strictObject({
    itemId: id,
    requestId: id,
    expectedRevision: revision,
    summary: z.string().trim().min(1).max(240).optional(),
    intent: z.string().trim().min(1).max(8000).optional(),
    rationale: z.string().trim().min(1).max(8000).optional(),
    acceptanceCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(30).optional(),
    note: z.string().trim().min(1).max(4000),
  })
  .refine(
    (v) =>
      [v.summary, v.intent, v.rationale, v.acceptanceCriteria].some((value) => value !== undefined),
    'Supply at least one brief field to edit',
  );
export const TelosManageItemInputSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('read'),
    itemId: id,
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  }),
  TelosEditItemInputSchema.safeExtend({ operation: z.literal('edit') }),
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
