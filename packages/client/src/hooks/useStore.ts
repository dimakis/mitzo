/**
 * React context + hook for MitzoStore.
 *
 * Usage in Mitzo mobile:
 *   <MitzoStoreProvider store={store}>
 *     <App />
 *   </MitzoStoreProvider>
 *
 *   const messages = useMitzoStore(s => s.messages);
 */

import { createContext, useContext } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import type { MitzoStoreState } from '../store.js';

const MitzoStoreContext = createContext<StoreApi<MitzoStoreState> | null>(null);

export const MitzoStoreProvider = MitzoStoreContext.Provider;

export function useMitzoStore<T>(selector: (state: MitzoStoreState) => T): T {
  const store = useContext(MitzoStoreContext);
  if (!store) {
    throw new Error('useMitzoStore must be used within a <MitzoStoreProvider>');
  }
  return useStore(store, selector);
}
