import { MotionRoutes } from './MotionRoutes';
import { useLocation } from 'react-router-dom';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { TabBar } from './TabBar';
import { MitzoBrand } from './MitzoBrand';
import { UiIcon } from './UiIcon';
import { Link } from 'react-router-dom';

const HIDE_TAB_BAR = ['/login'];
// Collection pages and Telos items share the safe-area masthead.
// Conversations retain their focused navigation and keyboard layout.
const COLLECTION_ROUTES = new Set([
  '/',
  '/sessions',
  '/sessions/drafts',
  '/inbox',
  '/todos',
  '/more',
  '/mockups',
  '/sandboxes',
  '/terminal',
  '/connections-access',
  '/connections',
  '/settings',
  '/settings/updates',
  '/settings/backups',
  '/settings/notifications',
  '/calendar',
  '/notifications',
  '/tasks',
  '/agent-library',
  '/files',
  '/knowledge',
  '/focus',
]);

function shouldHideTabBar(pathname: string): boolean {
  return HIDE_TAB_BAR.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export function MobileShell({ children }: { children: React.ReactNode }) {
  return (
    <MotionRoutes>
      <MobileShellLayout>{children}</MobileShellLayout>
    </MotionRoutes>
  );
}

function MobileShellLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const isDesktop = useIsDesktop();
  const showTabBar = !isDesktop && !shouldHideTabBar(location.pathname);

  const collection =
    COLLECTION_ROUTES.has(location.pathname) ||
    location.pathname.startsWith('/todos/') ||
    location.pathname.startsWith('/briefings/') ||
    location.pathname.startsWith('/quotes/');
  if (!isDesktop && collection) {
    return (
      <div className="mobile-workspace">
        <header className="mobile-workspace-masthead">
          <MitzoBrand />
          {location.pathname !== '/' && (
            <Link to="/sessions" aria-label="Search chats" className="mobile-workspace-search">
              <UiIcon name="search" />
            </Link>
          )}
        </header>
        <div className="mobile-workspace-body">{children}</div>
        <TabBar />
      </div>
    );
  }

  return (
    <>
      {children}
      {showTabBar && <TabBar />}
    </>
  );
}
