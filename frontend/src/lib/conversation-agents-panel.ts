import { createContext, useContext } from 'react';
import type { ConversationAgent } from '../components/ConversationAgents';

/** A handle to the existing panel, not a second dialog or lifecycle owner. */
export interface ConversationAgentsPanel {
  scope: string;
  active: boolean;
  agents: ConversationAgent[];
  register(open: () => void): () => void;
  open(): void;
}
export const ConversationAgentsPanelContext = createContext<ConversationAgentsPanel | null>(null);
export function useConversationAgentsPanel(scope?: string) {
  const panel = useContext(ConversationAgentsPanelContext);
  return panel && (scope === undefined || scope === panel.scope) ? panel : null;
}
