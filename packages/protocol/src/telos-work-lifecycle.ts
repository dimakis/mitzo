import { z } from 'zod';
import { TelosWorkIdSchema } from './telos-work-api.js';
import { TelosWorkControlViewSchema } from './telos-work-controls.js';

const base = z.strictObject({
  requestId: TelosWorkIdSchema,
  itemId: TelosWorkIdSchema,
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const TelosWorkLifecycleCommandSchema = z.discriminatedUnion('operation', [
  base.extend({
    operation: z.enum(['pause', 'resume', 'archive', 'unarchive', 'trash', 'restore']),
  }),
  base.extend({
    operation: z.literal('delete_permanently'),
    confirmation: z.strictObject({
      itemId: TelosWorkIdSchema,
      phrase: z.literal('DELETE PERMANENTLY'),
    }),
  }),
]);
export const TelosWorkLifecycleListSchema = z.enum(['active', 'archive', 'trash']);
export const TelosWorkLifecycleEventSchema = z.strictObject({
  requestId: TelosWorkIdSchema,
  operation: z.enum([
    'pause',
    'resume',
    'archive',
    'unarchive',
    'trash',
    'restore',
    'delete_permanently',
  ]),
  actorId: TelosWorkIdSchema,
  at: z.string().datetime(),
});
const disposition = z.enum(['active', 'archived', 'trashed']);
export const TelosWorkLifecycleViewSchema = z.strictObject({
  itemId: TelosWorkIdSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  disposition,
  effectiveDisposition: disposition,
  inheritedFrom: TelosWorkIdSchema.nullable(),
  pause: z.strictObject({
    stage: z.enum(['running', 'requested', 'acknowledged', 'applied']),
    controls: z.array(TelosWorkControlViewSchema),
  }),
  history: z.array(TelosWorkLifecycleEventSchema),
});
export const TelosWorkLifecycleReceiptSchema = z.strictObject({
  requestId: TelosWorkIdSchema,
  itemId: TelosWorkIdSchema,
  operation: TelosWorkLifecycleEventSchema.shape.operation,
  lifecycle: TelosWorkLifecycleViewSchema.nullable(),
});
export type TelosWorkLifecycleCommand = z.infer<typeof TelosWorkLifecycleCommandSchema>;
export type TelosWorkLifecycleView = z.infer<typeof TelosWorkLifecycleViewSchema>;
export type TelosWorkLifecycleReceipt = z.infer<typeof TelosWorkLifecycleReceiptSchema>;
