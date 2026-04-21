import { z } from 'zod';

const ImageSchema = z.object({
  data: z.string(),
  mediaType: z.string(),
});

/**
 * Optional W3C Trace Context propagation.
 * Frontend injects traceparent so backend can link spans into the same trace.
 * Format: "00-<traceId>-<spanId>-<flags>" (see https://www.w3.org/TR/trace-context/)
 */
const traceparent = z.string().optional();

export const ReattachMessage = z.object({
  type: z.literal('reattach'),
  clientId: z.string(),
  lastSeq: z.number().optional(),
  traceparent,
});

export const SendMessage = z.object({
  type: z.literal('send'),
  prompt: z.string().min(1),
  clientMsgId: z.string().min(1),
  model: z.string().optional(),
  mode: z.enum(['ask', 'agent', 'auto']).optional(),
  resume: z.string().optional(),
  cwd: z.string().optional(),
  extraTools: z.string().optional(),
  isolation: z.boolean().optional(),
  images: z.array(ImageSchema).optional(),
  contextBlocks: z.array(z.string()).optional(),
  traceparent,
});

export const InterruptMessage = z.object({
  type: z.literal('interrupt'),
  prompt: z.string().min(1),
  clientMsgId: z.string().min(1),
  images: z.array(ImageSchema).optional(),
  contextBlocks: z.array(z.string()).optional(),
  traceparent,
});

export const StopMessage = z.object({
  type: z.literal('stop'),
  traceparent,
});

export const PermissionResponseMessage = z.object({
  type: z.literal('permission_response'),
  permId: z.string(),
  decision: z.enum(['once', 'always', 'deny']).optional(),
  traceparent,
});

export const SetModeMessage = z.object({
  type: z.literal('set_mode'),
  mode: z.enum(['ask', 'agent', 'auto']),
  traceparent,
});

export const SubscribeMessage = z.object({
  type: z.literal('subscribe'),
  sessionId: z.string().min(1),
  lastSeq: z.number().optional(),
  traceparent,
});

export const IncomingWsMessage = z.discriminatedUnion('type', [
  ReattachMessage,
  SendMessage,
  InterruptMessage,
  StopMessage,
  PermissionResponseMessage,
  SetModeMessage,
  SubscribeMessage,
]);

export type IncomingWsMessage = z.infer<typeof IncomingWsMessage>;
