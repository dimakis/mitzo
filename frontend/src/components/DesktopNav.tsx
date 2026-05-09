import { useLocation, useNavigate } from 'react-router-dom';

interface NavItem {
  label: string;
  path: string;
  match: (pathname: string) => boolean;
}

export function DesktopNav() {
  const location = useLocation();
  const navigate = useNavigate();

  // Nav only lists full-page routes; sidebar widgets (Inbox, Telos, Tasks) are in CommandCenter.
  const items: NavItem[] = [
    {
      label: 'Chat',
      path: '/',
      match: (p) => p === '/' || p === '/chat' || p.startsWith('/chat/'),
    },
    { label: 'Calendar', path: '/calendar', match: (p) => p.startsWith('/calendar') },
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
        </button>
      ))}
    </nav>
  );
}
