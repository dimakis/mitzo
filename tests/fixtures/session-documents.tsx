import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import { SessionResourcesDialog } from '../../frontend/src/components/SessionResourcesDialog';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace-chat.css';
function Fixture() {
  const [sessionId, setSessionId] = useState('one');
  return (
    <main style={{ padding: 'var(--page-gutter)' }}>
      <button onClick={() => setSessionId(sessionId === 'one' ? 'two' : 'one')}>Switch chat</button>
      <SessionResourcesDialog
        sessionId={sessionId}
        messages={[]}
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
