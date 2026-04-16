import { useMitzoStore } from './useStore.js';

export function useMessages() {
  return useMitzoStore((s) => s.messages);
}
