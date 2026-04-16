import { useMitzoStore } from './useStore.js';

export function usePermission() {
  return useMitzoStore((s) => s.permissions);
}
