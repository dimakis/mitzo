import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { createMitzoStore } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
import { TodoWorkspace } from '../../frontend/src/pages/TodoWorkspace';
import { telosRecordBatchFixture } from '../../frontend/src/test-utils/telos-record-batch';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/home.css';
import '../../frontend/src/styles/workspace-work.css';
import '../../frontend/src/styles/mobile-workspace.css';
import '../../frontend/src/styles/motion.css';

// Real current Telos pages and data owner; all HTTP is intercepted by the test.
// This fixture exercises no chat allocation, backend, account or model.
// The protected design test supplies individual records. Adapt its fake server
// to the batch response contract while exercising the real client and data owner.
const fixtureFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) =>
  input === '/api/telos/work/records' && init?.method === 'POST'
    ? telosRecordBatchFixture(init, (id) =>
        fixtureFetch('/api/telos/work/items/' + encodeURIComponent(id) + '/record', {
          signal: init.signal,
        }),
      )
    : fixtureFetch(input, init);
const store = createMitzoStore({
  transport: { fetch: (url, init) => fetch(url, init) },
  wsConfig: {
    buildUrl: () => '',
    createWebSocket: () => ({
      readyState: 1,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: () => {
        throw new Error('No runtime command belongs in this priority fixture');
      },
      close: () => {},
    }),
  },
});
// Mirrors App.tsx PageRoute with the actual shell components and breakpoint.
function PriorityPageRoute() {
  return useIsDesktop() ? <DesktopShell center={<TodoWorkspace />} /> : <TodoWorkspace />;
}
createRoot(document.getElementById('root')!).render(
  <MitzoStoreProvider value={store}>
    <BrowserRouter>
      <MobileShell>
        <Routes>
          <Route path="/todos" element={<PriorityPageRoute />} />
          <Route path="/todos/:id" element={<PriorityPageRoute />} />
        </Routes>
      </MobileShell>
    </BrowserRouter>
  </MitzoStoreProvider>,
);
