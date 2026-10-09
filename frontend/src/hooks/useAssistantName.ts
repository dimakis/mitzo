import { useSyncExternalStore } from 'react';
const KEY = 'mitzo-assistant-name';
const CHANGED = 'mitzo:assistant-name';
function read() {
  try {
    return localStorage.getItem(KEY)?.trim() || 'Minion';
  } catch {
    return 'Minion';
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
/** One display name for every helper role. Account and model identities remain explicit. */
export function useAssistantName() {
  const name = useSyncExternalStore(subscribe, read, () => 'Minion');
  return {
    name,
    setName(value: string) {
      const name =
        value
          .replace(/[\u0000-\u001f\u007f]/g, '')
          .trim()
          .slice(0, 40) || 'Minion';
      localStorage.setItem(KEY, name);
      window.dispatchEvent(new Event(CHANGED));
    },
  };
}
