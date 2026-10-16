import { useEffect, useReducer } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import {
  INITIAL_MESSAGES_STATE,
  messagesReducer,
  parseServerMessage,
  type ProtocolCallbacks,
} from '@mitzo/client';
import { ChatArea } from '../../frontend/src/components/ChatArea';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';

const callbacks: ProtocolCallbacks = {
  onSessionAssigned() {},
  onSessionExpired() {},
  onMessagesRestored() {},
  onSessionRenamed() {},
  setWsRunning() {},
};
function Conversation() {
  const [state, dispatch] = useReducer(messagesReducer, INITIAL_MESSAGES_STATE);
  useEffect(() => {
    const receive = (event: Event) => {
      const parsed = parseServerMessage(
        (event as CustomEvent).detail,
        { currentSessionId: 'shared-chat' },
        callbacks,
        'shared-chat',
      );
      for (const action of parsed.messagesActions) dispatch(action);
    };
    window.addEventListener('fixture-server-message', receive);
    return () => window.removeEventListener('fixture-server-message', receive);
  }, []);
  return (
    <main className="chat-page workspace-chat">
      <ChatArea
        sessionId="shared-chat"
        messages={state.messages}
        current={state.current}
        running={state.running}
        permission={state.permission}
        onPermissionRespond={() => {}}
      />
      <div className="conversation-composer">
        <ChatInput running={state.running} onSend={() => true} onStop={() => {}} />
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <Conversation />
  </MemoryRouter>,
);
