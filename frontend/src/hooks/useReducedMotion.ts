import { useSyncExternalStore } from 'react';
import { REDUCED_MOTION_QUERY } from '../lib/motion';

function subscribe(callback: () => void) {
  const media = window.matchMedia?.(REDUCED_MOTION_QUERY);
  media?.addEventListener('change', callback);
  return () => media?.removeEventListener('change', callback);
}
function snapshot() {
  return window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
}

export function useReducedMotion() {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}
