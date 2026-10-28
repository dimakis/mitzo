import { chatStorage } from '../../frontend/src/lib/large-chat-storage';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { createMitzoStore, type WebSocketLike } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { AgentLibrary } from '../../frontend/src/pages/AgentLibrary';
import { DraftsView } from '../../frontend/src/pages/DraftsView';
import { ResponsiveChatView } from '../../frontend/src/components/ResponsiveChatView';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
import { agentBuilderCommandHandoff } from '../../frontend/src/lib/agent-builder-chat';
import { createReviewedOutboxStorage } from '../../frontend/src/lib/reviewed-outbox-storage';
import { builderOfflineTransport } from '../support/builder-offline-transport';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/home.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/mobile-workspace.css';
import '../../frontend/src/styles/appearance.css';
import '../../frontend/src/styles/motion.css';

// Only the transport is inert. Routes, Library, responsive ordinary chat,
// settings, draft persistence and shared source context owners are production.
const store = createMitzoStore({
  sendHandoff: agentBuilderCommandHandoff,
  transport: { fetch: (url, init) => fetch(url, init) },
  localFirstCommandConfig: {
    url: '/api/chat/local-codex/send',
    storage: createReviewedOutboxStorage(
      chatStorage,
      new URL('/api/chat/local-codex/send', location.href).href,
      'local',
    ),
  },
  reviewedSendConfig: {
    url: '/api/chat/send',
    storage: createReviewedOutboxStorage(
      chatStorage,
      new URL('/api/chat/send', location.href).href,
    ),
  },
  sseConfig: {
    baseUrl: '',
    fetch: builderOfflineTransport(
      location.origin,
      (url, init) => fetch(url, init),
      (message) =>
        window.dispatchEvent(new CustomEvent('fixture-builder-message', { detail: message })),
    ),
    outboxStorage: sessionStorage,
    createEventSource: () => {
      class OfflineSource extends EventTarget {
        readyState = 1;
        onmessage: ((event: MessageEvent) => void) | null = null;
        private deliver = (event: Event) =>
          this.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify((event as CustomEvent).detail),
            }),
          );
        constructor() {
          super();
          window.addEventListener('fixture-builder-message', this.deliver);
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent('welcome', {
                data: JSON.stringify({ connectionId: 'offline-builder' }),
              }),
            ),
          );
        }
        close() {
          this.readyState = 2;
          window.removeEventListener('fixture-builder-message', this.deliver);
        }
      }
      return new OfflineSource() as unknown as EventSource;
    },
  },
  wsConfig: {
    buildUrl: () => '',
    createWebSocket: () => {
      const socket: WebSocketLike = {
        readyState: 1,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: (raw) => {
          const message = JSON.parse(raw) as { type: string };
          if (
            !['hello', 'ping', 'unwatch', 'switch_session', 'session_event_applied'].includes(
              message.type,
            )
          )
            throw Error('Setup dispatched an unexpected command: ' + message.type);
        },
        close: () => {},
      };
      queueMicrotask(() => {
        socket.onopen?.({});
        socket.onmessage?.({
          data: JSON.stringify({ type: 'welcome', connectionId: 'offline-builder' }),
        });
      });
      return socket;
    },
  },
});

function LibraryRoute() {
  return useIsDesktop() ? <DesktopShell center={<AgentLibrary />} /> : <AgentLibrary />;
}
function DraftsRoute() {
  return useIsDesktop() ? <DesktopShell center={<DraftsView />} /> : <DraftsView />;
}

createRoot(document.getElementById('root')!).render(
  <MitzoStoreProvider value={store}>
    <BrowserRouter>
      <MobileShell>
        <Routes>
          <Route path="/agent-library" element={<LibraryRoute />} />
          <Route path="/sessions/drafts" element={<DraftsRoute />} />
          <Route path="/chat" element={<ResponsiveChatView />} />
          <Route path="/chat/:sessionId" element={<ResponsiveChatView />} />
        </Routes>
      </MobileShell>
    </BrowserRouter>
  </MitzoStoreProvider>,
);
