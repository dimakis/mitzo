import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { TelosChatFrame } from '../../frontend/src/components/TelosChatFrame';
import { TelosOutcomesTree } from '../../frontend/src/components/TelosOutcomesTree';
import { createTelosWorkFixtures } from '../../frontend/src/test-utils/telos-work-fixtures';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/motion.css';

const records = createTelosWorkFixtures().nestedCoordinator.items;
records[0].summary = 'Recording programme';
function Fixture() {
  const [opened, setOpened] = useState('');
  return (
    <>
      <TelosChatFrame
        conversationId="fixture-chat"
        itemTitle="Home studio"
        chatCount={3}
        onItem={() => {}}
        onChats={() => {}}
        header={<h1>Ordinary chat</h1>}
        tree={
          <TelosOutcomesTree
            compact
            records={records}
            onOpen={setOpened}
            refreshKey={0}
            storageKey="fixture.panel"
          />
        }
      >
        <textarea aria-label="Retained draft" defaultValue="Keep this draft" />
      </TelosChatFrame>
      <section aria-label="Full workspace child tree">
        <TelosOutcomesTree
          compact
          records={records}
          onOpen={setOpened}
          refreshKey={0}
          storageKey="fixture.workspace"
        />
      </section>
      <output aria-label="Opened item">{opened}</output>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
