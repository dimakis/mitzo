import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { clientStore } from '../../frontend/src/client-store';
import { ResponsiveChatView } from '../../frontend/src/components/ResponsiveChatView';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import {
  createChatDraft,
  saveChatDraft,
  bindChatDraftToSession,
} from '../../frontend/src/lib/chat-drafts';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/workspace-work.css';
import '../../frontend/src/styles/mobile-workspace.css';
import '../../frontend/src/styles/session-library.css';
import '../../frontend/src/styles/motion.css';

// Real browser bootstrap, durable storage adapter, store, responsive screens,
// settings and composer. Only HTTP/SSE and the already-bound role are synthetic.
if (!localStorage.getItem('fixture-ordinary-chat-seeded')) {
  const draft = createChatDraft();
  draft.id = 'ordinary-origin-draft';
  draft.text = 'Write the recording plan.';
  saveChatDraft(draft);
  if (bindChatDraftToSession(draft.id, 'ordinary-bound') !== 'bound')
    throw Error('Fixture draft binding failed');
  localStorage.setItem('fixture-ordinary-chat-seeded', '1');
}
clientStore.getState().restoreAuthentication();
function Navigation() {
  const navigate = useNavigate();
  useEffect(() => {
    const change = (event: Event) => navigate((event as CustomEvent<string>).detail);
    window.addEventListener('fixture-navigate', change);
    return () => window.removeEventListener('fixture-navigate', change);
  }, [navigate]);
  return null;
}
createRoot(document.getElementById('root')!).render(
  <MitzoStoreProvider value={clientStore}>
    <BrowserRouter>
      <Navigation />
      <MobileShell>
        <Routes>
          <Route path="/chat" element={<ResponsiveChatView />} />
          <Route path="/chat/:sessionId" element={<ResponsiveChatView />} />
        </Routes>
      </MobileShell>
    </BrowserRouter>
  </MitzoStoreProvider>,
);
