import { useMitzoStore } from './useStore.js';

export function useTokens() {
  return useMitzoStore((s) => s.tokens);
}
