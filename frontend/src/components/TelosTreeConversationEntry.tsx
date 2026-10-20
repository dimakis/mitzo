import { useEffect, useState } from 'react';
import { TelosWorkApiClient } from '@mitzo/client';
import type { TelosWorkView } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { telosWorkEntryRole } from '../lib/telos-work-entry-role';
const api = new TelosWorkApiClient(apiFetch);
/** A workspace entry, never an allocator or a second role setup owner. */
export function TelosTreeConversationEntry({
  itemId,
  refreshKey,
  onOpenChat,
}: {
  itemId: string;
  refreshKey: string | number;
  onOpenChat(): void;
}) {
  const [result, setResult] = useState<{
    itemId: string;
    view?: TelosWorkView;
    failed?: boolean;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    void api.read(itemId, controller.signal).then(
      (view) => {
        if (!controller.signal.aborted) setResult({ itemId, view });
      },
      () => {
        if (!controller.signal.aborted) setResult({ itemId, failed: true });
      },
    );
    return () => controller.abort();
  }, [itemId, refreshKey]);
  if (result?.itemId !== itemId)
    return <span className="telos-node-meta">Loading conversations…</span>;
  if (result.failed) return <span className="telos-node-meta">Conversations unavailable</span>;
  const work = result.view!;
  const role = telosWorkEntryRole(work.kind);
  if (!role) return <span className="telos-node-meta">Role unclassified</span>;
  const displayRole = work.kind === 'coordinator' ? 'coordinator' : role;
  const assignment = work.assignments.find((value) => value.role === role);
  return (
    <div className="telos-tree-conversation">
      <span className="telos-node-meta">
        {assignment
          ? `${displayRole[0].toUpperCase() + displayRole.slice(1)} assigned`
          : `No ${displayRole} assigned`}
      </span>
      <button onClick={onOpenChat}>
        {assignment
          ? `${displayRole[0].toUpperCase() + displayRole.slice(1)} chat`
          : displayRole === 'coordinator'
            ? 'View coordinator'
            : `Choose ${role}`}
      </button>
    </div>
  );
}
