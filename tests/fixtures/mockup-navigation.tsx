import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { MoreView } from '../../frontend/src/pages/MoreView';
import { MockupsView } from '../../frontend/src/pages/MockupsView';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
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
      <Route path="/mockups" element={<MockupsView />} />
      <Route path="*" element={<MoreView />} />
    </Routes>
  );
  return <MobileShell>{desktop ? <DesktopShell center={pages} /> : pages}</MobileShell>;
}
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Fixture />
  </BrowserRouter>,
);
