import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { TelosWorkRoleContextSelection, TelosWorkRoleContextReview } from '@mitzo/protocol';
import { TelosLinkedContext } from '../../frontend/src/components/TelosLinkedContext';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/home.css';
import '../../frontend/src/styles/session-library.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';

const context: TelosWorkRoleContextSelection = {
  version: 1,
  itemId: 'recording',
  role: 'worker',
  brief: {
    revision: 'a'.repeat(64),
    sha256: 'b'.repeat(64),
    text: JSON.stringify({
      summary: 'Record the reviewed first session with the agreed equipment and room arrangement',
      intent: 'Retain a recording that the lead can review.',
      rationale: 'Confirm that the home studio is ready for the next session.',
      acceptanceCriteria: ['The reviewed recording is retained with its notes.'],
    }),
  },
  overallGoal: {
    itemId: 'studio',
    revision: 'c'.repeat(64),
    text: 'Create a home studio with a comfortable recording space and an agreed budget.',
  },
  parentCriteria: [
    { itemId: 'session-plan', revision: 'd'.repeat(64), criteria: ['Keep the agreed budget.'] },
  ],
  sources: [
    {
      version: 1,
      snapshotId: 'opaque-retained-snapshot',
      itemId: 'recording',
      source: { namespace: 'mitzo', conversationId: 'planning' },
      selection: {
        kind: 'selected',
        messageIds: ['opaque-retained-message'],
        blockIds: [],
        throughSequence: 12,
      },
      adoptedBrief: null,
      artifacts: [],
      author: null,
      sourceCreatedAt: null,
      adoptedAt: null,
    },
  ],
  artifacts: [{ artifactId: 'e'.repeat(32), revision: 2, sha256: 'f'.repeat(64) }],
};

const reviewed = (window as Window & { __TELOS_REVIEW__?: TelosWorkRoleContextReview })
  .__TELOS_REVIEW__;
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <main className="chat-page workspace-chat">
      <div className="telos-chat-context">
        <TelosLinkedContext
          context={reviewed?.selection ?? context}
          presentation={reviewed?.presentation}
          presentationRef={reviewed?.presentationRef}
        />
      </div>
      <div className="chat-area">
        <p>The conversation and composer remain available while you review the linked context.</p>
      </div>
      <div className="conversation-composer">
        <ChatInput
          running={false}
          onSend={() => false}
          onStop={() => {}}
          draftStorageKey={reviewed ? 'reviewed-context-draft' : undefined}
        />
      </div>
    </main>
  </MemoryRouter>,
);
