import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ChatArea } from '../../frontend/src/components/ChatArea';
import type { FinishedBlock } from '../../frontend/src/types/chat';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/motion.css';

const receipt = {
  version: 1,
  state: 'chat_ready',
  execution: 'not_started',
  workerConversationId: 'worker',
  workerPath: '/chat/worker',
  itemPath: '/todos/child',
  leadPath: '/chat/lead',
  attempt: {
    version: 1,
    requestId: 'request',
    attemptId: 'attempt',
    predecessorAttemptId: null,
    leadConversationId: 'lead',
    childItemId: 'child',
    contextSnapshotId: 'snapshot',
    state: 'chat_ready',
    workerConversationId: 'worker',
    allocationReceiptId: 'allocation',
    executionTaskId: 'task',
    accountingGoalId: null,
    turnCommandId: null,
  },
  workerDisplay: {
    title: 'Plan recording setup for the first home studio session',
    profile: 'Research',
    account: 'Personal Codex',
    model: 'Luna',
    thinking: 'High',
    target: 'Independent workspace',
  },
};
const block: FinishedBlock = {
  blockId: 'receipt',
  blockType: 'tool_use',
  content: '',
  toolName: 'TelosStartSlice',
  toolInput:
    new URLSearchParams(window.location.search).get('input') === 'truncated'
      ? JSON.stringify({
          childItemId: 'child',
          requestId: 'request',
          source: {
            conversationId: 'lead',
            messageId: 'original-source-message-for-the-reviewed-worker-slice',
          },
          materialRevision: 'reviewed-material-revision-for-the-independent-workspace',
        }).slice(0, 200)
      : JSON.stringify({ childItemId: 'child', requestId: 'request' }),
  toolResult: JSON.stringify(receipt),
};
function Conversation() {
  const location = useLocation();
  return (
    <main className="receipt-fixture">
      <h1>Home studio · lead conversation</h1>
      <p>The worker conversation is ready for the reviewed slice.</p>
      <ChatArea
        sessionId="lead"
        messages={[
          {
            messageId: 'delegation',
            role: 'assistant',
            blocks: [
              block,
              {
                blockId: 'other',
                blockType: 'tool_use',
                content: '',
                toolName: 'Read',
                toolResult: 'Reviewed source.',
              },
            ],
          },
        ]}
        current={null}
        running={false}
        permission={null}
        onPermissionRespond={() => {}}
      />
      <label>
        Message Mitzo
        <textarea
          aria-label="Message Mitzo"
          defaultValue="Keep this draft in the lead conversation."
        />
      </label>
      <output aria-label="Current conversation">{location.pathname}</output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/chat/lead']}>
    <Conversation />
  </MemoryRouter>,
);
