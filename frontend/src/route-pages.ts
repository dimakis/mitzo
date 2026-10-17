import { lazyRoute as lazy } from './lib/lazy-route';

const loadSandboxesView = () =>
  import('./pages/SandboxesView').then((module) => ({ default: module.SandboxesView }));
export const SandboxesView = lazy(loadSandboxesView);
const loadTerminalView = () =>
  import('./pages/TerminalView').then((module) => ({ default: module.TerminalView }));
export const TerminalView = lazy(loadTerminalView);
const loadSettingsView = () =>
  import('./pages/SettingsView').then((module) => ({ default: module.SettingsView }));
export const SettingsView = lazy(loadSettingsView);
const loadDraftsView = () =>
  import('./pages/DraftsView').then((module) => ({ default: module.DraftsView }));
export const DraftsView = lazy(loadDraftsView);
const loadUpdatesView = () =>
  import('./pages/UpdatesView').then((module) => ({ default: module.UpdatesView }));
export const UpdatesView = lazy(loadUpdatesView);
const loadBackupsView = () =>
  import('./pages/BackupsView').then((module) => ({ default: module.BackupsView }));
export const BackupsView = lazy(loadBackupsView);
const loadNotificationsView = () =>
  import('./pages/NotificationsView').then((module) => ({ default: module.NotificationsView }));
export const NotificationsView = lazy(loadNotificationsView);
const loadSymposiumSavedReviewRecordPage = () =>
  import('./components/SymposiumSavedReviewRecordPage').then((module) => ({
    default: module.SymposiumSavedReviewRecordPage,
  }));
export const SymposiumSavedReviewRecordPage = lazy(loadSymposiumSavedReviewRecordPage);
const loadLogin = () => import('./pages/Login').then((module) => ({ default: module.Login }));
export const Login = lazy(loadLogin);
const loadToday = () => import('./pages/Today').then((module) => ({ default: module.Today }));
export const Today = lazy(loadToday);
const loadQuoteView = () =>
  import('./pages/QuoteView').then((module) => ({ default: module.QuoteView }));
export const QuoteView = lazy(loadQuoteView);
const loadBriefingView = () =>
  import('./pages/BriefingView').then((module) => ({ default: module.BriefingView }));
export const BriefingView = lazy(loadBriefingView);
const loadMockupsView = () =>
  import('./pages/MockupsView').then((module) => ({ default: module.MockupsView }));
export const MockupsView = lazy(loadMockupsView);
const loadMoreView = () =>
  import('./pages/MoreView').then((module) => ({ default: module.MoreView }));
export const MoreView = lazy(loadMoreView);
const loadConnectionSetupView = () =>
  import('./pages/ConnectionSetupView').then((module) => ({ default: module.ConnectionSetupView }));
export const ConnectionSetupView = lazy(loadConnectionSetupView);
const loadConnectionsRoute = () =>
  import('./pages/ConnectionsRoute').then((module) => ({ default: module.ConnectionsRoute }));
export const ConnectionsRoute = lazy(loadConnectionsRoute);
const loadConnectionsAccessView = () =>
  import('./pages/ConnectionsAccessView').then((module) => ({
    default: module.ConnectionsAccessView,
  }));
export const ConnectionsAccessView = lazy(loadConnectionsAccessView);
const loadSessionList = () =>
  import('./pages/SessionList').then((module) => ({ default: module.SessionList }));
export const SessionList = lazy(loadSessionList);
const loadResponsiveChatView = () =>
  import('./components/ResponsiveChatView').then((module) => ({
    default: module.ResponsiveChatView,
  }));
export const ResponsiveChatView = lazy(loadResponsiveChatView);
const loadKnowledgeLibrary = () =>
  import('./pages/KnowledgeLibrary').then((module) => ({ default: module.KnowledgeLibrary }));
export const KnowledgeLibrary = lazy(loadKnowledgeLibrary);
const loadAgentLibrary = () =>
  import('./pages/AgentLibrary').then((module) => ({ default: module.AgentLibrary }));
export const AgentLibrary = lazy(loadAgentLibrary);
const loadFileViewer = () =>
  import('./pages/FileViewer').then((module) => ({ default: module.FileViewer }));
export const FileViewer = lazy(loadFileViewer);
const loadUnifiedInboxView = () =>
  import('./pages/UnifiedInboxView').then((module) => ({ default: module.UnifiedInboxView }));
export const UnifiedInboxView = lazy(loadUnifiedInboxView);
const loadInboxRedirect = () =>
  import('./pages/UnifiedInboxView').then((module) => ({ default: module.InboxRedirect }));
export const InboxRedirect = lazy(loadInboxRedirect);
const loadCalendarView = () =>
  import('./pages/CalendarView').then((module) => ({ default: module.CalendarView }));
export const CalendarView = lazy(loadCalendarView);
const loadTodoWorkspace = () =>
  import('./pages/TodoWorkspace').then((module) => ({ default: module.TodoWorkspace }));
export const TodoWorkspace = lazy(loadTodoWorkspace);
const loadTaskBoard = () =>
  import('./pages/TaskBoard').then((module) => ({ default: module.TaskBoard }));
export const TaskBoard = lazy(loadTaskBoard);

/** Begin the likely landing chunk in parallel with authentication, never mount it early. */
export function preloadLandingPage(path: string) {
  const load =
    path === '/'
      ? loadToday
      : path === '/login'
        ? loadLogin
        : path.startsWith('/chat')
          ? loadResponsiveChatView
          : path === '/sessions'
            ? loadSessionList
            : null;
  if (load)
    void load().catch(() => {
      /* React's route error boundary owns failures. */
    });
}
