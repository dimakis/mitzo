import { useEffect, useState } from 'react';
import { useHomePreferences } from '../hooks/useHomePreferences';
import '../styles/home.css';

export function MinionNameSettings() {
  const home = useHomePreferences();
  const [names, setNames] = useState({ briefing: '', terminal: '' });
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const conflict = home.error?.startsWith('Your preferences changed on another device.');
  useEffect(() => {
    if (home.preferences && !dirty) {
      setNames(home.preferences.names);
      setDraftRevision(home.preferences.revision);
    }
  }, [home.preferences, dirty]);
  useEffect(() => {
    if (conflict) setReviewRequired(true);
  }, [conflict]);
  return (
    <section className="today-section home-names" aria-labelledby="minion-names-title">
      <h2 id="minion-names-title">Your minions</h2>
      <p className="workspace-muted">
        Give them a name you like. Saved for this workspace across devices.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (reviewRequired || draftRevision === null) return;
          void home.update({ names }, draftRevision).then((success) => {
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
          disabled={
            home.loading ||
            home.saving ||
            !home.preferences ||
            reviewRequired ||
            draftRevision === null
          }
        >
          {home.saving ? 'Saving…' : 'Save names'}
        </button>
        {saved && <p role="status">Names saved.</p>}
        {home.error && (!conflict || reviewRequired) && <p role="alert">{home.error}</p>}
        {reviewRequired && home.preferences && (
          <>
            <p className="workspace-muted">
              Your draft is still here. Review current names to load the latest saved names before
              editing again.
            </p>
            <button
              className="home-secondary"
              type="button"
              disabled={home.saving}
              onClick={() => {
                if (!home.preferences) return;
                setNames(home.preferences.names);
                setDraftRevision(home.preferences.revision);
                setDirty(false);
                setSaved(false);
                setReviewRequired(false);
              }}
            >
              Review current names
            </button>
          </>
        )}
        {!home.preferences && !home.loading && (
          <button type="button" className="home-secondary" onClick={() => void home.reload()}>
            Try again
          </button>
        )}
      </form>
    </section>
  );
}
