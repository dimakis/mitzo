import { ChatRuntimeDraftContext } from './chat-runtime-draft-context';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
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
  } | null>(null);
  const update = useCallback(
    (selection: ChatRuntimeSelection) => setRetained({ owner, selection }),
    [owner],
  );
  const selection = retained?.owner === owner ? retained.selection : null;
  const value = useMemo(() => ({ selection, update }), [selection, update]);
  return (
    <ChatRuntimeDraftContext.Provider value={value}>{children}</ChatRuntimeDraftContext.Provider>
  );
}
