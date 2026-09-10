import './network';
import '../lib/event-bus-singleton';
import { AUTH_RESTORED_EVENT } from '../lib/api-fetch';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom';
import type { WebSocketLike } from '@mitzo/client';
import { MobileShell } from '../components/MobileShell';
import { DesktopShell } from '../components/DesktopShell';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { createMitzoStore } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { ResponsiveChatView } from '../components/ResponsiveChatView';
import { SessionList } from '../pages/SessionList';
import { previewSessionState } from './session-state';
import '../styles/global.css';
import '../styles/desktop.css';
import '../styles/workspace.css';
import '../styles/workspace-chat.css';

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
      queueMicrotask(() =>
        socket.onmessage?.({ data: JSON.stringify({ type: 'welcome', connectionId: 'preview' }) }),
      );
      return socket;
    },
  },
});
function selectSession(id: string | null) {
  store.setState((s) => ({
    sessions: { ...s.sessions, active: id },
    messages: {
      ...s.messages,
      ...previewSessionState(id),
    },
  }));
}
selectSession('preview-1');
store.setState({
  connection: { status: 'connected', clientId: 'preview' },
  switchSession: async (id) => selectSession(id),
  newSession: () => selectSession(null),
  fetchSessionMeta: async () => {},
  closeSession: () => selectSession(null),
  sendMessage: () => {},
  interruptMessage: () => {},
  stopGeneration: () => {
    store.setState((s) => ({ messages: { ...s.messages, running: false } }));
  },
});
// This entry point intentionally mounts its fixture routes directly.
// eslint-disable-next-line react-refresh/only-export-components
function PreviewSessions() {
  return useIsDesktop() ? <DesktopShell center={<SessionList />} /> : <SessionList />;
}

// Unblock the fixture event stream without changing real login state or storage.
window.dispatchEvent(new Event(AUTH_RESTORED_EVENT));

createRoot(document.getElementById('root')!).render(
  <MitzoStoreProvider value={store}>
    <MemoryRouter initialEntries={['/chat/preview-1']}>
      <MobileShell>
        <Routes>
          <Route path="/chat/:sessionId?" element={<ResponsiveChatView />} />
          <Route path="/sessions" element={<PreviewSessions />} />
          <Route path="*" element={<Navigate to="/sessions" replace />} />
        </Routes>
      </MobileShell>
    </MemoryRouter>
  </MitzoStoreProvider>,
);
