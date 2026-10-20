import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { TelosWorkViewSchema } from '@mitzo/protocol';
import { useTelosChatDetails } from '../../frontend/src/hooks/useTelosChatDetails';
import { TelosChatList } from '../../frontend/src/components/TelosChatList';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
const work = TelosWorkViewSchema.parse({
  itemId: 'item',
  kind: 'outcome',
  parentId: null,
  revision: 'a'.repeat(64),
  sources: [],
  attempts: [],
  links: ['former', 'additional', 'current'].map((conversationId) => ({
    version: 1,
    linkId: conversationId,
    itemId: 'item',
    role: 'lead',
    conversation: { namespace: 'mitzo', conversationId },
    linkedAt: '2026-10-20T01:13:23.803Z',
    linkedBy: 'operator:dce4a056-4350-43f7-bc7a-2592150ca7ee',
    availability: 'available',
    attemptId: null,
  })),
  assignments: [
    {
      itemId: 'item',
      role: 'lead',
      conversation: { namespace: 'mitzo', conversationId: 'current' },
      revision: 2,
      assignedAt: null,
      assignedBy: null,
    },
  ],
  assignmentHistory: {
    lead: { complete: true, conversationIds: ['former', 'current'] },
    worker: { complete: true, conversationIds: [] },
  },
});
function Fixture() {
  const details = useTelosChatDetails(work);
  const [opened, setOpened] = useState('');
  return (
    <main>
      <TelosChatList
        work={work}
        title="Home studio"
        details={details}
        onOpen={(row) => setOpened(row.conversation.conversationId)}
        onNewChat={() => {}}
      />
      <output aria-label="Opened chat">{opened}</output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
