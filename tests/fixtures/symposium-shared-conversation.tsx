import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { CollaborationApiClient } from '@mitzo/client';
import { sharedConversationView } from './symposium-shared-conversation-data';
import { useConversationPresentation } from '../../frontend/src/hooks/useConversationPresentation';
import { createChatDraft, getChatDraft, saveChatDraft } from '../../frontend/src/lib/chat-drafts';
import { CollaborationTranscript } from '../../frontend/src/components/CollaborationTranscript';
import { ConversationAgents } from '../../frontend/src/components/ConversationAgents';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/home.css';

const names = { architect: 'Architect', reviewer: 'Reviewer', reader: 'Reader' };
const group = sharedConversationView().collaborationId;
const api = new CollaborationApiClient((url, init) => fetch(url, init));
// Synthetic auth-owner boundary only; full application authentication is tested separately.
const proof = () => 'offline-verified-login';
function Conversation() {
  const [draftId] = useState(() => {
    const id = 'offline-shared-composer';
    if (!getChatDraft(id)) {
      const draft = createChatDraft();
      saveChatDraft({
        ...draft,
        id,
        settings: {
          ...draft.settings,
          collaborationResponders: { collaborationId: group, responders: { kind: 'default' } },
        },
      });
    }
    return id;
  });
  const presentation = useConversationPresentation({
    collaborationId: group,
    api,
    names,
    authScope: proof(),
    getVerifiedAuthScope: proof,
    draftId,
  });
  const [sends, setSends] = useState(0);
  const { projection, draft, composerResponders } = presentation;
  return (
    <main className="chat-page workspace-chat">
      <ConversationAgents
        scope={group}
        messages={[]}
        agents={(composerResponders?.members ?? []).map((member) => {
          const policy = projection!.view.policies.find(
            (policy) => policy.sessionId === member.id,
          )!;
          return {
            id: member.id,
            name: member.name,
            state: member.id === 'reviewer' ? 'Outcome uncertain' : 'Independent session',
            policy: { reads: policy.readsFutureDiscussion, replies: policy.repliesByDefault },
          };
        })}
        policyFeedback={
          presentation.pendingPolicy ? (
            <>
              <p role="status">
                {presentation.pendingPolicy.needsRefresh
                  ? 'Discussion sharing was saved. Refresh to confirm its current choices.'
                  : presentation.pendingPolicy.uncertain
                    ? 'The policy outcome is uncertain. Check the original request.'
                    : 'Saving discussion sharing choices…'}
              </p>
              {presentation.pendingPolicy.needsRefresh && presentation.policyError && (
                <p role="alert">{presentation.policyError}</p>
              )}
              {(presentation.pendingPolicy.needsRefresh ||
                presentation.pendingPolicy.uncertain) && (
                <button
                  className="home-secondary"
                  disabled={presentation.loading}
                  onClick={() => {
                    void presentation.retryPolicy();
                  }}
                >
                  {presentation.pendingPolicy.needsRefresh
                    ? 'Refresh sharing'
                    : 'Check original policy request'}
                </button>
              )}
            </>
          ) : presentation.policyError ? (
            <>
              <p role="alert">{presentation.policyError}</p>
              <button
                className="home-secondary"
                onClick={() => {
                  void presentation.refresh();
                }}
              >
                Refresh sharing
              </button>
            </>
          ) : undefined
        }
        policyUnavailableReason={
          presentation.pendingPolicy?.needsRefresh
            ? 'Refresh discussion sharing to confirm the saved policy.'
            : presentation.pendingPolicy
              ? 'Waiting for the original policy request.'
              : presentation.policyError
                ? 'Refresh discussion sharing before changing it.'
                : undefined
        }
        onPolicyChange={
          presentation.policyDisabled
            ? undefined
            : (id, values) => {
                void presentation.setPolicy(id, values);
              }
        }
      />
      {projection && (
        <CollaborationTranscript
          projection={projection}
          names={names}
          onRefresh={() => {
            void presentation.refresh();
          }}
        />
      )}
      {draft && (
        <div className="conversation-composer">
          <ChatInput
            sessionId="offline-shared-conversation"
            savedChatDraft={draft}
            running={false}
            onStop={() => {}}
            onSend={() => {
              setSends(sends + 1);
              return false;
            }}
            sendDisabledReason={presentation.sendDisabledReason}
            responders={composerResponders}
          />
        </div>
      )}
      {presentation.draftError && <p role="alert">{presentation.draftError}</p>}
      <div data-fixture-control>
        <output aria-label="Send attempts">{sends}</output>
        <button
          onClick={() => {
            void presentation.refreshEvents();
          }}
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
