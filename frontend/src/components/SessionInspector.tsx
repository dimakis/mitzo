import type { Session } from '../types/chat';
import type { SessionActionPoint } from '../hooks/useSessionInteraction';
import { SavedSessionHistory } from './SavedSessionHistory';
import { SessionContextUsage } from './SessionContextUsage';
import { SessionWorkLink } from './SessionWorkLink';
import { UiIcon } from './UiIcon';
import { recordTitle } from '../lib/record-title';
import { formatRelativeTime } from '../lib/formatTime';
import { formatTokens } from '../lib/formatTokens';
import '../styles/session-library.css';
export function SessionInspector({
  session,
  onOpen,
  onActions,
}: {
  session: Session;
  onOpen: () => void;
  onActions: (session: Session, trigger: HTMLElement, point?: SessionActionPoint) => void;
}) {
  return (
    <aside className="session-inspector" aria-label="Conversation preview">
      <header>
        <h2>Conversation preview</h2>
        <button
          type="button"
          className="session-action-trigger"
          aria-label="Conversation actions"
          onClick={(event) => onActions(session, event.currentTarget)}
        >
          <UiIcon name="more" size={16} />
        </button>
      </header>
      <h3>{recordTitle(session.summary || 'Untitled conversation')}</h3>
      <p className="workspace-muted">
        {formatRelativeTime(session.lastModified)}
        {session.isActive ? ' · Active' : ''}
      </p>
      {session.telosTaskId && <SessionWorkLink taskId={session.telosTaskId} />}
      <SavedSessionHistory sessionId={session.id} />
      <SessionContextUsage usage={session.contextUsage} />
      <button type="button" className="session-open-conversation" onClick={onOpen}>
        Open conversation <UiIcon name="forward" size={16} />
      </button>
      <details className="session-inspector-details">
        <summary>Session details</summary>
        <dl>
          <dt>Repository</dt>
          <dd>{session.cwd || 'Not reported'}</dd>
          {session.branch && (
            <>
              <dt>Branch</dt>
              <dd>{session.branch}</dd>
            </>
          )}
          <dt>Session ID</dt>
          <dd>{session.id}</dd>
          {session.totalTokens != null && (
            <>
              <dt>Cumulative usage</dt>
              <dd>{formatTokens(session.totalTokens)} tokens</dd>
            </>
          )}
        </dl>
      </details>
    </aside>
  );
}
