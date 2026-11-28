import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ConversationAgents,
  type ConversationAgent,
} from '../../frontend/src/components/ConversationAgents';
import {
  ComposerStatusProvider,
  ComposerStatusRail,
} from '../../frontend/src/components/ComposerStatus';
import { ConversationAgentsPanelContext } from '../../frontend/src/lib/conversation-agents-panel';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/home.css';

// Geometry/focus fixture only. Production host/projection wiring is exercised in
// SharedConversationAgents.stability.test.tsx; no backend, model or mutations.
function Surface() {
  const [phase, setPhase] = useState(0);
  const [recipients, setRecipients] = useState(false);
  const [failed, setFailed] = useState(false);
  const [removed, setRemoved] = useState(false);
  const agents: ConversationAgent[] = ['Architect', 'Reviewer', 'VeryLongParticipantName']
    .filter((name) => !(removed && name === 'Reviewer'))
    .map((name, index) => ({
      id: name,
      name,
      account: 'Personal account with a descriptive retained name',
      model: 'Astra',
      profile: 'Default Mitzo · revision 1',
      mode: 'agent',
      membership: 'joined',
      membershipLabel: 'Member',
      state: phase % 2 ? 'Reading a lengthy description of the current tool' : 'Working',
      activityState: 'working',
      policy: { reads: false, replies: index === 0 },
    }));
  const [canOpen, setCanOpen] = useState(false);
  const handle = useMemo(() => {
    let opener: (() => void) | undefined;
    return {
      register(open: () => void) {
        opener = open;
        setCanOpen(true);
        return () => {
          if (opener !== open) return;
          opener = undefined;
          setCanOpen(false);
        };
      },
      open() {
        opener?.();
      },
    };
  }, []);
  return (
    <main className="home-content">
      <ConversationAgentsPanelContext.Provider
        value={{ ...handle, scope: 'fixture', active: true, agents, canOpen }}
      >
        <ConversationAgents
          scope="fixture"
          agents={agents}
          messages={[]}
          rosterError={failed ? 'Roster refresh failed. Retained agents are shown.' : undefined}
          onRefresh={() => setFailed(false)}
          onPolicyChange={() => {}}
        />
        <ComposerStatusProvider>
          <ComposerStatusRail
            recipients="To Architect, Reviewer"
            onRecipientsClick={() => setRecipients((value) => !value)}
          />
        </ComposerStatusProvider>
        {recipients && (
          <div role="group" aria-label="Reply recipients">
            <button type="button">Architect</button>
            <button type="button">Reviewer</button>
          </div>
        )}
        <textarea aria-label="Draft" defaultValue="Preserve this draft" />
        <div className="home-inline-actions">
          <button type="button" onClick={() => setPhase((value) => value + 1)}>
            Stream status
          </button>
          <button type="button" onClick={() => setFailed(true)}>
            Fail roster read
          </button>
          <button type="button" onClick={() => setRemoved(true)}>
            Remove reviewer externally
          </button>
        </div>
      </ConversationAgentsPanelContext.Provider>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Surface />);
