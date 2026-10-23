import { UiIcon } from './UiIcon';
import './ChatStatusMessage.css';

export interface ChatStatusAction {
  label: string;
  onClick(): void;
  disabled?: boolean;
}

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
  );
}
