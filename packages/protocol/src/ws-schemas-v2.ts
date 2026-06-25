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

const ImageSchema = z.object({
  data: z.string(),
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
  prompt: z.string().min(1),
  clientMsgId: z.string().min(1),
  model: z.string().optional(),
  mode: z.enum(['ask', 'agent', 'auto']).optional(),
  cwd: z.string().optional(),
  extraTools: z.string().optional(),
  isolation: z.boolean().optional(),
  images: z.array(ImageSchema).optional(),
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
  model: z.string().optional(),
  images: z.array(ImageSchema).optional(),
  contextBlocks: z.array(z.string()).optional(),
});

export const V2StopMessage = z.object({
  type: z.literal('stop'),
  sessionId: z.string().min(1),
});

export const V2PermissionResponseMessage = z.object({
  type: z.literal('permission_response'),
  sessionId: z.string().min(1).optional(),
  permId: z.string(),
  decision: z.enum(['once', 'always', 'deny']).optional(),
});

export const V2SetModeMessage = z.object({
  type: z.literal('set_mode'),
  sessionId: z.string().min(1),
  mode: z.enum(['ask', 'agent', 'auto']),
});

// ─── Terminal messages ─────────────────────────────────────────────────────

export const TerminalCreateMessage = z.object({
  type: z.literal('terminal_create'),
  sessionId: z.string().min(1),
  cols: z.number().int().min(1).optional(),
  rows: z.number().int().min(1).optional(),
});

export const TerminalInputMessage = z.object({
  type: z.literal('terminal_input'),
  terminalId: z.string().min(1),
  data: z.string().max(65536),
});

export const TerminalResizeMessage = z.object({
  type: z.literal('terminal_resize'),
  terminalId: z.string().min(1),
  cols: z.number().int().min(1),
  rows: z.number().int().min(1),
});

export const TerminalDestroyMessage = z.object({
  type: z.literal('terminal_destroy'),
  terminalId: z.string().min(1),
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
  TerminalCreateMessage,
  TerminalInputMessage,
  TerminalResizeMessage,
  TerminalDestroyMessage,
]);

export type IncomingWsMessageV2 = z.infer<typeof IncomingWsMessageV2>;
