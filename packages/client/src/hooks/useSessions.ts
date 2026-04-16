import { useMitzoStore } from './useStore.js';

export function useSessions() {
  return useMitzoStore((s) => s.sessions);
}
