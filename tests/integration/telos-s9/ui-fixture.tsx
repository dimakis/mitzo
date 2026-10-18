import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { createMitzoStore, type WebSocketLike } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { TodoWorkspace } from '../../../frontend/src/pages/TodoWorkspace';
import { DesktopShell } from '../../../frontend/src/components/DesktopShell';
import { MobileShell } from '../../../frontend/src/components/MobileShell';
import { useIsDesktop } from '../../../frontend/src/hooks/useMediaQuery';
import { eventBus } from '../../../frontend/src/lib/event-bus-singleton';
import '../../../frontend/src/styles/tokens.css';
import '../../../frontend/src/styles/global.css';
import '../../../frontend/src/styles/desktop.css';
import '../../../frontend/src/styles/workspace.css';
import '../../../frontend/src/styles/workspace-work.css';
import '../../../frontend/src/styles/mobile-workspace.css';
import '../../../frontend/src/styles/motion.css';

// Only the external SSE/socket transports are fake. The actual event bus, hooks,
// typed client, routed pages, components and shared styles run unchanged.
const sources: EventTarget[] = [];
class SyntheticEventSource extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor() {
    super();
    sources.push(this);
    queueMicrotask(() => this.onopen?.(new Event('open')));
  }
  close() {
    this.readyState = 2;
  }
}
window.EventSource = SyntheticEventSource as unknown as typeof EventSource;
eventBus.connect('https://mitzo-ui.test/api/events');
window.addEventListener('s9-canonical-update', () =>
  sources[0].dispatchEvent(
    new MessageEvent('todo_update', { data: JSON.stringify({ type: 'todo_update' }) }),
  ),
);

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
        send: () => {},
      };
      queueMicrotask(() => {
        socket.onopen?.({});
        socket.onmessage?.({
          data: JSON.stringify({ type: 'welcome', connectionId: 's9-offline' }),
        });
      });
      return socket;
    },
  },
});
function Page() {
  return useIsDesktop() ? <DesktopShell center={<TodoWorkspace />} /> : <TodoWorkspace />;
}
createRoot(document.getElementById('root')!).render(
  <MitzoStoreProvider value={store}>
    <BrowserRouter>
      <MobileShell>
        <Routes>
          <Route path="/todos/:id?" element={<Page />} />
        </Routes>
      </MobileShell>
    </BrowserRouter>
  </MitzoStoreProvider>,
);
