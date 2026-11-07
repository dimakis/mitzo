import { ChatRuntimeDraftContext } from './chat-runtime-draft-context';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatRuntimeSelection } from '../lib/chat-runtime-selection';
/** Compose intent follows the existing new-chat generation across responsive layouts. */
export function ChatRuntimeDraftProvider({
  owner,
  children,
}: {
  owner: string;
  children: ReactNode;
}) {
  const [retained, setRetained] = useState<{
    owner: string;
    selection: ChatRuntimeSelection;
    edited: boolean;
  } | null>(null);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const update = useCallback(
    (selection: ChatRuntimeSelection, origin?: 'hydrate') =>
      setRetained((previous) => {
        if (currentOwner.current !== owner) return previous;
        const edited = previous?.owner === owner && previous.edited;
        if (origin === 'hydrate' && edited) return previous;
        return { owner, selection, edited: edited || origin !== 'hydrate' };
      }),
    [owner],
  );
  const selection = retained?.owner === owner ? retained.selection : null;
  const value = useMemo(() => ({ selection, update }), [selection, update]);
  return (
    <ChatRuntimeDraftContext.Provider value={value}>{children}</ChatRuntimeDraftContext.Provider>
  );
}
