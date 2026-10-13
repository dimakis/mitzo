/**
 * Transport abstraction replacing raw WebSocket coupling.
 * The app layer provides concrete implementations (e.g. WsTransport).
 */
export interface SessionTransport {
  /** Physical attachment reference, preserved by send decorators; never login authority. */
  readonly attachmentIdentity?: object;
  send(data: Record<string, unknown>): void;
  isOpen(): boolean;
}

export function getTransportAttachmentIdentity(transport: SessionTransport): object {
  return transport.attachmentIdentity ?? transport;
}
