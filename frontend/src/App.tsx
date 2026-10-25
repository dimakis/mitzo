import { Suspense, type ReactNode } from 'react';
import {
  SandboxesView,
  TerminalView,
  SettingsView,
  DraftsView,
  UpdatesView,
  BackupsView,
  NotificationsView,
  SymposiumSavedReviewRecordPage,
  Login,
  Today,
  QuoteView,
  BriefingView,
  MockupsView,
  MoreView,
  ConnectionSetupView,
  ConnectionsRoute,
  ConnectionsAccessView,
  SessionList,
  ResponsiveChatView,
  KnowledgeLibrary,
  AgentLibrary,
  FileViewer,
  UnifiedInboxView,
  InboxRedirect,
  CalendarView,
  TodoWorkspace,
  TaskBoard,
} from './route-pages';
import { NotificationProvider } from './components/NotificationProvider';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AttentionFeed } from './components/AttentionFeed';
import { WorkspacePageHeading } from './components/WorkspacePageHeading';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MobileShell } from './components/MobileShell';
import { DesktopShell } from './components/DesktopShell';
import { useIsDesktop } from './hooks/useMediaQuery';

function HomeRoute() {
  return (
    <PageRoute>
      <Today />
    </PageRoute>
  );
}

function ChatRoute() {
  return <ResponsiveChatView />;
}

function CollectionRoute({ page }: { page: 'proposals' | 'calendar' }) {
  const isDesktop = useIsDesktop();
  return page === 'proposals' ? (
    <UnifiedInboxView desktop={isDesktop} />
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
      'button, a, select, summary, [role="button"], .chat-input, .slash-picker, .context-picker, .terminal-console',
    )
  )
    return;
  (document.activeElement as HTMLElement)?.blur?.();
}

function SuspenseRoutes({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="auth-status" role="status">
          Opening Mitzo…
        </div>
      }
    >
      <Routes>{children}</Routes>
    </Suspense>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <div onClickCapture={dismissKeyboard}>
        <BrowserRouter>
          <NotificationProvider>
            <MobileShell>
              <SuspenseRoutes>
                <Route
                  path="/sessions/drafts"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <DraftsView />
                      </PageRoute>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/settings/updates"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <UpdatesView />
                      </PageRoute>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/settings/backups"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <BackupsView />
                      </PageRoute>
                    </ProtectedRoute>
                  }
                />
                <Route path="/backups" element={<Navigate to="/settings/backups" replace />} />
                <Route
                  path="/settings"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <SettingsView />
                      </PageRoute>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/terminal"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <TerminalView />
                      </PageRoute>
                    </ProtectedRoute>
                  }
                />
                <Route path="/login" element={<Login />} />
                <Route
                  path="/briefings/:date"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <BriefingView />
                      </PageRoute>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/quotes/:date"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <QuoteView />
                      </PageRoute>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/sessions/:sessionId/review-records/:recordId"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <SymposiumSavedReviewRecordPage />
                      </PageRoute>
                    </ProtectedRoute>
                  }
                />
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
                  path="/sandboxes"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <SandboxesView />
                      </PageRoute>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/mockups"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <MockupsView />
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
                  path="/connections-access"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <ConnectionsAccessView />
                      </PageRoute>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/notifications"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <InboxRedirect />
                      </PageRoute>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/connections/setup/:setupId"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <ConnectionSetupView />
                      </PageRoute>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/connections/secrets/:setupId"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <ConnectionSetupView secretRelay />
                      </PageRoute>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/connections"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <ConnectionsRoute />
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
                          <WorkspacePageHeading
                            title="Attention"
                            description="The items that need a decision or a closer look."
                          />
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
                  path="/settings/notifications"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <NotificationsView preferencesOnly />
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
                  path="/knowledge"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <KnowledgeLibrary />
                      </PageRoute>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/agent-library"
                  element={
                    <ProtectedRoute>
                      <PageRoute>
                        <AgentLibrary />
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
              </SuspenseRoutes>
            </MobileShell>
          </NotificationProvider>
        </BrowserRouter>
      </div>
    </ErrorBoundary>
  );
}
