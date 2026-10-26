import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
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

/** Only the transport is synthetic. Pending review/selection/approval runs in the
 * actual temporary host owners behind intercepted fixture routes. No store action,
 * ordinary screen, permission card or source review component is replaced. */
const store = createMitzoStore({
  transport: { fetch: (url, init) => fetch(url, init) },
  wsConfig: {
    buildUrl: () => '',
    createWebSocket: () => {
      const deliver = (events: Record<string, unknown>[]) => {
        for (const event of events) socket.onmessage?.({ data: JSON.stringify(event) });
      };
      const host = async (operation: string, input: unknown) => {
        const response = await fetch('/fixture/approval/' + operation, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!response.ok) throw Error('Offline approval transport failed');
        const result = (await response.json()) as { events: Record<string, unknown>[] };
        deliver(result.events);
      };
      const request = (event: Event) => {
        void host('request', (event as CustomEvent<unknown>).detail);
      };
      const incoming = (event: Event) => {
        deliver((event as CustomEvent<Record<string, unknown>[]>).detail);
      };
      const socket: WebSocketLike = {
        readyState: 1,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: (raw) => {
          const message = JSON.parse(raw) as {
            type: string;
            sessionId?: string;
            decision?: string;
          };
          if (message.type === 'permission_response') {
            if (message.decision !== 'deny') throw Error('Source approval used generic allow');
            void host('respond', message);
          } else if (message.type === 'switch_session') {
            queueMicrotask(() =>
              deliver([{ type: 'mode_changed', mode: 'ask', sessionId: message.sessionId }]),
            );
            void host('reconnect', { sessionId: message.sessionId });
          } else if (
            !['hello', 'ping', 'unwatch', 'session_event_applied'].includes(message.type)
          ) {
            throw Error('Unexpected offline command: ' + message.type);
          }
        },
        close: () => {
          window.removeEventListener('fixture-request-source', request);
          window.removeEventListener('fixture-host-events', incoming);
        },
      };
      window.addEventListener('fixture-request-source', request);
      window.addEventListener('fixture-host-events', incoming);
      queueMicrotask(() => {
        socket.onopen?.({});
        deliver([{ type: 'welcome', connectionId: 'offline-source-approval' }]);
        void host('reconnect', { sessionId: 'planning' });
      });
      return socket;
    },
  },
});

function ItemRoute() {
  return useIsDesktop() ? <DesktopShell center={<TodoDetailView />} /> : <TodoDetailView />;
}

createRoot(document.getElementById('root')!).render(
  <MitzoStoreProvider value={store}>
    <BrowserRouter>
      <MobileShell>
        <Routes>
          <Route path="/chat/:sessionId" element={<ResponsiveChatView />} />
          <Route path="/todos/:id" element={<ItemRoute />} />
        </Routes>
      </MobileShell>
    </BrowserRouter>
  </MitzoStoreProvider>,
);
