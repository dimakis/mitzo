import { UiIcon } from './UiIcon';
import { ComposerStatusNotice } from './ComposerStatus';
import type { ComposerStatusAction } from '../lib/composer-status-context';
import './ChatStatusMessage.css';

export type ChatStatusAction = ComposerStatusAction;

/** Shared, quiet progress beside the composer; only failures use an alert. */
export function ChatStatusMessage({
  status,
  error,
  busy = false,
  action,
}: {
  status?: string | null;
  error?: string | null;
  busy?: boolean;
  action?: ChatStatusAction;
}) {
  const message = error || status;
  if (!message) return null;
  return (
    <ComposerStatusNotice
      message={message}
      tone={error ? 'danger' : action ? 'warning' : 'normal'}
      busy={busy}
      action={action}
    >
      <div
        className={`chat-status-message${error ? ' chat-status-message--error' : ''}${action ? ' chat-status-message--action' : ''}`}
        role={error ? 'alert' : 'status'}
      >
        <UiIcon name={error ? 'error' : busy ? 'loading' : 'clock'} size={16} />
        <span>{message}</span>
        {action && (
          <button
            type="button"
            className="home-secondary"
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        )}
      </div>
    </ComposerStatusNotice>
  );
}
