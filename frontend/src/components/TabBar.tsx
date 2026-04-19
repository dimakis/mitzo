import { useLocation, useNavigate } from 'react-router-dom';
import { useTabBadges } from '../hooks/useTabBadges';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { useTheme } from '../hooks/useTheme';
import { useState } from 'react';

interface Tab {
  label: string;
  path: string;
  match: (pathname: string) => boolean;
  badge?: number;
}

export function TabBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { inboxCount, todoCount } = useTabBadges();
  const isDesktop = useIsDesktop();
  const { resolved, setTheme } = useTheme();
  const [moreOpen, setMoreOpen] = useState(false);

  if (isDesktop) return null;

  const tabs: Tab[] = [
    {
      label: 'Chat',
      path: '/',
      match: (p) => p === '/' || p === '/chat' || p.startsWith('/chat/'),
    },
    { label: 'Calendar', path: '/calendar', match: (p) => p.startsWith('/calendar') },
    { label: 'Inbox', path: '/inbox', match: (p) => p === '/inbox', badge: inboxCount },
    {
      label: 'Todos',
      path: '/todos',
      match: (p) => p === '/todos' || p.startsWith('/todos/'),
      badge: todoCount,
    },
  ];

  const isMoreActive = ['/tasks', '/files'].some((p) => location.pathname.startsWith(p));

  return (
    <>
      {moreOpen && (
        <div className="tab-bar-more-overlay" onClick={() => setMoreOpen(false)}>
          <div className="tab-bar-more-menu" onClick={(e) => e.stopPropagation()}>
            <button
              className="tab-bar-more-item"
              onClick={() => {
                navigate('/tasks');
                setMoreOpen(false);
              }}
            >
              Tasks
            </button>
            <button
              className="tab-bar-more-item"
              onClick={() => {
                navigate('/files');
                setMoreOpen(false);
              }}
            >
              Files
            </button>
            <div className="tab-bar-more-divider" />
            <button
              className="tab-bar-more-item"
              onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
            >
              {resolved === 'dark' ? 'Light Mode' : 'Dark Mode'}
            </button>
          </div>
        </div>
      )}
      <nav className="tab-bar">
        {tabs.map((tab) => (
          <button
            key={tab.label}
            className={`tab-bar-item ${tab.match(location.pathname) ? 'tab-bar-item--active' : ''}`}
            onClick={() => navigate(tab.path)}
          >
            <span className="tab-bar-label">{tab.label}</span>
            {tab.badge ? <span className="tab-bar-badge">{tab.badge}</span> : null}
          </button>
        ))}
        <button
          className={`tab-bar-item ${isMoreActive ? 'tab-bar-item--active' : ''}`}
          onClick={() => setMoreOpen((o) => !o)}
        >
          <span className="tab-bar-label">More</span>
        </button>
      </nav>
    </>
  );
}
