import { UiIcon } from './UiIcon';
import { Link } from 'react-router-dom';
import { useNotifications } from './NotificationProvider';
import { CollapsibleSection } from './CollapsibleSection';

export function InboxSection() {
  const notifications = useNotifications();
  const count = notifications?.feed?.needsYou ?? 0;
  return (
    <CollapsibleSection title="Inbox" badge={count || undefined} storageKey="cc-inbox">
      {notifications?.loading ? (
        <p className="cc-empty">Loading Inbox…</p>
      ) : (
        <Link className="workspace-text-link" to="/inbox">
          {count ? `${count} ${count === 1 ? 'request needs' : 'requests need'} you` : 'Open Inbox'}{' '}
          <UiIcon name="forward" size={16} />
        </Link>
      )}
      {notifications?.error && (
        <p role="alert">
          Could not load Inbox. <button onClick={() => void notifications.refresh()}>Retry</button>
        </p>
      )}
    </CollapsibleSection>
  );
}
