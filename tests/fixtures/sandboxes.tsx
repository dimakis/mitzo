import { initTheme } from '../../frontend/src/hooks/useTheme';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { MoreView } from '../../frontend/src/pages/MoreView';
import { SandboxesView } from '../../frontend/src/pages/SandboxesView';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
import { useState } from 'react';
import { SessionRemovalDialog } from '../../frontend/src/components/SessionRemovalDialog';
import { apiFetch } from '../../frontend/src/lib/api-fetch';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/mobile-workspace.css';
function Fixture() {
  const desktop = useIsDesktop();
  const pages = (
    <Routes>
      <Route path="/remove" element={<RemovalFixture />} />
      <Route path="/sandboxes" element={<SandboxesView />} />
      <Route path="*" element={<MoreView />} />
    </Routes>
  );
  return <MobileShell>{desktop ? <DesktopShell center={pages} /> : pages}</MobileShell>;
}
function RemovalFixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="home-secondary"
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen(true);
        }}
      >
        Review chat removal
      </button>
      {open && (
        <SessionRemovalDialog
          sessionId="conversation-one"
          onClose={() => setOpen(false)}
          onRemove={async (options) => {
            const response = await apiFetch(
              '/api/sessions/conversation-one' + (options.archive ? '?archive=1' : ''),
              {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cleanupToken: options.cleanupToken }),
              },
            );
            return response.ok;
          }}
        />
      )}
    </>
  );
}
initTheme();
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Fixture />
  </BrowserRouter>,
);
