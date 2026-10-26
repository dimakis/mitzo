import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { SessionList } from '../../frontend/src/pages/SessionList';
import { eventBus } from '../../frontend/src/lib/event-bus-singleton';
import { SessionPanel } from '../../frontend/src/components/SessionPanel';
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
        <Route
          path="/chat/:id"
          element={<button onClick={() => navigate('/sessions')}>Opened conversation</button>}
        />
      </Routes>
    </MobileShell>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[location.pathname]}>
    <Surface />
  </MemoryRouter>,
);
