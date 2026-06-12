/**
 * ChatConnection — transport-agnostic interface for bidirectional chat.
 *
 * Both MitzoConnection (WebSocket) and SseConnection (SSE + HTTP POST)
 * implement this interface. The store and UI code depend only on this
 * contract, making the transport swappable via feature flag.
 *
 * Provider-agnostic: this interface carries protocol-level events
 * regardless of the inference provider behind them.
 */

import type { ConnectionListener } from './connection.js';

export interface ChatConnection {
  /** Open the transport (start WS connection or SSE EventSource). */
  connect(): void;
  /** Close the transport and clean up listeners. */
  disconnect(): void;
  /**
   * Send a protocol message to the server.
   * Returns true if sent or queued, false if the connection is down
   * and not recovering.
   */
  send(msg: Record<string, unknown>): boolean;
  /** Register the message listener (only one — last write wins). */
  onMessage(listener: ConnectionListener): void;
  /** Whether the transport is connected and ready to send. */
  isConnected(): boolean;
  /** Server-assigned connection ID (null before welcome). */
  getConnectionId(): string | null;
  /** Track the latest received seq for a session (for reconnect replay). */
  trackSeq(sessionId: string, seq: number): void;
  /** Get the last received seq for a session (0 if untracked). */
  getLastSeq(sessionId: string): number;
  /** Stop tracking a session (e.g. after close). */
  clearSession(sessionId: string): void;
  /** Drain the pending-send queue. */
  clearPendingSends(): void;
  /** List all session IDs currently being tracked. */
  getTrackedSessions(): string[];
  /** Signal the server that this client is about to be backgrounded. */
  sendSuspend(): void;
  /** Check connectivity and reconnect if needed. force=true tears down unconditionally. */
  checkAndReconnect(force?: boolean): void;
}
