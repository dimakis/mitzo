import type { MitzoNotification } from '@mitzo/protocol';

/** Shared decisions for Inbox entries and their full request view. */
export function NotificationApprovalActions({
  item,
  busy,
  onRespond,
}: {
  item: MitzoNotification;
  busy: boolean;
  onRespond: (decision: 'once' | 'always' | 'deny') => void;
}) {
  const request = item.request;
  if (!request || request.questions) return null;
  let sessionSearch = false;
  if (request.toolName === 'RequestWebAccess' && request.approvalScope === 'session') {
    try {
      sessionSearch = JSON.parse(request.toolInput).operation === 'search';
    } catch {
      // Non-JSON inputs retain the ordinary server-described approval scope.
    }
  }
  return (
    <div
      className="notification-approval-controls"
      role="group"
      aria-label={`Approval for ${item.title}`}
    >
      <div className="notification-actions">
        {request.approvalScope !== 'conversation' && (
          <button
            type="button"
            className="notification-button notification-primary"
            disabled={busy}
            onClick={() => onRespond('once')}
          >
            Allow once
          </button>
        )}
        {request.allowSessionGrant !== false && (
          <button
            type="button"
            className="notification-button"
            disabled={busy}
            onClick={() => onRespond('always')}
          >
            {sessionSearch ? 'Allow searches for this session' : 'Allow for session'}
          </button>
        )}
        <button
          type="button"
          className="notification-button"
          disabled={busy}
          onClick={() => onRespond('deny')}
        >
          Deny
        </button>
      </div>
      <p className="workspace-muted notification-approval-scope">
        {(request.allowSessionGrant !== false && request.sessionGrantDescription) ||
          (request.approvalScope === 'conversation'
            ? 'This request concerns conversation access. Review its scope in the session.'
            : request.allowSessionGrant === false
              ? 'Allow once covers this request.'
              : sessionSearch
                ? 'Allow once, or allow searches on this account and model until the session ends. Website access stays separate.'
                : 'Allow once covers this request. Allow for session keeps this approval until the session ends.')}
      </p>
      {item.expiresAt && (
        <p className="workspace-muted notification-approval-scope">
          Expires {new Date(item.expiresAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
