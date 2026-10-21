// Actual selected chat route/providers, production store/auth and styles.
// No preview store, synthetic membership, network mocks or test controls.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { clientStore } from '../../frontend/src/client-store';
import { startAuthentication } from '../../frontend/src/lib/startup-auth';
import { initTheme } from '../../frontend/src/hooks/useTheme';
import { ErrorBoundary } from '../../frontend/src/components/ErrorBoundary';
import { NotificationProvider } from '../../frontend/src/components/NotificationProvider';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import { ProtectedRoute } from '../../frontend/src/components/ProtectedRoute';
import { ResponsiveChatView } from '../../frontend/src/components/ResponsiveChatView';
import 'highlight.js/styles/github-dark-dimmed.min.css';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/code-block.css';
import '../../frontend/src/styles/calendar.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/home.css';
import '../../frontend/src/styles/connections-setup.css';
import '../../frontend/src/styles/connection-setup-card.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/workspace-work.css';
import '../../frontend/src/styles/workspace-agents.css';
import '../../frontend/src/styles/workspace-collections.css';
import '../../frontend/src/pages/KnowledgeLibrary.css';
import '../../frontend/src/styles/mobile-workspace.css';
import '../../frontend/src/styles/appearance.css';
import '../../frontend/src/pages/TerminalView.css';
import '../../frontend/src/styles/motion.css';

initTheme();
void startAuthentication(location.pathname);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MitzoStoreProvider value={clientStore}>
      <ErrorBoundary>
        <BrowserRouter>
          <NotificationProvider>
            <MobileShell>
              <Routes>
                <Route
                  path="/chat/:sessionId"
                  element={
                    <ProtectedRoute>
                      <ResponsiveChatView />
                    </ProtectedRoute>
                  }
                />
              </Routes>
            </MobileShell>
          </NotificationProvider>
        </BrowserRouter>
      </ErrorBoundary>
    </MitzoStoreProvider>
  </StrictMode>,
);
