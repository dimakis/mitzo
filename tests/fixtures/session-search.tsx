import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { SessionList } from '../../frontend/src/pages/SessionList';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
import { createChatDraft, saveChatDraft } from '../../frontend/src/lib/chat-drafts';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/mobile-workspace.css';
import '../../frontend/src/styles/appearance.css';

saveChatDraft({ ...createChatDraft(), text: 'Unsent thought' });
function Surface() {
  const desktop = useIsDesktop();
  const navigate = useNavigate();
  return (
    <MobileShell>
      <Routes>
        <Route
          path="/sessions"
          element={desktop ? <DesktopShell center={<SessionList />} /> : <SessionList />}
        />
        <Route
          path="/chat/:id"
          element={
            <button type="button" onClick={() => navigate(-1)}>
              Back to search
            </button>
          }
        />
      </Routes>
    </MobileShell>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[location.pathname + location.search]}>
    <Surface />
  </MemoryRouter>,
);
