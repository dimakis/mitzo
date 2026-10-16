import { useSyncExternalStore, useState } from 'react';
const KEY = 'mitzo-today-tokens';
const CHANGED = 'mitzo:session-display';
function read() {
  try {
    return localStorage.getItem(KEY) !== 'false';
  } catch {
    return true;
  }
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener(CHANGED, listener);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(CHANGED, listener);
    window.removeEventListener('storage', storage);
  };
}
/** Keep the legacy preference key, so existing device choices survive the move to Appearance. */
export function useSessionDisplay() {
  const showContext = useSyncExternalStore(subscribe, read, () => true);
  const [error, setError] = useState<string | null>(null);
  function setShowContext(value: boolean) {
    try {
      localStorage.setItem(KEY, String(value));
      setError(null);
      window.dispatchEvent(new Event(CHANGED));
    } catch {
      setError('Couldn’t save your display preference. Try again.');
    }
  }
  return { showContext, setShowContext, error };
}
