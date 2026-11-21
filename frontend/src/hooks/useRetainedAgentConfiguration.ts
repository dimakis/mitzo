import { useLayoutEffect, useMemo, useRef } from 'react';
import type { ConversationAgent } from '../components/ConversationAgents';

const fields = [
  'account',
  'accountId',
  'profile',
  'model',
  'thinking',
  'mode',
  'location',
] as const;
/** Missing metadata may not erase known configuration. Runtime, policy, actions
 * and membership always come from the current props, never from this cache. */
export function useRetainedAgentConfiguration(owner: unknown, incoming: ConversationAgent[]) {
  const retained = useRef<{ owner: unknown; agents: ConversationAgent[] }>({ owner, agents: [] });
  const agents = useMemo(
    () =>
      incoming.map((agent) => {
        const previous =
          retained.current.owner === owner
            ? retained.current.agents.find((a) => a.id === agent.id)
            : undefined;
        const next = { ...agent };
        let missing = false;
        for (const field of fields)
          if (next[field] === undefined && previous?.[field] !== undefined) {
            next[field] = previous[field];
            missing = true;
          }
        if (missing)
          next.configurationNote =
            'Last known configuration; current runtime readiness is checked separately.';
        return next;
      }),
    [owner, incoming],
  );
  useLayoutEffect(() => {
    retained.current = { owner, agents };
  }, [owner, agents]);
  return agents;
}
