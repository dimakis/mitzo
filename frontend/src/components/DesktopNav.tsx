import { useLocation, useNavigate } from 'react-router-dom';
import { useTabBadges } from '../hooks/useTabBadges';

interface NavItem {
  label: string;
  path: string;
  match: (pathname: string) => boolean;
  badge?: number;
}

export function DesktopNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const { inboxCount, todoCount } = useTabBadges();

  const items: NavItem[] = [
    {
      label: 'Chat',
      path: '/',
      match: (p) => p === '/' || p === '/chat' || p.startsWith('/chat/'),
    },
    { label: 'Calendar', path: '/calendar', match: (p) => p.startsWith('/calendar') },
    { label: 'Inbox', path: '/inbox', match: (p) => p === '/inbox', badge: inboxCount },
    {
      label: 'Telos',
      path: '/todos',
      match: (p) => p === '/todos' || p.startsWith('/todos/'),
      badge: todoCount,
    },
    { label: 'Tasks', path: '/tasks', match: (p) => p.startsWith('/tasks') },
    { label: 'Files', path: '/files', match: (p) => p.startsWith('/files') },
  ];

  return (
    <nav className="desktop-nav">
      {items.map((item) => (
        <button
          key={item.label}
          className={`desktop-nav-item${item.match(location.pathname) ? ' desktop-nav-item--active' : ''}`}
          onClick={() => navigate(item.path)}
        >
          <span>{item.label}</span>
          {item.badge ? <span className="desktop-nav-badge">{item.badge}</span> : null}
        </button>
      ))}
    </nav>
  );
}
