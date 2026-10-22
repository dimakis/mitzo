import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';

function Surface() {
  const [sent, setSent] = useState('');
  return (
    <MemoryRouter>
      <main>
        <h1>PDF import</h1>
        <ChatInput
          running={false}
          onStop={() => {}}
          onSend={(text, images) => {
            setSent(
              JSON.stringify({
                text,
                images: images?.map(({ mediaType, data }) => ({ mediaType, bytes: data.length })),
              }),
            );
            return true;
          }}
        />
        <output aria-label="Submitted message">{sent}</output>
      </main>
    </MemoryRouter>
  );
}
createRoot(document.getElementById('root')!).render(<Surface />);
