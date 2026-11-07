import { createRoot } from 'react-dom/client';
import { Link, MemoryRouter, Route, Routes, useNavigate, useLocation } from 'react-router-dom';
import { conversationLibraryReturn } from '../../frontend/src/lib/conversation-library-return';
import { SessionList } from '../../frontend/src/pages/SessionList';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
import { createChatDraft, saveChatDraft } from '../../frontend/src/lib/chat-drafts';
import { initializeChatStorage, chatStorage } from '../../frontend/src/lib/large-chat-storage';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/mobile-workspace.css';
import '../../frontend/src/styles/appearance.css';

function Surface() {
  const desktop = useIsDesktop();
  const navigate = useNavigate();
  const back = conversationLibraryReturn(useLocation().state);
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
            <>
              <Link to={back.path} state={back.state} aria-label="Back to chats">
                Back to chats
              </Link>
              <button type="button" onClick={() => navigate(-1)}>
                Back to search
              </button>
            </>
          }
        />
      </Routes>
    </MobileShell>
  );
}
async function mount() {
  // Match the production boot barrier before seeding the IndexedDB-backed draft.
  await initializeChatStorage();
  if (!saveChatDraft({ ...createChatDraft(), text: 'Unsent thought' }))
    throw new Error('Search fixture draft could not be saved');
  await chatStorage.flush();
  createRoot(document.getElementById('root')!).render(
    <MemoryRouter initialEntries={[location.pathname + location.search]}>
      <Surface />
    </MemoryRouter>,
  );
}
void mount();
