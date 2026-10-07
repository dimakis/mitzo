import { Link } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
export function SettingsView() {
  const { preference, setTheme } = useTheme();
  return (
    <main className="workspace-page settings-page">
      <WorkspacePageHeading title="Settings" description="Your preferences and data protection." />
      <section className="today-section">
        <h2>Data protection</h2>
        <Link className="workspace-record" to="/settings/backups">
          <span>Backups</span>
          <span aria-hidden="true">↗</span>
        </Link>
        <p className="workspace-muted">
          Manage encrypted backups, check coverage and review recent runs.
        </p>
      </section>
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
    </main>
  );
}
