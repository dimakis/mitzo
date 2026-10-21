import { Link, useLocation } from 'react-router-dom';
import type { TelosCreatedItem } from '../hooks/useTelosCreatedItems';
import { UiIcon } from './UiIcon';
import './TelosWorkerReceiptCard.css';
export function TelosCreatedItemCard({ item }: { item: TelosCreatedItem }) {
  const location = useLocation();
  const creation = item.packet.creation;
  if (!creation) return null;
  const count = item.packet.context.messages.length;
  return (
    <div
      className="telos-worker-receipt telos-created-item"
      data-telos-source-snapshot={item.snapshotId}
    >
      <Link
        className="telos-worker-receipt-row"
        aria-label={`Open ${creation.outcome.summary} · Created from this exchange`}
        to={`/todos/${encodeURIComponent(item.itemId)}?view=Overview`}
        state={location.state}
      >
        <span className="telos-worker-receipt-icon">
          <UiIcon name="work" size={16} />
        </span>
        <span className="telos-worker-receipt-name">
          <strong>{creation.outcome.summary}</strong>
          <small>Created from this exchange</small>
          <small>
            {item.packet.selection.mode === 'selected'
              ? 'Selected exchange'
              : 'Conversation through this exchange'}{' '}
            · {count} {count === 1 ? 'message' : 'messages'}
          </small>
        </span>
        <UiIcon name="arrowUpRight" size={16} />
      </Link>
    </div>
  );
}
