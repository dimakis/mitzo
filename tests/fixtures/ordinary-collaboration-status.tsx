import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { MitzoApiClient } from '@mitzo/client';
import {
  SharedConversationHost,
  SharedConversationBody,
} from '../../frontend/src/components/SharedConversation';
import { ComposerStatusProvider } from '../../frontend/src/components/ComposerStatus';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/home.css';

const api = new MitzoApiClient((url, init) => fetch(url, init));
// Only the authentication owner is synthetic; setup, presentation, retry and status use production code.
const proof = () => 'offline-verified-login';
function Fixture() {
  const [source, setSource] = useState('');
  return (
    <MemoryRouter>
      <SharedConversationHost
        sourceConversationId={source}
        api={api}
        clientId="client"
        authScope={proof()}
        getVerifiedAuthScope={proof}
      >
        <ComposerStatusProvider>
          <main className="chat-page workspace-chat">
            <SharedConversationBody
              sourceConversationId={source}
              chat={{
                messages: [],
                current: null,
                running: false,
                permission: null,
                onPermissionRespond: () => {},
              }}
            >
              <div className="chat-messages">
                <p>Ordinary conversation</p>
                <button type="button" onClick={() => setSource('architect')}>
                  Assign ordinary session
                </button>
              </div>
              <div className="conversation-composer">
                <ChatInput
                  sessionId="ordinary-status-fixture"
                  textOnly
                  boundedFirstCommand
                  running={false}
                  onStop={() => {}}
                  onSend={() => false}
                />
              </div>
            </SharedConversationBody>
          </main>
        </ComposerStatusProvider>
      </SharedConversationHost>
    </MemoryRouter>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
