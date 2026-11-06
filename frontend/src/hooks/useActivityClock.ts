import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => listeners.forEach((notify) => notify()), 1000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
const snapshot = () => Math.floor(Date.now() / 1000);
/** One shared clock for visible timestamps; it never fetches or changes ordering. */
export function useActivityClock(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot) * 1000;
}
