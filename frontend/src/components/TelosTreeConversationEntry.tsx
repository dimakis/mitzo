import { useEffect, useState } from 'react';
import { TelosWorkApiClient } from '@mitzo/client';
import type { TelosWorkView } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
const api = new TelosWorkApiClient(apiFetch);
/** A workspace entry, never an allocator or a second role setup owner. */
export function TelosTreeConversationEntry({
  itemId,
  refreshKey = 0,
  onOpenChat,
}: {
  itemId: string;
  refreshKey?: string | number;
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
  if (!work.kind) return <span className="telos-node-meta">Role unclassified</span>;
  const role =
    work.kind === 'work_item' ? 'worker' : work.kind === 'coordinator' ? 'coordinator' : 'lead';
  const assignment = work.assignments.find((value) => value.role === role);
  return (
    <div className="telos-tree-conversation">
      <span className="telos-node-meta">
        {assignment ? `${role[0].toUpperCase() + role.slice(1)} assigned` : `No ${role} assigned`}
      </span>
      <button onClick={onOpenChat}>
        {assignment
          ? `${role[0].toUpperCase() + role.slice(1)} chat`
          : role === 'coordinator'
            ? 'View coordinator'
            : `Choose ${role}`}
      </button>
    </div>
  );
}
