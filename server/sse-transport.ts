/**
 * SseTransport — adapts the SessionSseRegistry to the SessionTransport interface.
 *
 * This is the SSE equivalent of WsTransport. The SessionTransport interface
 * (send + isOpen) is the seam between chat logic and wire transport — chat.ts,
 * query-loop.ts, and session-registry.ts are completely decoupled from the
 * underlying transport mechanism.
 *
 * Provider-agnostic: this transport carries protocol-level events (message_start,
 * block_delta, session_end) regardless of the inference provider behind them.
 */

import type { SessionTransport } from '@mitzo/harness';
import type { SessionSseRegistry } from './session-sse-registry.js';

export class SseTransport implements SessionTransport {
  constructor(
    private readonly connectionId: string,
    private readonly sseRegistry: SessionSseRegistry,
  ) {}

  send(data: Record<string, unknown>): void {
    const seq = data.seq as number | undefined;
    this.sseRegistry.sendTo(this.connectionId, data, seq);
  }

  isOpen(): boolean {
    return this.sseRegistry.isOpen(this.connectionId);
  }
}
