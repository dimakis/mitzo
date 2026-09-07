import { Link, useNavigate } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { deleteCredentials } from '../lib/biometric';
import { clearWatchToken } from '../lib/watch-auth';
import { ServiceStatus } from '../components/ServiceStatus';
import { logout } from '../lib/api-fetch';
export function MoreView() {
  const { preference, setTheme } = useTheme();
  const navigate = useNavigate();
  return (
    <main className="workspace-page">
      <h1>More</h1>
      <p className="workspace-muted">Your tools and preferences.</p>
      {[
        ['Calendar', '/calendar'],
        ['Agent taskboard', '/tasks'],
        ['Files', '/files'],
        ['All attention', '/focus'],
        ['Chat history and quick actions', '/sessions'],
      ].map(([label, to]) => (
        <Link className="workspace-record" key={to} to={to}>
          {label}
          <span aria-hidden="true">↗</span>
        </Link>
      ))}
      <section className="today-section">
        <h2>Appearance</h2>
        <label className="workspace-setting">
          Theme
          <select
            aria-label="Theme"
            value={preference}
            onChange={(e) => setTheme(e.target.value as 'light' | 'dark' | 'system')}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </section>
      <section className="today-section">
        <h2>Connections</h2>
        <p className="workspace-muted">Choose AI accounts and models inside a chat.</p>
        <ServiceStatus />
      </section>
      <button
        className="workspace-text-link"
        onClick={async () => {
          await logout();
          await deleteCredentials();
          await clearWatchToken();
          navigate('/login');
        }}
      >
        Log out
      </button>
    </main>
  );
}
