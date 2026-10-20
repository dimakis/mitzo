import { UiIcon } from './UiIcon';
import './ChatStatusMessage.css';

/** Shared, quiet progress beside the composer; only failures use an alert. */
export function ChatStatusMessage({
  status,
  error,
  busy = false,
}: {
  status?: string | null;
  error?: string | null;
  busy?: boolean;
}) {
  const message = error || status;
  if (!message) return null;
  return (
    <div
      className={`chat-status-message${error ? ' chat-status-message--error' : ''}`}
      role={error ? 'alert' : 'status'}
    >
      <UiIcon name={error ? 'error' : busy ? 'loading' : 'clock'} size={16} />
      <span>{message}</span>
    </div>
  );
}
