import { UiIcon } from '../components/UiIcon';
import { Link } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { ACCENTS, FONTS, useAppearance } from '../hooks/useAppearance';
import { HomeDisplaySettings } from '../components/HomeDisplaySettings';
import { MinionNameSettings } from '../components/MinionNameSettings';
export function SettingsView() {
  const { preference, setTheme } = useTheme();
  const appearance = useAppearance();
  return (
    <main className="workspace-page settings-page">
      <WorkspacePageHeading title="Settings" description="Your preferences and data protection." />
      <HomeDisplaySettings />
      <MinionNameSettings />
      <section className="appearance-section">
        <h2>Appearance</h2>
        <p className="workspace-muted">Make Mitzo feel like yours. Saved on this device.</p>
        <div className="appearance-panel">
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
          <fieldset className="appearance-accents">
            <legend>Accent color</legend>
            <div className="appearance-accent-options">
              {ACCENTS.map(({ value, label }) => (
                <label className="appearance-accent-choice" key={value}>
                  <input
                    type="radio"
                    name="accent"
                    value={value}
                    checked={appearance.accent === value}
                    onChange={() => appearance.setAccent(value)}
                  />
                  <span className="appearance-swatch" data-accent={value} aria-hidden="true" />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="workspace-setting">
            Font
            <select
              aria-label="Font"
              value={appearance.font}
              onChange={(event) => appearance.setFont(event.target.value as typeof appearance.font)}
            >
              {FONTS.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="appearance-preview" aria-label="Appearance preview">
            <p className="workspace-eyebrow">Your Mitzo</p>
            <h3>A little more room for what matters.</h3>
            <p>Your conversations, ideas and next steps, in one clear place.</p>
            <span className="appearance-preview-action">Ready when you are</span>
          </div>
          <button
            className="appearance-reset"
            onClick={() => {
              appearance.reset();
              setTheme('system');
            }}
          >
            Reset appearance
          </button>
        </div>
      </section>
      <section className="today-section">
        <h2>Data protection</h2>
        <Link className="workspace-record" to="/settings/backups">
          <span>Backups</span>
          <span aria-hidden="true">
            <UiIcon name="forward" size={16} />
          </span>
        </Link>
        <p className="workspace-muted">
          Manage encrypted backups, check coverage and review recent runs.
        </p>
      </section>
    </main>
  );
}
