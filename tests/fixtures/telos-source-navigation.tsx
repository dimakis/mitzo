import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { createMitzoStore, type WebSocketLike } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { ResponsiveChatView } from '../../frontend/src/components/ResponsiveChatView';
import { TodoDetailView } from '../../frontend/src/pages/TodoDetailView';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/workspace-work.css';
import '../../frontend/src/styles/mobile-workspace.css';
import '../../frontend/src/styles/session-library.css';
import '../../frontend/src/styles/motion.css';

/** Inert protocol transport only. The real store switchSession, transcript read,
 * responsive routes, metadata hydration, settings and composer remain unchanged.
 * Record one explicit fixture send without starting a provider or backend turn;
 * refuse any other command that could allocate/change a conversation. */
declare global {
  interface Window {
    fixtureSends: Record<string, unknown>[];
    fixtureNavigate?: (path: string) => void;
  }
}
window.fixtureSends = [];
const store = createMitzoStore({
  transport: { fetch: (url, init) => fetch(url, init) },
  wsConfig: {
    buildUrl: () => '',
    createWebSocket: () => {
      let replyNumber = 0;
      const laterReply = (event: Event) => {
        const finish = event.type === 'fixture-finish-reply';
        const continuation = event.type === 'fixture-continue-reply';
        if (!finish && !continuation) replyNumber++;
        const reply = { sessionId: 'planning', messageId: 'later-reply-' + replyNumber };
        const block = { ...reply, blockId: 'later-text', blockType: 'text' };
        const events = finish
          ? [
              { type: 'block_end', ...block },
              { type: 'message_end', ...reply },
              { type: 'session_state_changed', sessionId: 'planning', state: 'idle' },
            ]
          : continuation
            ? [{ type: 'block_delta', ...block, delta: (event as CustomEvent<string>).detail }]
            : [
                { type: 'session_state_changed', sessionId: 'planning', state: 'running' },
                { type: 'message_start', ...reply },
                { type: 'block_start', ...block },
                { type: 'block_delta', ...block, delta: 'Later reply from the offline transport.' },
              ];
        for (const message of events) socket.onmessage?.({ data: JSON.stringify(message) });
      };
      const socket: WebSocketLike = {
        readyState: 1,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: (raw) => {
          const message = JSON.parse(raw) as Record<string, unknown> & {
            type: string;
            sessionId?: string;
          };
          if (
            message.type === 'send' &&
            message.sessionId === 'planning' &&
            message.prompt === 'Continue the ordinary chat.'
          ) {
            window.fixtureSends.push(message);
            return;
          }
          if (
            !['hello', 'ping', 'unwatch', 'switch_session', 'session_event_applied'].includes(
              message.type,
            )
          )
            throw Error('Unexpected fixture command: ' + message.type);
          if (message.type === 'switch_session')
            queueMicrotask(() =>
              socket.onmessage?.({
                data: JSON.stringify({
                  type: 'mode_changed',
                  mode: 'ask',
                  sessionId: message.sessionId,
                }),
              }),
            );
        },
        close: () => {
          window.removeEventListener('fixture-stream-reply', laterReply);
          window.removeEventListener('fixture-finish-reply', laterReply);
          window.removeEventListener('fixture-continue-reply', laterReply);
        },
      };
      window.addEventListener('fixture-stream-reply', laterReply);
      window.addEventListener('fixture-finish-reply', laterReply);
      window.addEventListener('fixture-continue-reply', laterReply);
      queueMicrotask(() => {
        socket.onopen?.({});
        socket.onmessage?.({
          data: JSON.stringify({ type: 'welcome', connectionId: 'offline-telos-source' }),
        });
      });
      return socket;
    },
  },
});

function ItemRoute() {
  const desktop = useIsDesktop();
  return desktop ? <DesktopShell center={<TodoDetailView />} /> : <TodoDetailView />;
}

/** Test-only route control uses the real router without reloading/remounting the
 * ordinary view, so motion and draft transitions are exercised as in-app changes. */
function FixtureNavigation() {
  const navigate = useNavigate();
  useEffect(() => {
    window.fixtureNavigate = navigate;
    return () => {
      delete window.fixtureNavigate;
    };
  }, [navigate]);
  return null;
}

createRoot(document.getElementById('root')!).render(
  <MitzoStoreProvider value={store}>
    <BrowserRouter>
      <FixtureNavigation />
      <MobileShell>
        <Routes>
          <Route path="/chat" element={<ResponsiveChatView />} />
          <Route path="/chat/:sessionId" element={<ResponsiveChatView />} />
          <Route path="/todos/:id" element={<ItemRoute />} />
        </Routes>
      </MobileShell>
    </BrowserRouter>
  </MitzoStoreProvider>,
);
