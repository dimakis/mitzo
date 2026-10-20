import { BrowserRouter } from 'react-router-dom';
import { SourceContext } from '../../frontend/src/hooks/useTelosSourceNavigation';
import type { TelosSourcePacket } from '@mitzo/protocol';
import { ChatArea } from '../../frontend/src/components/ChatArea';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { TelosChatFrame } from '../../frontend/src/components/TelosChatFrame';
import { TelosOutcomesTree } from '../../frontend/src/components/TelosOutcomesTree';
import { createTelosWorkFixtures } from '../../frontend/src/test-utils/telos-work-fixtures';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/motion.css';
const template = createTelosWorkFixtures().homeStudio.items[0];
const child = { ...template, itemId: 'selected', parentId: 'parent', summary: 'Record one sample' };
const parent = { ...template, itemId: 'parent', parentId: null, summary: 'Home studio' };
function Fixture() {
  const [hydrated, setHydrated] = useState(false);
  const [refresh, setRefresh] = useState(0);
  return (
    <TelosChatFrame
      conversationId="worker"
      itemTitle={child.summary}
      chatCount={1}
      onItem={() => {}}
      onChats={() => {}}
      header={<header>Worker conversation</header>}
      tree={
        <>
          <button onClick={() => setHydrated(true)}>Load canonical parent</button>
          <button onClick={() => setRefresh((v) => v + 1)}>Refresh canonical records</button>
          <TelosOutcomesTree
            compact
            records={hydrated ? [{ ...parent }, { ...child }] : [child]}
            selectedId={child.itemId}
            refreshKey={refresh}
            onOpen={() => {}}
          />
        </>
      }
    >
      <SourceContext.Provider
        value={{
          itemId: 'created',
          snapshotId: 'source-created',
          conversationId: 'worker',
          status: 'ready',
          packet: {
            itemId: null,
            creation: { requestId: 'creation', outcome: { summary: 'Created acoustic outcome' } },
            selection: { mode: 'selected' },
            context: {
              sourceConversationId: 'worker',
              boundary: { messageId: 'agreed', sequence: 11 },
              messages: [
                { messageId: 'earlier', sequence: 2 },
                { messageId: 'agreed', sequence: 11 },
              ],
            },
            attributions: { agreed: { seatId: null, provenance: null, createdAt: 1 } },
          } as unknown as TelosSourcePacket,
        }}
      >
        <ChatArea
          sessionId="worker"
          messages={[
            {
              messageId: 'agreed',
              role: 'user',
              blocks: [
                {
                  blockId: 'agreed-text',
                  blockType: 'text',
                  content: 'Retained original transcript',
                },
              ],
            },
          ]}
          current={null}
          running={false}
          permission={null}
          onPermissionRespond={() => {}}
        />
      </SourceContext.Provider>
      <textarea aria-label="Unsent draft" defaultValue="Keep this worker draft" />
    </TelosChatFrame>
  );
}
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Fixture />
  </BrowserRouter>,
);
