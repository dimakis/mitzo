/**
 * Transport abstraction replacing raw WebSocket coupling.
 * The app layer provides concrete implementations (e.g. WsTransport).
 */
export interface SessionTransport {
  send(data: Record<string, unknown>): void;
  isOpen(): boolean;
}
