/** Display only. Membership is supplied by the canonical discussion owner. */
export interface SharedConversationIdentity {
  collaborationId: string;
  agentCount: number;
  state: 'current' | 'loading' | 'stale';
}

export function sharedConversationLabel(agentCount: number) {
  return `Symposium · ${agentCount} ${agentCount === 1 ? 'agent' : 'agents'}`;
}
