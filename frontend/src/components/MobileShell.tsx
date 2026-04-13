import { useLocation } from 'react-router-dom';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { TabBar } from './TabBar';

const HIDE_TAB_BAR = ['/login', '/chat'];

function shouldHideTabBar(pathname: string): boolean {
  return HIDE_TAB_BAR.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export function MobileShell({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const isDesktop = useIsDesktop();
  const showTabBar = !isDesktop && !shouldHideTabBar(location.pathname);

  return (
    <>
      {children}
      {showTabBar && <TabBar />}
    </>
  );
}
