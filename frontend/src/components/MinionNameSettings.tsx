import { useEffect, useState } from 'react';
import { useHomePreferences } from '../hooks/useHomePreferences';
import '../styles/home.css';

export function MinionNameSettings() {
  const home = useHomePreferences();
  const [names, setNames] = useState({ briefing: '', terminal: '' });
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (home.preferences && !dirty) setNames(home.preferences.names);
  }, [home.preferences, dirty]);
  return (
    <section className="today-section home-names" aria-labelledby="minion-names-title">
      <h2 id="minion-names-title">Your minions</h2>
      <p className="workspace-muted">
        Give them a name you like. Saved for this workspace across devices.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void home.update({ names }).then((success) => {
            setSaved(success);
            if (success) setDirty(false);
          });
        }}
      >
        <label>
          Briefing minion name
          <input
            value={names.briefing}
            maxLength={80}
            placeholder="Minion"
            disabled={home.loading || home.saving || !home.preferences}
            onChange={(event) => {
              setNames({ ...names, briefing: event.target.value });
              setSaved(false);
              setDirty(true);
            }}
          />
        </label>
        <label>
          Terminal minion name
          <input
            value={names.terminal}
            maxLength={80}
            placeholder="Minion"
            disabled={home.loading || home.saving || !home.preferences}
            onChange={(event) => {
              setNames({ ...names, terminal: event.target.value });
              setSaved(false);
              setDirty(true);
            }}
          />
        </label>
        <button
          className="home-secondary"
          type="submit"
          disabled={home.loading || home.saving || !home.preferences}
        >
          {home.saving ? 'Saving…' : 'Save names'}
        </button>
        {saved && <p role="status">Names saved.</p>}
        {home.error && <p role="alert">{home.error}</p>}
        {!home.preferences && !home.loading && (
          <button type="button" className="home-secondary" onClick={() => void home.reload()}>
            Try again
          </button>
        )}
      </form>
    </section>
  );
}
