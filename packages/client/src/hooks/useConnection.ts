import { useMitzoStore } from './useStore.js';

export function useConnection() {
  return useMitzoStore((s) => s.connection);
}
