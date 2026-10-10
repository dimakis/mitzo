import { Link, useNavigate } from 'react-router-dom';
import { deleteCredentials } from '../lib/biometric';
import { clearWatchToken } from '../lib/watch-auth';
import { ServiceStatus } from '../components/ServiceStatus';
import { logout } from '../lib/api-fetch';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { UiIcon } from '../components/UiIcon';
export function MoreView() {
  const navigate = useNavigate();
  return (
    <main className="workspace-page more-page">
      <WorkspacePageHeading title="More" description="Your tools and preferences." />
      {(
        [
          {
            title: 'Workspace',
            items: [
              ['Connections', '/connections-access', 'connections'],
              ['Notifications', '/notifications', 'bell'],
              ['Calendar', '/calendar', 'calendar'],
              ['Agent taskboard', '/tasks', 'agents'],
              ['Agent Library', '/agent-library', 'files'],
              ['Knowledge', '/knowledge', 'files'],
              ['Files', '/files', 'files'],
              ['All attention', '/focus', 'today'],
              ['Chat history and quick actions', '/sessions', 'chats'],
            ],
          },
          {
            title: 'Preferences',
            items: [
              ['Settings', '/settings', 'settings'],
              ['API connections', '/connections?manage=api', 'connections'],
            ],
          },
        ] as const
      ).map((group) => (
        <section className="more-group" key={group.title} aria-label={group.title}>
          <h2>{group.title}</h2>
          <div className="access-row-group">
            {group.items.map(([label, to, icon]) => (
              <Link className="more-link" key={to} to={to}>
                <span className="more-link-icon">
                  <UiIcon name={icon} />
                </span>
                <span>{label}</span>
                <span className="more-link-chevron" aria-hidden="true">
                  <UiIcon name="forward" size={16} />
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
      <section className="more-service-status" aria-label="Service status">
        <ServiceStatus />
      </section>
      <button
        className="workspace-text-link"
        onClick={async () => {
          const logoutRequest = logout();
          await Promise.allSettled([logoutRequest, deleteCredentials(), clearWatchToken()]);
          navigate('/login');
        }}
      >
        Log out
      </button>
    </main>
  );
}
