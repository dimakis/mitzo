import { useHomePreferences } from '../hooks/useHomePreferences';
import '../styles/home.css';

export function HomeDisplaySettings() {
  const home = useHomePreferences();
  return (
    <section className="today-section" aria-labelledby="home-display-title">
      <h2 id="home-display-title">Today</h2>
      <p className="workspace-muted">Saved for this workspace across devices.</p>
      <label className="today-token-toggle">
        <input
          type="checkbox"
          checked={home.preferences?.showDailyQuote ?? false}
          disabled={home.loading || home.saving || !home.preferences || !!home.error}
          onChange={(event) => {
            if (!home.preferences) return;
            void home.update({ showDailyQuote: event.target.checked }, home.preferences.revision);
          }}
        />
        Show daily quote on Today
      </label>
      {home.saving && <p role="status">Saving…</p>}
      {home.error && (
        <div className="workspace-load-error" role="alert">
          <span>{home.error}</span>
          <button
            type="button"
            className="home-secondary"
            disabled={home.loading || home.saving}
            onClick={() => void home.review()}
          >
            {home.preferences ? 'Review current setting' : 'Try again'}
          </button>
        </div>
      )}
    </section>
  );
}
