import { Link, useNavigate } from 'react-router-dom';
import { deleteCredentials } from '../lib/biometric';
import { clearWatchToken } from '../lib/watch-auth';
import { ServiceStatus } from '../components/ServiceStatus';
import { logout } from '../lib/api-fetch';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
export function MoreView() {
  const navigate = useNavigate();
  return (
    <main className="workspace-page">
      <WorkspacePageHeading title="More" description="Your tools and preferences." />
      {[
        ['Notifications', '/notifications'],
        ['Calendar', '/calendar'],
        ['Agent taskboard', '/tasks'],
        ['Files', '/files'],
        ['Settings', '/settings'],
        ['All attention', '/focus'],
        ['Chat history and quick actions', '/sessions'],
        ['Connections', '/connections-access'],
      ].map(([label, to]) => (
        <Link className="workspace-record" key={to} to={to}>
          {label}
          <span aria-hidden="true">↗</span>
        </Link>
      ))}
      <section className="today-section">
        <h2>Connections</h2>
        <p className="workspace-muted">Choose AI accounts and models inside a chat.</p>
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
