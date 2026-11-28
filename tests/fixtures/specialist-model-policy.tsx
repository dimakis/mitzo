import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ConversationAgents } from '../../frontend/src/components/ConversationAgents';
import { restoreCookieAuthentication } from '../../frontend/src/lib/api-fetch';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/home.css';

void restoreCookieAuthentication().then(() =>
  createRoot(document.getElementById('root')!).render(
    <MemoryRouter>
      <main className="workspace-chat">
        <ConversationAgents
          scope="policy-fixture"
          modelPolicySessionId="policy-fixture"
          agents={[{ id: 'lead', name: 'Lead', state: 'Current conversation' }]}
          messages={[]}
        />
      </main>
    </MemoryRouter>,
  ),
);
