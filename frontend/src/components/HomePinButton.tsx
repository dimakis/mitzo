import { UiIcon } from './UiIcon';
import type { HomePin } from '@mitzo/protocol';
import { useHomePreferences } from '../hooks/useHomePreferences';
import '../styles/home.css';

export function HomePinButton({
  pin,
  variant = 'button',
  menuItem = false,
}: {
  pin: HomePin;
  variant?: 'button' | 'menu';
  menuItem?: boolean;
}) {
  const home = useHomePreferences();
  const pinned = home.preferences?.pins.some(
    (item) => item.kind === pin.kind && item.id === pin.id,
  );
  return (
    <span className="home-pin-control">
      <button
        type="button"
        className={variant === 'menu' ? 'session-action-pin-today' : 'home-secondary'}
        role={menuItem ? 'menuitem' : undefined}
        disabled={home.loading || home.saving || !home.preferences}
        onClick={() => {
          if (!home.preferences) return;
          const pins = pinned
            ? home.preferences.pins.filter((item) => item.kind !== pin.kind || item.id !== pin.id)
            : [...home.preferences.pins, pin];
          void home.update({ pins });
        }}
      >
        {variant === 'menu' && <UiIcon name="pin" />}
        {pinned ? 'Unpin from Today' : 'Pin to Today'}
      </button>
      {home.error && <span role="alert">{home.error}</span>}
    </span>
  );
}
