import { useEffect, useMemo, type ReactNode } from 'react';
import { ApprovalDraftStore, approvalDraftContext } from '../hooks/approval-draft-context';

/** Keep unfinished answers above the responsive screen, only for live requests. */
export function ApprovalDraftProvider({
  sessionId,
  pendingIds,
  children,
}: {
  sessionId?: string;
  pendingIds: string[];
  children: ReactNode;
}) {
  const store = useMemo(() => new ApprovalDraftStore(sessionId), [sessionId]);
  const retained = JSON.stringify(pendingIds);
  useEffect(() => {
    const live = new Set<string>(JSON.parse(retained));
    for (const id of store.requests.keys()) if (!live.has(id)) store.requests.delete(id);
  }, [store, retained]);
  return <approvalDraftContext.Provider value={store}>{children}</approvalDraftContext.Provider>;
}
