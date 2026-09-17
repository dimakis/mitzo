/**
 * Ephemeral, authoritative proof that a live Codex runtime has attached one
 * specific managed connection. Durable session metadata alone cannot prove a
 * retained sandbox still has that provider after reconnect/revocation.
 */
export interface LiveCapabilityConversationBinding {
  accountId: string;
  connectionId: string;
  connectionRevision: number;
  gatewayProviderId: string | null;
  sandboxName?: string;
}

const bindings = new Map<string, Readonly<LiveCapabilityConversationBinding>>();

export function bindLiveCapabilityConversation(
  conversationId: string,
  binding: LiveCapabilityConversationBinding,
): void {
  bindings.set(conversationId, Object.freeze({ ...binding }));
}

export function getLiveCapabilityConversationBinding(
  conversationId: string,
): Readonly<LiveCapabilityConversationBinding> | undefined {
  return bindings.get(conversationId);
}

export function clearLiveCapabilityConversationBinding(
  conversationId: string,
  expected?: Pick<LiveCapabilityConversationBinding, 'connectionId' | 'connectionRevision'>,
): void {
  const current = bindings.get(conversationId);
  if (
    !expected ||
    (current?.connectionId === expected.connectionId &&
      current.connectionRevision === expected.connectionRevision)
  )
    bindings.delete(conversationId);
}
