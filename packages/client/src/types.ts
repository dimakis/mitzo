/**
 * Transport abstraction — each frontend provides its own implementation.
 *
 * Mitzo mobile: browser WebSocket + fetch
 * Mitzo-Theia: Theia RPC + fetch proxy
 */

export interface WsHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(): void;
  onError(error: unknown): void;
}

export interface WsConnection {
  send(data: string): void;
  close(): void;
  readonly readyState: number;
}

export interface TransportAdapter {
  connectWs(url: string, handlers: WsHandlers): WsConnection;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** WebSocket readyState constants (matching the WebSocket spec). */
export const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;
