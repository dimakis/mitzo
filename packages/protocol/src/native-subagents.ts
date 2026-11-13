import { z } from 'zod';

const identity = z.string().min(1).max(200).regex(/^\S+$/);
export const NativeSubagentStateSchema = z.enum([
  'starting',
  'working',
  'needs_permission',
  'completed',
  'failed',
  'stopping',
  'stopped',
  'unknown',
]);
export const NativeSubagentBlockSchema = z.strictObject({
  id: identity,
  type: z.enum(['text', 'tool', 'user']),
  content: z.string().max(65536),
  name: z.string().max(200).optional(),
  status: z.enum(['running', 'completed', 'failed', 'unknown']).optional(),
});
export const NativeSubagentSnapshotSchema = z.strictObject({
  commandId: identity,
  threadId: identity,
  parentThreadId: identity,
  name: z.string().max(200),
  task: z.string().max(65536),
  model: z.string().max(200),
  state: NativeSubagentStateSchema,
  turnId: identity.optional(),
  revision: z.number().int().positive(),
  available: z.boolean().optional(),
  outputTruncated: z.boolean().optional(),
  inspectionFailure: z
    .strictObject({
      code: z.literal('native_subagent_inspection_failed'),
      stage: z.enum([
        'inspect_child',
        'inspect_parent',
        'validate_identity',
        'subscribe',
        'history',
        'events',
        'capacity',
      ]),
      reference: identity,
    })
    .optional(),
  controlFailure: z
    .strictObject({
      code: z.literal('native_subagent_control_failed'),
      requestId: identity,
      reference: identity,
      stage: z.enum(['admission', 'dispatch', 'acknowledgement']),
      status: z.enum(['rejected', 'uncertain']),
    })
    .optional(),
  blocks: z.array(NativeSubagentBlockSchema).max(2000),
  usage: z
    .strictObject({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .optional(),
});
export const NativeSubagentControlSchema = z.discriminatedUnion('action', [
  z.strictObject({
    requestId: identity,
    threadId: identity,
    action: z.literal('message'),
    text: z
      .string()
      .min(1)
      .max(32000)
      .refine((text) => text.trim().length > 0),
  }),
  z.strictObject({ requestId: identity, threadId: identity, action: z.literal('stop') }),
]);
export type NativeSubagentSnapshot = z.infer<typeof NativeSubagentSnapshotSchema>;
export const NativeSubagentInspectionSchema = z.strictObject({ threadId: identity });
export const NativeSubagentStreamEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('reset'), available: z.boolean() }),
  z.strictObject({ type: z.literal('status'), available: z.boolean() }),
  z.strictObject({ type: z.literal('agent'), agent: NativeSubagentSnapshotSchema }),
]);
export type NativeSubagentBlock = z.infer<typeof NativeSubagentBlockSchema>;
export type NativeSubagentControl = z.infer<typeof NativeSubagentControlSchema>;
export type NativeSubagentControlStatus = 'accepted' | 'rejected' | 'uncertain';
