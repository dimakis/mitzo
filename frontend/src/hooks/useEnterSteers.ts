import { useLayoutPreference } from './useLayoutPreference';

export const enterSteersKey = 'mitzo-enter-steers';

/** Device preference: Enter steers a running turn instead of queueing (off by default). */
export function useEnterSteers() {
  return useLayoutPreference(enterSteersKey, false, (raw) => raw === 'true', String);
}
