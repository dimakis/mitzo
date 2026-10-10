import type { HomePin } from '@mitzo/protocol';
import { useHomePreferences } from '../hooks/useHomePreferences';
import '../styles/home.css';

export function HomePinButton({ pin }: { pin: HomePin }) {
  const home = useHomePreferences();
  const pinned = home.preferences?.pins.some(
    (item) => item.kind === pin.kind && item.id === pin.id,
  );
  return (
    <span className="home-pin-control">
      <button
        type="button"
        className="home-secondary"
        disabled={home.loading || home.saving || !home.preferences}
        onClick={() => {
          if (!home.preferences) return;
          const pins = pinned
            ? home.preferences.pins.filter((item) => item.kind !== pin.kind || item.id !== pin.id)
            : [...home.preferences.pins, pin];
          void home.update({ pins });
        }}
      >
        {pinned ? 'Unpin from Today' : 'Pin to Today'}
      </button>
      {home.error && <span role="alert">{home.error}</span>}
    </span>
  );
}
