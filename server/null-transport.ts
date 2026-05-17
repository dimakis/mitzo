import type { SessionTransport } from '@mitzo/harness';

/**
 * A transport that discards all messages. Used for headless sessions
 * (e.g. webhook-triggered PR Shepherd) that run without a connected client.
 *
 * Events are still persisted to the EventStore by the query loop —
 * the transport is only the live WS push channel, not the storage layer.
 *
 * isOpen() returns true so the session registry never triggers detach/abort.
 * When a real client connects, the WS handler's takeover logic replaces
 * this transport with a live WsTransport.
 */
export class NullTransport implements SessionTransport {
  send(_data: Record<string, unknown>): void {
    // No-op — events go to EventStore via query-loop, not here
  }

  isOpen(): boolean {
    return true;
  }
}
