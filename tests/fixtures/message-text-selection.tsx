import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { MessageActions } from '../../frontend/src/components/MessageActions';
import { TextBubble, UserBubble } from '../../frontend/src/components/MessageBubble';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';

const answer =
  'Select part of this answer to copy. Native selection should stay available while you move the selection handles.';
const readAloud = { active: false, onSpeak: () => {}, onStop: () => {} };
function Fixture() {
  const [replies, setReplies] = useState(0);
  const [actionsReady, setActionsReady] = useState(false);
  useEffect(() => {
    const ready = () => setActionsReady(true);
    window.addEventListener('fixture-enable-message-actions', ready);
    return () => window.removeEventListener('fixture-enable-message-actions', ready);
  }, []);
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
            onReply={actionsReady ? () => setReplies((n) => n + 1) : undefined}
            readAloud={readAloud}
          >
            {role === 'user' ? (
              <UserBubble
                text="Copy just a few words from my request."
                timestamp={1793356740000}
                readAloud={readAloud}
              />
            ) : (
              <TextBubble content={answer} timestamp={1793356740000} readAloud={readAloud} />
            )}
          </MessageActions>
        ))}
      </main>
    </MemoryRouter>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
