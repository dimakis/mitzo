import { UiIcon } from './UiIcon';
import { Link, useLocation } from 'react-router-dom';

const primary = [
  { label: 'Today', icon: 'today' as const, path: '/', end: true },
  { label: 'Chats', icon: 'chats' as const, path: '/sessions', end: false },
  { label: 'Proposals', icon: 'proposals' as const, path: '/inbox', end: false },
  { label: 'Work', icon: 'work' as const, path: '/todos', end: false },
];
const secondary = [
  { label: 'Agents', icon: 'agents' as const, path: '/tasks', end: false },
  { label: 'Calendar', icon: 'calendar' as const, path: '/calendar', end: false },
  { label: 'Files', icon: 'files' as const, path: '/files', end: false },
];
export function WorkspaceNav({ desktop = false }: { desktop?: boolean }) {
  const { pathname } = useLocation();
  const items = [
    ...primary,
    ...(desktop ? secondary : []),
    { label: 'More', icon: 'more' as const, path: '/more', end: false },
  ];
  return (
    <nav
      className={desktop ? 'workspace-nav' : 'tab-bar workspace-tabs'}
      aria-label="Main navigation"
    >
      {items.map(({ label, path, end, icon }) => {
        const active =
          (end ? pathname === path : pathname === path || pathname.startsWith(path + '/')) ||
          (label === 'Chats' && (pathname === '/chat' || pathname.startsWith('/chat/'))) ||
          (!desktop &&
            label === 'More' &&
            ['/tasks', '/calendar', '/files', '/focus'].some(
              (p) => pathname === p || pathname.startsWith(p + '/'),
            ));
        return (
          <Link
            key={path}
            to={path}
            aria-label={label}
            title={desktop ? label : undefined}
            aria-current={active ? 'page' : undefined}
            className={`workspace-nav-link${active ? ' workspace-nav-link--active' : ''}`}
          >
            {desktop && <UiIcon name={icon} />}
            <span className="workspace-nav-label">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
