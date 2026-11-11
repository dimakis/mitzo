import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { AgentMessageCard } from '../../frontend/src/components/AgentMessageCard';
import { MemoryRouter } from 'react-router-dom';
import { ChatArea } from '../../frontend/src/components/ChatArea';
import { ReplyQuote } from '../../frontend/src/components/ReplyQuote';
import type { AgentMessageProjection } from '../../packages/protocol/src/agent-communication';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';

const incoming: AgentMessageProjection = {
  direction: 'incoming',
  // Reproduce a retained event whose label was recorded before the chat was named.
  senderName: '64d8bed3-f73f-8939-8dcf-987cd24fcf6f',
  recipientName: 'Independent feature session',
  timestamp: 1793925200000,
  message: {
    messageId: 'c5d70b9d-8b6f-4640-bdf4-a958abb272f6',
    commandId: 'agent-message:first',
    senderConversationId: '64d8bed3-f73f-8939-8dcf-987cd24fcf6f',
    recipientConversationId: 'feature',
    text: 'Pause PR work until the coordinator releases you.\nLet current CI finish. Keep your checkout and uncommitted work.\nThis entire message remains visible before delivery.',
    replyTo: null,
    status: 'queued',
    reason: null,
    sequence: 1,
  },
};
function Fixture() {
  const [status, setStatus] = useState(incoming.message.status);
  return (
    <main className="workspace-page">
      <h1>Agent messages</h1>
      <AgentMessageCard projection={{ ...incoming, message: { ...incoming.message, status } }} />
      <div className="home-inline-actions">
        <button type="button" className="home-secondary" onClick={() => setStatus('delivered')}>
          Record delivery
        </button>
        <button type="button" className="home-secondary" onClick={() => setStatus('failed')}>
          Show failure
        </button>
      </div>
      <AgentMessageCard
        projection={{
          ...incoming,
          direction: 'outgoing',
          message: {
            ...incoming.message,
            messageId: '92fbd832-1c7f-4b71-8d90-b8ea128664d3',
            commandId: 'agent-message:reply',
            replyTo: incoming.message.messageId,
            text: 'Holding PR work. No merge is in flight.',
            status: 'delivered',
          },
        }}
      />
      <h2>Earlier reply context</h2>
      <ChatArea
        sessionId="reply-fixture"
        messages={[
          {
            messageId: 'original-question',
            role: 'user',
            timestamp: 1793925200000,
            blocks: [
              {
                blockId: 'question-text',
                blockType: 'text',
                content: 'Keep the recovery isolated until its checks pass.',
              },
            ],
          },
          {
            messageId: 'answer',
            role: 'assistant',
            replyToMessageId: 'original-question',
            timestamp: 1793925400000,
            blocks: [
              {
                blockId: 'answer-text',
                blockType: 'text',
                content: 'The recovery is isolated and its checks are passing.',
              },
            ],
          },
        ]}
        current={null}
        running={false}
        permission={null}
        onPermissionRespond={() => {}}
      />
      <div className="fixture-composer">
        <ReplyQuote
          sessionId="reply-fixture"
          reply={{
            messageId: 'original-question',
            role: 'user',
            text: 'Composer selection',
            timestamp: 1793925200000,
          }}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <Fixture />
  </MemoryRouter>,
);
