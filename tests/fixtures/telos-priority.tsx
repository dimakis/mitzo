import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { createMitzoStore } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { TodoWorkspace } from '../../frontend/src/pages/TodoWorkspace';
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
createRoot(document.getElementById('root')!).render(
  <MitzoStoreProvider value={store}>
    <BrowserRouter>
      <Routes>
        <Route path="/todos" element={<TodoWorkspace />} />
        <Route path="/todos/:id" element={<TodoWorkspace />} />
      </Routes>
    </BrowserRouter>
  </MitzoStoreProvider>,
);
