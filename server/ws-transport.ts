import type { WebSocket } from 'ws';
import type { SessionTransport } from '@mitzo/harness';

/**
 * Adapts a raw WebSocket to the SessionTransport interface.
 * This is the single boundary where WebSocket-specific code lives.
 * Everything above this (harness, protocol) uses SessionTransport.
 */
export class WsTransport implements SessionTransport {
  constructor(public readonly ws: WebSocket) {}

  send(data: Record<string, unknown>): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  isOpen(): boolean {
    return this.ws.readyState === this.ws.OPEN;
  }
}
