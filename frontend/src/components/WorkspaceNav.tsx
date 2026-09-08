import { Link, useLocation } from 'react-router-dom';

const primary = [
  { label: 'Today', path: '/', end: true },
  { label: 'Chats', path: '/sessions', end: false },
  { label: 'Proposals', path: '/inbox', end: false },
  { label: 'Work', path: '/todos', end: false },
];
const secondary = [
  { label: 'Agents', path: '/tasks', end: false },
  { label: 'Calendar', path: '/calendar', end: false },
  { label: 'Files', path: '/files', end: false },
];
export function WorkspaceNav({ desktop = false }: { desktop?: boolean }) {
  const { pathname } = useLocation();
  const items = [
    ...primary,
    ...(desktop ? secondary : []),
    { label: 'More', path: '/more', end: false },
  ];
  return (
    <nav
      className={desktop ? 'workspace-nav' : 'tab-bar workspace-tabs'}
      aria-label="Main navigation"
    >
      {items.map(({ label, path, end }) => {
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
            aria-current={active ? 'page' : undefined}
            className={`workspace-nav-link${active ? ' workspace-nav-link--active' : ''}`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
