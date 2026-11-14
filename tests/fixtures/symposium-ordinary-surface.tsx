import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { createMitzoStore, MitzoApiClient, type WebSocketLike } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { SharedConversationHost } from '../../frontend/src/components/SharedConversation';
import { SymposiumConversation } from '../../frontend/src/components/SymposiumConversation';
import { ChatInputHost } from '../../frontend/src/components/ChatInputHost';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/home.css';

const store = createMitzoStore({
  transport: { fetch: (url, init) => fetch(url, init) },
  wsConfig: {
    buildUrl: () => '',
    createWebSocket: () => {
      const socket: WebSocketLike = {
        readyState: 1,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: () => {},
        close: () => {},
      };
      queueMicrotask(() => {
        socket.onopen?.({});
        socket.onmessage?.({
          data: JSON.stringify({ type: 'welcome', connectionId: 'offline-surface' }),
        });
      });
      return socket;
    },
  },
});
const api = new MitzoApiClient((url, init) => fetch(url, init));
const proof = () => 'offline-surface-login';
const messages = [
  {
    messageId: 'ordinary-history',
    role: 'user' as const,
    blocks: [
      { blockId: 'text', blockType: 'text' as const, content: 'Ordinary history before joining' },
    ],
  },
];

function Surface() {
  const desktop = useIsDesktop();
  const [running, setRunning] = useState(false);
  return (
    <MitzoStoreProvider value={store}>
      <MemoryRouter>
        <SharedConversationHost
          sourceConversationId="architect"
          api={api}
          clientId="offline-client"
          authScope={proof()}
          getVerifiedAuthScope={proof}
        >
          <ChatInputHost sessionId="architect">
            <main className="chat-page workspace-chat">
              <SymposiumConversation
                key={desktop ? 'desktop' : 'phone'}
                sessionId="architect"
                ordinaryConfirmed={!desktop}
                profileToolsTarget={null}
                chat={{
                  sessionId: 'architect',
                  messages,
                  current: null,
                  running,
                  permission: null,
                  onPermissionRespond: () => {},
                }}
                ordinaryComposer={
                  <div className="conversation-composer">
                    <ChatInput
                      sessionId="architect"
                      initialText="Ordinary unsent draft"
                      running={running}
                      onStop={() => setRunning(false)}
                      onSend={() => false}
                    />
                  </div>
                }
              />
              <div data-fixture-control>
                <button onClick={() => void fetch('/fixture/join', { method: 'POST' })}>
                  Join reviewer externally
                </button>
                <button onClick={() => setRunning(!running)}>Toggle source running</button>
              </div>
            </main>
          </ChatInputHost>
        </SharedConversationHost>
      </MemoryRouter>
    </MitzoStoreProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Surface />);
