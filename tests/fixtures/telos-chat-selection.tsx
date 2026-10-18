import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { TelosWorkViewSchema } from '../../packages/protocol/src/telos-work-api';
import { TelosChatList } from '../../frontend/src/components/TelosChatList';
import { TelosChatFrame } from '../../frontend/src/components/TelosChatFrame';
import { ChatArea } from '../../frontend/src/components/ChatArea';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import type { TelosChatRow } from '../../frontend/src/lib/telos-chat-rows';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/motion.css';

const work = TelosWorkViewSchema.parse({
  itemId: 'slice',
  kind: 'work_item',
  parentId: 'outcome',
  revision: 'a'.repeat(64),
  links: ['origin', 'worker', 'reviewer'].map((role) => ({
    version: 1,
    linkId: role,
    itemId: 'slice',
    role,
    conversation: { namespace: 'mitzo', conversationId: role },
    linkedAt: '2026-10-18',
    linkedBy: 'Dimitri',
    availability: 'available',
    attemptId: null,
  })),
  assignments: [
    {
      itemId: 'slice',
      role: 'worker',
      conversation: { namespace: 'mitzo', conversationId: 'worker' },
      revision: 1,
      assignedAt: '2026-10-18',
      assignedBy: 'Dimitri',
    },
  ],
  sources: [],
  attempts: [],
});
function Fixture() {
  const [selected, setSelected] = useState<TelosChatRow | null>(null);
  const [notice, setNotice] = useState('');
  const title = 'Contributor controls and independent review for the next release';
  if (!selected)
    return (
      <main>
        <TelosChatList
          work={work}
          title={title}
          onOpen={setSelected}
          onNewChat={() => setNotice('Additional ordinary chat setup requested')}
          onChangeAssignment={() => setNotice('Replacement worker setup requested')}
        />
        {notice && <p role="status">{notice}</p>}
      </main>
    );
  const conversationId = selected.conversation.conversationId;
  const reviewer = conversationId === 'reviewer';
  return (
    <TelosChatFrame
      key={conversationId}
      itemTitle={title}
      chatCount={3}
      onItem={() => setSelected(null)}
      onChats={() => setSelected(null)}
      header={
        <header className="fixture-header">
          <button type="button" aria-label="Back" onClick={() => setSelected(null)}>
            ‹
          </button>
          <div>
            <h1>{reviewer ? 'Reviewer' : 'Worker'}</h1>
            <output aria-label="Fixture account">
              {reviewer ? 'Review account' : 'Work account'}
            </output>
          </div>
        </header>
      }
      tree={
        <div>
          <h3>{title}</h3>
          <p>Awaiting review</p>
          <p>P7</p>
          <p>The worker has returned evidence. Outcome acceptance remains outstanding.</p>
        </div>
      }
    >
      <div className="fixture-conversation">
        <ChatArea
          sessionId={conversationId}
          messages={[
            {
              messageId: conversationId,
              role: 'assistant',
              blocks: [
                {
                  blockId: conversationId,
                  blockType: 'text',
                  content: reviewer ? 'Reviewer transcript' : 'Worker transcript',
                },
              ],
            },
          ]}
          current={null}
          running={false}
          permission={null}
          onPermissionRespond={() => {}}
        />
        <ChatInput
          sessionId={conversationId}
          running={false}
          onSend={() => false}
          onStop={() => {}}
        />
      </div>
    </TelosChatFrame>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <Fixture />
  </MemoryRouter>,
);
