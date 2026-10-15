import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SessionResourcesDialog } from '../../frontend/src/components/SessionResourcesDialog';
import type { FinishedMessage } from '../../frontend/src/types/chat';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace-chat.css';
const messages: FinishedMessage[] = Array.from({ length: 40 }, (_, index) => ({
  messageId: `m${index}`,
  role: 'assistant',
  blocks: [
    {
      blockId: `b${index}`,
      blockType: 'text',
      content: [1, 2, 10]
        .map(
          (revision) =>
            `[${index === 39 ? 'Release checklist with a longer descriptive name' : `Design ${index}`}](/task/mockups/design-${index}/v${String(revision).padStart(3, '0')}.html)`,
        )
        .join('\n\n'),
    },
  ],
}));
function Fixture() {
  const [session, setSession] = useState('one');
  return (
    <main style={{ padding: 'var(--page-gutter)' }}>
      <button onClick={() => setSession(session === 'one' ? 'two' : 'one')}>Switch chat</button>
      <SessionResourcesDialog
        sessionId={session}
        messages={session === 'one' ? messages : []}
        selectedContextBlocks={[]}
        draftImages={[]}
        onToggleContextBlock={() => {}}
        onAddImages={() => {}}
        onRemoveImage={() => {}}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <Fixture />
  </MemoryRouter>,
);
