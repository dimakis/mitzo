import type { MitzoNotification } from '@mitzo/protocol';
import { Link } from 'react-router-dom';
import { ApprovalCard } from './ApprovalCard';
import { OperationCard } from './OperationCard';

export function NotificationApprovalActions({
  item,
  busy,
  responseError,
  onRespond,
  presentation = 'entry',
}: {
  item: MitzoNotification;
  busy: boolean;
  responseError?: string;
  presentation?: 'entry' | 'inline';
  onRespond: (decision: 'once' | 'always' | 'deny', answers?: Record<string, string[]>) => void;
}) {
  if (
    !item.request ||
    !item.permId ||
    typeof item.request.toolName !== 'string' ||
    typeof item.request.toolInput !== 'string'
  )
    return (
      <OperationCard
        title={item.title}
        kind="Approval requires live review"
        icon="shield"
        actions={
          item.sessionId && (
            <Link className="operation-primary" to={`/chat/${encodeURIComponent(item.sessionId)}`}>
              Review
            </Link>
          )
        }
      >
        <p>The live request is unavailable here. Review its current scope in the session.</p>
      </OperationCard>
    );
  return (
    <div
      className="notification-approval-controls"
      role="group"
      aria-label={`Approval for ${item.title}`}
    >
      <ApprovalCard
        {...item.request}
        permId={item.permId}
        sessionId={item.sessionId}
        expiresAt={item.expiresAt ?? item.request.expiresAt}
        title={item.title}
        summary={item.body}
        busy={busy}
        responseError={responseError}
        showResponseError={false}
        presentation={presentation}
        responseTransport="notification"
        onRespond={(_id, decision, _tool, answers) => onRespond(decision, answers)}
      />
    </div>
  );
}
