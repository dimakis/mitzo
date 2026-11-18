import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { MemoryRouter, Routes, Route, useNavigate, useParams } from 'react-router-dom';
import { SessionList } from '../../frontend/src/pages/SessionList';
import { eventBus } from '../../frontend/src/lib/event-bus-singleton';
import { SessionPanel } from '../../frontend/src/components/SessionPanel';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { ComposerStatusProvider } from '../../frontend/src/components/ComposerStatus';
import { Today } from '../../frontend/src/pages/Today';
import { SettingsView } from '../../frontend/src/pages/SettingsView';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/mobile-workspace.css';
import '../../frontend/src/styles/appearance.css';
import '../../frontend/src/styles/session-library.css';
eventBus.connect('/api/events');
function OpenedConversation() {
  const navigate = useNavigate();
  const { id } = useParams();
  return (
    <button data-session-id={id} onClick={() => navigate('/sessions')}>
      Opened conversation
    </button>
  );
}
function ActivityComposer() {
  const [sessionId, setSessionId] = useState('session-0');
  useEffect(() => {
    const select = (event: Event) => setSessionId((event as CustomEvent<string>).detail);
    window.addEventListener('offline-activity-conversation', select);
    return () => window.removeEventListener('offline-activity-conversation', select);
  }, []);
  return (
    <ComposerStatusProvider>
      <main className="workspace-page">
        <ChatInput sessionId={sessionId} running onSend={() => false} onStop={() => {}} />
      </main>
    </ComposerStatusProvider>
  );
}
function Surface() {
  const desktop = useIsDesktop();
  return (
    <MobileShell>
      <Routes>
        <Route path="/activity-composer" element={<ActivityComposer />} />
        <Route
          path="/sessions"
          element={desktop ? <DesktopShell center={<SessionList />} /> : <SessionList />}
        />
        <Route
          path="/panel"
          element={
            <DesktopShell
              center={<p>Retained conversation</p>}
              left={
                <SessionPanel
                  activeSessionId="session-0"
                  onSelectSession={() => {}}
                  onNewChat={() => {}}
                />
              }
            />
          }
        />
        <Route path="/" element={desktop ? <DesktopShell center={<Today />} /> : <Today />} />
        <Route
          path="/settings"
          element={desktop ? <DesktopShell center={<SettingsView />} /> : <SettingsView />}
        />
        <Route path="/chat/:id" element={<OpenedConversation />} />
      </Routes>
    </MobileShell>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[location.pathname]}>
    <Surface />
  </MemoryRouter>,
);
