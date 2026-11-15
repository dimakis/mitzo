import type { OrdinaryTurnLifecycle } from './ordinary-turn-lifecycle.js';

/** Per-command observers belong to the existing native owner. They cannot
 * replace another command's fence or survive that owner's teardown. */
export function createOrdinaryTurnObservers() {
  const entries = new Map<
    string,
    { original: OrdinaryTurnLifecycle; retained: OrdinaryTurnLifecycle }
  >();
  return {
    get: (commandId: string) => entries.get(commandId)?.retained,
    retain(commandId: string, observer: OrdinaryTurnLifecycle) {
      const previous = entries.get(commandId);
      if (previous) {
        if (previous.original !== observer)
          throw Error('Original ordinary turn observer requires recovery');
        return;
      }
      const retained: OrdinaryTurnLifecycle = {
        ...observer,
        terminal: (id, turn, status) => {
          try {
            observer.terminal(id, turn, status);
          } finally {
            if (entries.get(commandId)?.retained === retained) entries.delete(commandId);
          }
        },
      };
      entries.set(commandId, { original: observer, retained });
    },
    forget: (commandId: string) => {
      entries.delete(commandId);
    },
    clear: () => entries.clear(),
  };
}
