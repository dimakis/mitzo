import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { createCollaborationProjection, applyCollaborationEvents } from '@mitzo/client';
import type { CollaborationMessageInput } from '@mitzo/protocol';
import { sharedConversationView, uuid } from './symposium-shared-conversation-data';
import { conversationResponders } from '../../frontend/src/lib/conversation-presentation';
import { CollaborationTranscript } from '../../frontend/src/components/CollaborationTranscript';
import { ConversationAgents } from '../../frontend/src/components/ConversationAgents';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/home.css';

const names = { architect: 'Architect', reviewer: 'Reviewer', reader: 'Reader' };
function Conversation() {
  const [projection, setProjection] = useState(() =>
    createCollaborationProjection(sharedConversationView()),
  );
  const [responders, setResponders] = useState<CollaborationMessageInput['responders']>({
    kind: 'default',
  });
  const [sends, setSends] = useState(0);
  const choice = conversationResponders(projection.view, responders, names);
  return (
    <main className="chat-page workspace-chat">
      <ConversationAgents
        scope={projection.view.collaborationId}
        messages={[]}
        agents={choice.members.map((member) => {
          const policy = projection.view.policies.find((policy) => policy.sessionId === member.id)!;
          return {
            id: member.id,
            name: member.name,
            state: member.id === 'reviewer' ? 'Outcome uncertain' : 'Independent session',
            policy: { reads: policy.readsFutureDiscussion, replies: policy.repliesByDefault },
          };
        })}
        onPolicyChange={(id, next) => {
          // Schema-derived UI fixture only. Production policy mutations stay with the API owner.
          const current = projection.view.policies.find((policy) => policy.sessionId === id)!;
          const sequence = projection.view.cursor + 1;
          setProjection(
            applyCollaborationEvents(projection, {
              events: [
                {
                  version: 1,
                  collaborationId: projection.view.collaborationId,
                  eventId: uuid(100 + sequence),
                  sequence,
                  change: {
                    kind: 'policy',
                    policy: {
                      ...current,
                      revision: current.revision + 1,
                      effectiveFromSequence: sequence + 1,
                      readsFutureDiscussion: next.reads,
                      repliesByDefault: next.replies,
                    },
                  },
                },
              ],
              cursor: sequence,
              highWatermark: sequence,
              hasMore: false,
            }),
          );
        }}
      />
      <CollaborationTranscript projection={projection} names={names} />
      <div className="conversation-composer">
        <ChatInput
          sessionId="offline-shared-conversation"
          running={false}
          onStop={() => {}}
          onSend={() => {
            setSends(sends + 1);
            return false;
          }}
          sendDisabledReason={choice.sendDisabledReason}
          responders={{ ...choice, onChange: (_ids, intent) => setResponders(intent!) }}
        />
      </div>
      <div data-fixture-control>
        <output aria-label="Send attempts">{sends}</output>
        <button
          onClick={() =>
            setProjection(
              applyCollaborationEvents(projection, {
                events: [],
                cursor: 99,
                highWatermark: 99,
                hasMore: false,
              }),
            )
          }
        >
          Fixture replay gap
        </button>
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <Conversation />
  </MemoryRouter>,
);
