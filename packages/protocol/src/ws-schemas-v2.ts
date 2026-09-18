/**
 * v2 WebSocket protocol schemas.
 *
 * These coexist with the v1 schemas in ws-schemas.ts during migration.
 * v2 clients send { type: 'hello', protocolVersion: 2 } on connect;
 * the server routes to the v2 handler for that connection.
 *
 * Key differences from v1:
 * - Every session-scoped message carries an explicit sessionId
 * - 'reconnect' replaces both 'reattach' and 'subscribe'
 * - 'watch'/'unwatch' manage which sessions a connection receives events for
 * - 'switch_session' triggers synchronous metadata delivery
 */

import { z } from 'zod';

/**
 * The envelope limits are shared with the WebSocket listener. Image bytes are
 * base64 on the wire, so retain enough headroom for JSON fields and four image
 * descriptors without allowing an unbounded frame to reach validation.
 */
export const MAX_V2_IMAGE_COUNT = 4;
export const MAX_V2_IMAGE_DECODED_BYTES = 10 * 1024 * 1024;
export const MAX_V2_IMAGE_TOTAL_DECODED_BYTES = 20 * 1024 * 1024;
export const MAX_V2_IMAGE_ENCODED_CHARS = Math.ceil(MAX_V2_IMAGE_DECODED_BYTES / 3) * 4;
export const MAX_V2_CLIENT_PAYLOAD_BYTES =
  Math.ceil(MAX_V2_IMAGE_TOTAL_DECODED_BYTES / 3) * 4 + 4 * 1024 * 1024;
export const MAX_V2_PROMPT_CHARS = 1_000_000;

const ImageSchema = z.object({
  // This is an encoded-byte ceiling, not a character-count approximation.
  // execution-request performs the stricter decoded-byte and canonical-base64
  // checks before any decode or hash.
  data: z.string().max(MAX_V2_IMAGE_ENCODED_CHARS),
  mediaType: z.string(),
});

// ─── Handshake ──────────────────────────────────────────────────────────────

export const HelloMessage = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int().min(2),
});

// ─── Connection lifecycle ───────────────────────────────────────────────────

export const ReconnectMessage = z.object({
  type: z.literal('reconnect'),
  sessions: z.array(
    z.object({
      sessionId: z.string().min(1),
      lastSeq: z.number().int().min(0),
    }),
  ),
});

// ─── Session management ─────────────────────────────────────────────────────

export const WatchMessage = z.object({
  type: z.literal('watch'),
  sessionId: z.string().min(1),
});

export const UnwatchMessage = z.object({
  type: z.literal('unwatch'),
  sessionId: z.string().min(1),
});

export const SwitchSessionMessage = z.object({
  type: z.literal('switch_session'),
  sessionId: z.string().min(1).nullable(),
});

export const SessionSuspendMessage = z.object({
  type: z.literal('session_suspend'),
  sessions: z.array(
    z.object({
      sessionId: z.string().min(1),
      lastSeq: z.number().int().min(0),
    }),
  ),
});

export const SessionCloseMessage = z.object({
  type: z.literal('session_close'),
  sessionId: z.string().min(1),
});

// ─── Chat messages (session-scoped) ─────────────────────────────────────────

// sessionId is nullable on send (null = start new session) but required on
// interrupt/stop/permission_response/set_mode — you can't target a session
// that doesn't exist yet for those operations.
export const V2SendMessage = z.object({
  type: z.literal('send'),
  sessionId: z.string().min(1).nullable(),
  prompt: z.string().min(1).max(MAX_V2_PROMPT_CHARS),
  clientMsgId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().min(1).max(32).nullable().optional(),
  mode: z.enum(['ask', 'agent', 'auto']).optional(),
  cwd: z.string().optional(),
  extraTools: z.string().optional(),
  isolation: z.boolean().optional(),
  images: z.array(ImageSchema).max(MAX_V2_IMAGE_COUNT).optional(),
  contextBlocks: z.array(z.string()).optional(),
  telosTaskId: z.string().optional(),
  agentName: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
});

export const V2InterruptMessage = z.object({
  type: z.literal('interrupt'),
  sessionId: z.string().min(1),
  prompt: z.string().min(1),
  clientMsgId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().min(1).max(32).nullable().optional(),
  images: z.array(ImageSchema).max(MAX_V2_IMAGE_COUNT).optional(),
  contextBlocks: z.array(z.string()).optional(),
});

export const V2StopMessage = z.object({
  type: z.literal('stop'),
  sessionId: z.string().min(1),
});

const NonBlankPermissionText = z
  .string()
  .min(1)
  .max(4000)
  .refine((value) => value.trim().length > 0, 'Must not be blank');

export const V2PermissionResponseMessage = z.object({
  type: z.literal('permission_response'),
  sessionId: z.string().min(1).optional(),
  permId: z.string(),
  decision: z.enum(['once', 'always', 'deny']).optional(),
  answers: z.record(z.string(), z.array(NonBlankPermissionText).min(1).max(9)).optional(),
});

export const V2SetModeMessage = z.object({
  type: z.literal('set_mode'),
  sessionId: z.string().min(1),
  mode: z.enum(['ask', 'agent', 'auto']),
});

// ─── Union ──────────────────────────────────────────────────────────────────

export const IncomingWsMessageV2 = z.discriminatedUnion('type', [
  HelloMessage,
  ReconnectMessage,
  WatchMessage,
  UnwatchMessage,
  SwitchSessionMessage,
  SessionSuspendMessage,
  SessionCloseMessage,
  V2SendMessage,
  V2InterruptMessage,
  V2StopMessage,
  V2PermissionResponseMessage,
  V2SetModeMessage,
]);

export type IncomingWsMessageV2 = z.infer<typeof IncomingWsMessageV2>;
