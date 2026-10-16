import type { Session } from '../types/chat';
import { HomeDialog } from './HomeDialog';
import { SessionContextUsage } from './SessionContextUsage';
import { formatTokens } from '../lib/formatTokens';
export function SessionDetailsDialog({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  return (
    <HomeDialog title="Session details" onClose={onClose}>
      <dl className="session-details-grid">
        <dt>Repository</dt>
        <dd>{session.cwd || 'Not reported'}</dd>
        <dt>Session ID</dt>
        <dd>{session.id}</dd>
        {session.branch && (
          <>
            <dt>Branch</dt>
            <dd>{session.branch}</dd>
          </>
        )}
        {session.totalTokens != null && (
          <>
            <dt>Cumulative usage</dt>
            <dd>{formatTokens(session.totalTokens)} tokens</dd>
          </>
        )}
      </dl>
      <SessionContextUsage usage={session.contextUsage} />
    </HomeDialog>
  );
}
