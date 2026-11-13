import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { MitzoApiClient } from '@mitzo/client';
import {
  SharedConversationHost,
  SharedConversationAgents,
  SharedConversationBody,
} from '../../frontend/src/components/SharedConversation';
import {
  currentVerifiedAuthSessionId,
  restoreCookieAuthentication,
} from '../../frontend/src/lib/api-fetch';
import { sharedConversationView } from './symposium-shared-conversation-data';
import { WorkspaceControls } from '../../frontend/src/components/WorkspaceControls';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/home.css';
const api = new MitzoApiClient((url, init) => fetch(url, init));
const group = sharedConversationView().collaborationId;
void restoreCookieAuthentication().then((ok) => {
  if (!ok) throw Error('Offline fixture login unavailable');
  createRoot(document.getElementById('root')!).render(
    <MemoryRouter>
      <main className="chat-page workspace-chat">
        <SharedConversationHost
          sourceConversationId="architect"
          clientId="offline-client"
          api={api}
          authScope={currentVerifiedAuthSessionId()}
          getVerifiedAuthScope={currentVerifiedAuthSessionId}
        >
          <WorkspaceControls
            status="Ready"
            settings={<input aria-label="Source setting" defaultValue="Original chat" />}
            actions={
              <SharedConversationAgents
                compact
                scope="architect"
                repository="example/project"
                agents={[{ id: 'architect', name: 'Architect', state: 'Current conversation' }]}
                messages={[]}
              />
            }
          >
            <p>Original chat controls</p>
          </WorkspaceControls>
          <SharedConversationBody
            sourceConversationId="architect"
            chat={{
              messages: [],
              current: null,
              running: false,
              permission: null,
              onPermissionRespond: () => {},
            }}
            ordinaryHistory={
              <p className="conversation-replay-status">Original discussion remains available.</p>
            }
          >
            <p>Checking the retained conversation…</p>
          </SharedConversationBody>
        </SharedConversationHost>
      </main>
      <output hidden>{group}</output>
    </MemoryRouter>,
  );
});
