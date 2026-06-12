// SseTransport — adapts SessionSseRegistry to the SessionTransport interface.

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
