/**
 * Server → client WebSocket message types.
 *
 * These mirror the types in frontend/src/types/ws-messages.ts.
 * Ideally these would live in @mitzo/protocol, but moving them
 * is out of scope for Phase 3 — tracked for a future cleanup.
 */

import type { BlockType, FinishedBlock, ToolTier, RawToolInput } from '@mitzo/protocol';

// Using a record-based approach rather than discriminated unions
// so the protocol parser can handle unknown message types gracefully.
export interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

// Pool lifecycle events (not from server, injected by ws-connection)
export interface PoolOpenEvent {
  type: '_open';
}

export interface PoolCloseEvent {
  type: '_close';
}

export type WsMsg = ServerMessage | PoolOpenEvent | PoolCloseEvent;
