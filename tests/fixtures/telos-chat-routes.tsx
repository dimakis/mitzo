import { ResponsiveChatView } from '../../frontend/src/components/ResponsiveChatView';
import type { ReactNode } from 'react';
import { FileViewer } from '../../frontend/src/pages/FileViewer';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { createMitzoStore, type WebSocketLike } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { TodoWorkspace } from '../../frontend/src/pages/TodoWorkspace';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import { eventBus } from '../../frontend/src/lib/event-bus-singleton';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-work.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/session-library.css';
import '../../frontend/src/styles/mobile-workspace.css';
import '../../frontend/src/styles/motion.css';
declare global {
  interface Window {
    fixtureTodoEvents: EventTarget;
    fixtureConnection: (connected: boolean) => void;
  }
}
class FixtureEvents extends EventTarget {
  readyState = 1;
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor() {
    super();
    window.fixtureTodoEvents = this;
    window.fixtureConnection = (connected) => {
      this.readyState = connected ? 1 : 0;
      if (connected) this.onopen?.({});
      else this.onerror?.({});
    };
    queueMicrotask(() => this.onopen?.({}));
  }
  close() {
    this.readyState = 2;
  }
}
window.EventSource = FixtureEvents as unknown as typeof EventSource;
eventBus.connect('/api/events');
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
        close: () => {},
        send: (raw) => {
          const { type } = JSON.parse(raw);
          if (!['hello', 'ping', 'unwatch', 'switch_session'].includes(type))
            throw Error('Unexpected fixture command ' + type);
        },
      };
      queueMicrotask(() => {
        socket.onopen?.({});
        socket.onmessage?.({
          data: JSON.stringify({ type: 'welcome', connectionId: 'fixture-s7' }),
        });
      });
      return socket;
    },
  },
});
function Page({ children = <TodoWorkspace /> }: { children?: ReactNode }) {
  const desktop = useIsDesktop();
  return desktop ? <DesktopShell center={children} /> : children;
}
createRoot(document.getElementById('root')!).render(
  <MitzoStoreProvider value={store}>
    <BrowserRouter>
      <MobileShell>
        <Routes>
          <Route path="/todos/:id?" element={<Page />} />
          <Route path="/chat/:sessionId?" element={<ResponsiveChatView />} />
          <Route
            path="/files"
            element={
              <Page>
                <FileViewer />
              </Page>
            }
          />
        </Routes>
      </MobileShell>
    </BrowserRouter>
  </MitzoStoreProvider>,
);
