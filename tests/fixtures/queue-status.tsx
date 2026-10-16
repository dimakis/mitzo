import { createRoot } from 'react-dom/client';
import { createMitzoStore } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import type { WebSocketLike } from '../../packages/client/src/ws-connection';
import { CodexQueueStatus } from '../../frontend/src/components/CodexQueueStatus';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';

// All transport events and HTTP responses are synthetic and contain no transcript.
const socket: WebSocketLike = {
  readyState: 1,
  onopen: null,
  onmessage: null,
  onclose: null,
  onerror: null,
  send() {},
  close() {},
};
const emit = (sessionId = 'queue-fixture') =>
  socket.onmessage?.({ data: JSON.stringify({ type: 'codex_queue', sessionId, items: [] }) });
const store = createMitzoStore({
  transport: { fetch: (url, options) => fetch(url, options) },
  wsConfig: { buildUrl: () => '/offline', createWebSocket: () => socket },
});
socket.onopen?.({});
socket.onmessage?.({
  data: JSON.stringify({ type: 'welcome', protocolVersion: 2, connectionId: 'fixture' }),
});
await store.getState().switchSession('queue-fixture');
createRoot(document.getElementById('root')!).render(
  <MitzoStoreProvider value={store}>
    <button onClick={() => emit()}>Emit queue metadata change</button>
    <button onClick={() => emit('other-fixture')}>Emit other chat change</button>
    <CodexQueueStatus sessionId="queue-fixture" />
  </MitzoStoreProvider>,
);
