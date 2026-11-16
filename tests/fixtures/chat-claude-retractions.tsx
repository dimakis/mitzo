import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { createMitzoStore, messagesReducer } from '@mitzo/client';
import { MitzoStoreProvider, useMitzoStore } from '@mitzo/client/hooks';
import type { WebSocketLike } from '../../packages/client/src/ws-connection';
import { ChatArea } from '../../frontend/src/components/ChatArea';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace-chat.css';

const socket: WebSocketLike = {
  readyState: 1,
  onopen: null,
  onmessage: null,
  onclose: null,
  onerror: null,
  send() {},
  close() {},
};
const store = createMitzoStore({
  transport: { fetch: (url, options) => fetch(url, options) },
  wsConfig: { buildUrl: () => '/offline', createWebSocket: () => socket },
});
socket.onopen?.({});
socket.onmessage?.({
  data: JSON.stringify({ type: 'welcome', protocolVersion: 2, connectionId: 'fixture' }),
});
let seq = 0;
const emit = (event: Record<string, unknown>) =>
  socket.onmessage?.({
    data: JSON.stringify({ sessionId: 'retraction-fixture', seq: ++seq, ...event }),
  });
emit({ type: 'session_id' });
emit({ type: 'user_message', messageId: 'command', text: 'Keep this original request.' });
emit({ type: 'session_state_changed', state: 'running' });
function text(messageId: string, content: string) {
  emit({ type: 'message_start', messageId });
  emit({ type: 'block_start', messageId, blockId: 'text', blockType: 'text' });
  emit({ type: 'block_delta', messageId, blockId: 'text', blockType: 'text', delta: content });
  emit({ type: 'block_end', messageId, blockId: 'text', blockType: 'text' });
}
text('old', 'Superseded draft answer.');
emit({
  type: 'block_start',
  messageId: 'old',
  blockId: 'tool',
  blockType: 'tool_use',
  toolId: 'read',
  toolName: 'Read',
});
emit({
  type: 'block_end',
  messageId: 'old',
  blockId: 'tool',
  blockType: 'tool_use',
  toolId: 'read',
  toolName: 'Read',
  toolInput: '{"file_path":"README.md"}',
});
emit({ type: 'tool_result', toolId: 'read', result: 'Superseded tool result.' });
emit({ type: 'message_end', messageId: 'old' });
const original = store.getState().messages.messages;
(window as unknown as { retractionFixture: unknown }).retractionFixture = {
  replace() {
    text('replacement', 'The corrected answer is retained.');
    emit({ type: 'message_end', messageId: 'replacement' });
    emit({ type: 'message_retracted', messageId: 'old' });
    emit({ type: 'message_retracted', messageId: 'old', toolId: 'read' });
  },
  staleRestore() {
    store.setState((s) => ({
      messages: messagesReducer(s.messages, {
        type: 'RESTORE',
        messages: [
          ...original,
          ...s.messages.messages.filter((m) => m.messageId === 'replacement'),
        ],
      }),
    }));
  },
  running() {
    return store.getState().messages.running;
  },
};
function Fixture() {
  const messages = useMitzoStore((s) => s.messages);
  return (
    <main>
      <ChatArea
        messages={messages.messages}
        current={messages.current}
        running={messages.running}
        permission={null}
        onPermissionRespond={() => {}}
      />
      <textarea aria-label="Unsent draft" defaultValue="Keep this unsent draft." />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <MitzoStoreProvider value={store}>
      <Fixture />
    </MitzoStoreProvider>
  </MemoryRouter>,
);
