import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { createMitzoStore, MitzoApiClient, type WebSocketLike } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import {
  SharedConversationHost,
  SharedConversationAgents,
} from '../../frontend/src/components/SharedConversation';
import { SymposiumConversation } from '../../frontend/src/components/SymposiumConversation';
import { ChatInputHost } from '../../frontend/src/components/ChatInputHost';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { WorkspaceControls } from '../../frontend/src/components/WorkspaceControls';
import { SessionAccess } from '../../frontend/src/components/SessionAccess';
import { UiIcon } from '../../frontend/src/components/UiIcon';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
import type { UseVoiceReturn } from '../../frontend/src/hooks/useVoice';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/home.css';
import '../../frontend/src/styles/header-actions.css';

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
// Deterministic audio capability boundary. Render the real MicButton without
// touching hardware, a speech service, or the production useVoice owner.
const voice: UseVoiceReturn = {
  available: true,
  recording: false,
  transcribing: false,
  micBlocked: false,
  error: null,
  partialTranscript: '',
  startRecording: async () => {},
  stopRecording: async () => '',
  cancelRecording: () => {},
  ttsAvailable: false,
  speaking: false,
  voices: [],
  selectedVoice: 'offline',
  speak: async () => {},
  stopSpeaking: () => {},
  setVoice: () => {},
};
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
              <WorkspaceControls
                scopeKey="architect"
                title="Ordinary chat"
                agent="Architect"
                status="Ready"
                settings={<p>Retained conversation settings</p>}
                leading={
                  <button type="button" className="chat-top-action" aria-label="Back to chats">
                    <UiIcon name="back" />
                  </button>
                }
                trailing={
                  <button type="button" className="chat-top-action" aria-label="New chat">
                    <UiIcon name="edit" />
                  </button>
                }
                actions={
                  <>
                    <SharedConversationAgents
                      compact
                      scope="architect"
                      messages={messages}
                      agents={[
                        { id: 'architect', name: 'Architect', state: 'Current conversation' },
                      ]}
                    />
                    <SessionAccess sessionId="architect" connected />
                  </>
                }
              >
                {null}
              </WorkspaceControls>
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
                      voice={voice}
                      tokenState={{
                        agentContext: 5000,
                        sessionTotal: 9000,
                        contextCeiling: 0,
                        numTurns: 2,
                        turnIndex: 1,
                        numCompactions: 0,
                      }}
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
