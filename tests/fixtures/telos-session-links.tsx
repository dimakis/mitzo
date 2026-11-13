import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { TelosSourceWorkLink } from '../../frontend/src/components/TelosSourceWorkLink';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/home.css';
import '../../frontend/src/styles/session-library.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';

createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <main className="chat-page workspace-chat">
      <TelosSourceWorkLink conversationId="worker" hideItemLink />
      <div className="chat-area">
        <p>Keep the current work and composer while reviewing coordination.</p>
      </div>
      <div className="conversation-composer">
        <ChatInput running={false} onSend={() => false} onStop={() => {}} />
      </div>
    </main>
  </MemoryRouter>,
);
