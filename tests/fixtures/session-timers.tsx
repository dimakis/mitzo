import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { SessionList } from '../../frontend/src/pages/SessionList';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/mobile-workspace.css';
import '../../frontend/src/styles/appearance.css';

function Chat() {
  return (
    <main className="chat-page workspace-chat">
      <header className="workspace-page-heading">
        <Link to="/sessions">Chats</Link>
        <h1>PR worker</h1>
      </header>
      <section style={{ flex: 1, padding: 'var(--page-gutter)' }}>
        <p>Check PR #7 and keep this session’s existing tools and settings.</p>
      </section>
      <ChatInput
        sessionId="worker"
        initialText="Check PR #7 for new review comments."
        running={false}
        onSend={() => true}
        onStop={() => {}}
      />
    </main>
  );
}
function Surface() {
  const desktop = useIsDesktop();
  return (
    <MobileShell>
      <Routes>
        <Route
          path="/sessions"
          element={desktop ? <DesktopShell center={<SessionList />} /> : <SessionList />}
        />
        <Route path="/chat/:id" element={<Chat />} />
      </Routes>
    </MobileShell>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/sessions']}>
    <Surface />
  </MemoryRouter>,
);
