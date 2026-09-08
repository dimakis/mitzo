import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { apiFetch } from './lib/api-fetch';
import { hideSplash } from './lib/splash';
import { saveTokenToWatch } from './lib/watch-auth';
import { Login } from './pages/Login';
import { Today } from './pages/Today';
import { MoreView } from './pages/MoreView';
import { AttentionFeed } from './components/AttentionFeed';
import { SessionList } from './pages/SessionList';
import { ChatView } from './pages/ChatView';
import { DesktopChatView } from './pages/DesktopChatView';
import { FileViewer } from './pages/FileViewer';
import { InboxView } from './pages/InboxView';
import { CalendarView } from './pages/CalendarView';
import { TodoWorkspace } from './pages/TodoWorkspace';
import { TaskBoard } from './pages/TaskBoard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MobileShell } from './components/MobileShell';
import { DesktopShell } from './components/DesktopShell';
import { useIsDesktop } from './hooks/useMediaQuery';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<'loading' | 'ok' | 'denied'>('loading');
  useEffect(() => {
    apiFetch('/api/auth/check')
      .then((r) => {
        setAuth(r.ok ? 'ok' : 'denied');
        if (r.ok) {
          const token = localStorage.getItem('mitzo_auth_token');
          if (token) saveTokenToWatch(token);
        }
      })
      .catch(() => setAuth('denied'))
      .finally(() => hideSplash());
  }, []);
  if (auth === 'denied') return <Navigate to="/login" replace />;
  if (auth === 'loading') {
    return <div style={{ background: 'var(--bg)', minHeight: '100dvh' }} />;
  }
  return <>{children}</>;
}

function HomeRoute() {
  return (
    <PageRoute>
      <Today />
    </PageRoute>
  );
}

function ChatRoute() {
  const isDesktop = useIsDesktop();
  return isDesktop ? <DesktopChatView /> : <ChatView />;
}

function CollectionRoute({ page }: { page: 'proposals' | 'calendar' }) {
  const isDesktop = useIsDesktop();
  return page === 'proposals' ? (
    <InboxView desktop={isDesktop} />
  ) : (
    <CalendarView desktop={isDesktop} />
  );
}

function TaskBoardRoute() {
  const isDesktop = useIsDesktop();
  return <TaskBoard key={isDesktop ? 'desktop' : 'mobile'} desktop={isDesktop} />;
}

function PageRoute({ children }: { children: React.ReactNode }) {
  const isDesktop = useIsDesktop();
  if (!isDesktop) return <>{children}</>;
  return <DesktopShell center={children} />;
}

function dismissKeyboard(e: React.MouseEvent | React.TouchEvent) {
  const target = e.target as HTMLElement;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
  if (
    target.closest(
      'button, a, select, [role="button"], .chat-input, .slash-picker, .context-picker',
    )
  )
    return;
  (document.activeElement as HTMLElement)?.blur?.();
}

export function App() {
  return (
    <ErrorBoundary>
      <div onClickCapture={dismissKeyboard}>
        <BrowserRouter>
          <MobileShell>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route
                path="/"
                element={
                  <ProtectedRoute>
                    <ErrorBoundary>
                      <HomeRoute />
                    </ErrorBoundary>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/sessions"
                element={
                  <ProtectedRoute>
                    <PageRoute>
                      <SessionList />
                    </PageRoute>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/more"
                element={
                  <ProtectedRoute>
                    <PageRoute>
                      <MoreView />
                    </PageRoute>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/focus"
                element={
                  <ProtectedRoute>
                    <PageRoute>
                      <main className="workspace-page">
                        <h1>Attention</h1>
                        <AttentionFeed />
                      </main>
                    </PageRoute>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/chat"
                element={
                  <ProtectedRoute>
                    <ErrorBoundary>
                      <ChatRoute />
                    </ErrorBoundary>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/chat/:sessionId"
                element={
                  <ProtectedRoute>
                    <ErrorBoundary>
                      <ChatRoute />
                    </ErrorBoundary>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/inbox"
                element={
                  <ProtectedRoute>
                    <PageRoute>
                      <CollectionRoute page="proposals" />
                    </PageRoute>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/calendar"
                element={
                  <ProtectedRoute>
                    <PageRoute>
                      <CollectionRoute page="calendar" />
                    </PageRoute>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/todos/:id?"
                element={
                  <ProtectedRoute>
                    <PageRoute>
                      <TodoWorkspace />
                    </PageRoute>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/tasks"
                element={
                  <ProtectedRoute>
                    <PageRoute>
                      <TaskBoardRoute />
                    </PageRoute>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/files"
                element={
                  <ProtectedRoute>
                    <ErrorBoundary>
                      <PageRoute>
                        <FileViewer />
                      </PageRoute>
                    </ErrorBoundary>
                  </ProtectedRoute>
                }
              />
            </Routes>
          </MobileShell>
        </BrowserRouter>
      </div>
    </ErrorBoundary>
  );
}
