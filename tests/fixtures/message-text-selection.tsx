import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { MessageActions } from '../../frontend/src/components/MessageActions';
import { TextBubble, UserBubble } from '../../frontend/src/components/MessageBubble';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';

const answer =
  'Select part of this answer to copy. Native selection should stay available while you move the selection handles.';
function Fixture() {
  const [replies, setReplies] = useState(0);
  return (
    <MemoryRouter>
      <main className="chat-messages">
        <output aria-label="Replies">{replies}</output>
        {(['user', 'assistant'] as const).map((role) => (
          <MessageActions
            key={role}
            message={{
              messageId: role,
              role,
              text: role === 'user' ? 'Copy just a few words from my request.' : answer,
              timestamp: 1793356740000,
            }}
            onReply={() => setReplies((n) => n + 1)}
          >
            {role === 'user' ? (
              <UserBubble text="Copy just a few words from my request." timestamp={1793356740000} />
            ) : (
              <TextBubble content={answer} timestamp={1793356740000} />
            )}
          </MessageActions>
        ))}
      </main>
    </MemoryRouter>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
