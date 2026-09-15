/**
 * Routes a resolved legacy slash skill while preserving the user-authored
 * command separately from the rendered provider prompt. This owns the exact
 * legacy call shape so active, resumed, and startup delivery are testable
 * without importing the side-effectful HTTP/WebSocket server entry point.
 */
export function routeLegacySkillMessage<TTransport, TWebSocket, TStartOptions extends object>(
  message: {
    transport: TTransport;
    ws: TWebSocket;
    clientId: string;
    resume?: string;
    renderedPrompt: string;
    userIntent: string;
    images?: Array<{ data: string; mediaType: string }>;
    contextBlocks?: string[];
    clientMsgId?: string;
    startOptions: TStartOptions;
  },
  handlers: {
    isActive(clientId: string): boolean;
    sendToActiveChat(
      transport: TTransport,
      clientId: string,
      prompt: string,
      images?: Array<{ data: string; mediaType: string }>,
      contextBlocks?: string[],
      clientMsgId?: string,
      userIntent?: string,
    ): void;
    tryRouteToActiveSession(
      ws: TWebSocket,
      resume: string | undefined,
      prompt: string,
      images?: Array<{ data: string; mediaType: string }>,
      contextBlocks?: string[],
      clientMsgId?: string,
      userIntent?: string,
    ): unknown;
    startChat(
      transport: TTransport,
      clientId: string,
      prompt: string,
      options: TStartOptions & { userIntent: string },
    ): unknown;
  },
): void {
  const { clientId, renderedPrompt, userIntent } = message;
  if (handlers.isActive(clientId)) {
    handlers.sendToActiveChat(
      message.transport,
      clientId,
      renderedPrompt,
      message.images,
      message.contextBlocks,
      message.clientMsgId,
      userIntent,
    );
  } else if (
    !handlers.tryRouteToActiveSession(
      message.ws,
      message.resume,
      renderedPrompt,
      message.images,
      message.contextBlocks,
      message.clientMsgId,
      userIntent,
    )
  ) {
    handlers.startChat(message.transport, clientId, renderedPrompt, {
      ...message.startOptions,
      userIntent,
    });
  }
}
