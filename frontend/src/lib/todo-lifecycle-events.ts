import { invalidateTodoReads } from './api-fetch';
const listeners = new Set<() => void>();
export function subscribeTodoLifecycleUpdates(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** A validated acknowledgement invalidates reads; it never projects new state
 * from a historical receipt or changes canonical records in the browser. */
export function notifyTodoLifecycleChange(): void {
  invalidateTodoReads();
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      console.error('Unable to refresh a confirmed Telos lifecycle change');
    }
  }
}
