import { useTelosSourceNavigation } from '../hooks/useTelosSourceNavigation';
import { SessionWorkLink } from './SessionWorkLink';

/** The compact item row is shared by the mobile and desktop ordinary chat. */
export function TelosSourceWorkLink() {
  const source = useTelosSourceNavigation();
  if (!source) return null;
  return (
    <div className="telos-chat-context">
      {source.status === 'ready' ? (
        <SessionWorkLink taskId={source.itemId} />
      ) : (
        <span role="status">
          {source.status === 'loading'
            ? 'Opening original exchange…'
            : 'Original exchange unavailable'}
        </span>
      )}
    </div>
  );
}
