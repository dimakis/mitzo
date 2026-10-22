import type { MitzoStoreState } from '@mitzo/client';
import { Link } from 'react-router-dom';
import './LocalCommandRecovery.css';

/** Presentation only: recovery belongs to the existing frozen-command outbox. */
export function LocalCommandRecovery({
  command,
  accountLabel,
  connected,
  onRecover,
}: {
  command: MitzoStoreState['localCommand'];
  accountLabel?: string;
  connected: boolean;
  onRecover(): boolean;
}) {
  if (!command || command.state === 'consumed' || command.state === 'pending') return null;
  const request = command.request;
  const location = request?.runOn === 'openshell' ? 'OpenShell' : 'Local';
  return (
    <details className="local-command-recovery" key={request?.clientMsgId ?? 'invalid'}>
      <summary>Review retained {location} command</summary>
      <div className="local-command-recovery-body">
        <p>Delivery was not confirmed. Your message and original choices are saved.</p>
        {request ? (
          <>
            <p>
              {accountLabel ?? request.runtime.account.accountId} · {request.selection.model} ·{' '}
              {request.selection.thinking ?? 'Default thinking'} ·{' '}
              {location === 'Local' ? 'Local Mac' : location}
            </p>
            <p className="local-command-recovery-text">{request.payload.text}</p>
          </>
        ) : (
          <p>This saved command could not be read. Keep the original draft for inspection.</p>
        )}
        {!connected && <p>Reconnect before checking the original command.</p>}
        <div className="local-command-recovery-actions">
          <button
            type="button"
            className="home-secondary"
            disabled={!connected || !request || command.state === 'blocked'}
            onClick={onRecover}
          >
            Recover original {location} command
          </button>
          {command.originDraftId && (
            <Link to={`/chat?draft=${encodeURIComponent(command.originDraftId)}`}>
              Open original draft
            </Link>
          )}
          {command.sessionId && (
            <Link to={`/chat/${encodeURIComponent(command.sessionId)}`}>
              Open retained conversation
            </Link>
          )}
        </div>
      </div>
    </details>
  );
}
