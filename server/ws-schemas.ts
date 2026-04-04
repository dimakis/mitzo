import { z } from 'zod';

const ImageSchema = z.object({
  data: z.string(),
  mediaType: z.string(),
});

export const ReattachMessage = z.object({
  type: z.literal('reattach'),
  clientId: z.string(),
  lastSeq: z.number().optional(),
});

export const SendMessage = z.object({
  type: z.literal('send'),
  prompt: z.string().min(1),
  model: z.string().optional(),
  mode: z.enum(['ask', 'agent', 'auto']).optional(),
  resume: z.string().optional(),
  cwd: z.string().optional(),
  extraTools: z.string().optional(),
  worktree: z.boolean().optional(),
  images: z.array(ImageSchema).optional(),
});

export const InterruptMessage = z.object({
  type: z.literal('interrupt'),
  prompt: z.string().min(1),
  images: z.array(ImageSchema).optional(),
});

export const StopMessage = z.object({
  type: z.literal('stop'),
});

export const PermissionResponseMessage = z.object({
  type: z.literal('permission_response'),
  permId: z.string(),
  decision: z.enum(['once', 'always', 'deny']).optional(),
});

export const SetModeMessage = z.object({
  type: z.literal('set_mode'),
  mode: z.enum(['ask', 'agent', 'auto']),
});

export const IncomingWsMessage = z.discriminatedUnion('type', [
  ReattachMessage,
  SendMessage,
  InterruptMessage,
  StopMessage,
  PermissionResponseMessage,
  SetModeMessage,
]);

export type IncomingWsMessage = z.infer<typeof IncomingWsMessage>;
