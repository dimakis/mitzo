import { useLayoutEffect, useMemo, useRef } from 'react';
import type { CollaborationProjection } from '@mitzo/client';
import type { ConversationAgent } from '../components/ConversationAgents';
import { useSessionOverview } from './useSessionOverview';
import { projectConversationAgents } from '../lib/conversation-agent-roster';

export function useConversationAgentRoster(
  owner: object,
  projection: CollaborationProjection | null,
  names: Readonly<Record<string, string>>,
) {
  const { activities, connected } = useSessionOverview();
  const retained = useRef<{ owner: object; agents: ConversationAgent[] }>({ owner, agents: [] });
  const agents = useMemo(
    () =>
      projection
        ? projectConversationAgents({
            view: projection.view,
            earlierMessages: projection.earlierMessages,
            previous: retained.current.owner === owner ? retained.current.agents : [],
            names,
            activities,
            connected,
          })
        : [],
    [owner, projection, names, activities, connected],
  );
  // Retain display data only after commit; an abandoned render cannot alter it.
  useLayoutEffect(() => {
    retained.current = { owner, agents };
  }, [owner, agents]);
  return agents;
}
