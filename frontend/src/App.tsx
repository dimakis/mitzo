import { SandboxesView } from './pages/SandboxesView';
import { TerminalView } from './pages/TerminalView';
import { SettingsView } from './pages/SettingsView';
import { DraftsView } from './pages/DraftsView';
import { UpdatesView } from './pages/UpdatesView';
import { BackupsView } from './pages/BackupsView';
import { NotificationProvider } from './components/NotificationProvider';
import { NotificationsView } from './pages/NotificationsView';
import { SymposiumSavedReviewRecordPage } from './components/SymposiumSavedReviewRecordPage';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Login } from './pages/Login';
import { Today } from './pages/Today';
import { QuoteView } from './pages/QuoteView';
import { BriefingView } from './pages/BriefingView';
import { MockupsView } from './pages/MockupsView';
import { MoreView } from './pages/MoreView';
import { ConnectionSetupView } from './pages/ConnectionSetupView';
import { ConnectionsRoute } from './pages/ConnectionsRoute';
import { ConnectionsAccessView } from './pages/ConnectionsAccessView';
import { AttentionFeed } from './components/AttentionFeed';
import { WorkspacePageHeading } from './components/WorkspacePageHeading';
import { SessionList } from './pages/SessionList';
import { ResponsiveChatView } from './components/ResponsiveChatView';
import { KnowledgeLibrary } from './pages/KnowledgeLibrary';
import { AgentLibrary } from './pages/AgentLibrary';
import { FileViewer } from './pages/FileViewer';
import { UnifiedInboxView, InboxRedirect } from './pages/UnifiedInboxView';
import { CalendarView } from './pages/CalendarView';
import { TodoWorkspace } from './pages/TodoWorkspace';
import { TaskBoard } from './pages/TaskBoard';
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
      'button, a, select, [role="button"], .chat-input, .slash-picker, .context-picker, .terminal-console',
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
          <NotificationProvider>
            <MobileShell>
              <Routes>
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
              </Routes>
            </MobileShell>
          </NotificationProvider>
        </BrowserRouter>
      </div>
    </ErrorBoundary>
  );
}
