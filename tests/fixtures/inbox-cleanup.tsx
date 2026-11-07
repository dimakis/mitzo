import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { createMitzoStore } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { initTheme } from '../../frontend/src/hooks/useTheme';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { NotificationProvider } from '../../frontend/src/components/NotificationProvider';
import { UnifiedInboxView } from '../../frontend/src/pages/UnifiedInboxView';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/workspace-collections.css';
import '../../frontend/src/styles/mobile-workspace.css';
import '../../frontend/src/styles/notifications.css';
import '../../frontend/src/styles/motion.css';

const store = createMitzoStore({
  transport: { fetch: (url, options) => fetch(url, options) },
  wsConfig: {
    buildUrl: () => '/offline',
    createWebSocket: () => ({
      readyState: 1,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send() {},
      close() {},
    }),
  },
});
function Fixture() {
  const desktop = useIsDesktop();
  const inbox = <UnifiedInboxView desktop={desktop} />;
  return <MobileShell>{desktop ? <DesktopShell center={inbox} /> : inbox}</MobileShell>;
}
initTheme();
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <MitzoStoreProvider store={store}>
      <NotificationProvider>
        <Fixture />
      </NotificationProvider>
    </MitzoStoreProvider>
  </BrowserRouter>,
);
