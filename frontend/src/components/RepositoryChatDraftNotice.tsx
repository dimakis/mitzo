import { Link } from 'react-router-dom';
import type { useRepositoryChatPreparation } from '../hooks/useRepositoryChatPreparation';

export function RepositoryChatDraftNotice({
  handoff,
}: {
  handoff: ReturnType<typeof useRepositoryChatPreparation>;
}) {
  if (!handoff.present) return null;
  const preparation = handoff.preparation;
  return (
    <section className="repository-chat-picker" aria-label="Repository task draft">
      <strong>{preparation?.repository ?? 'Repository task draft'}</strong>
      {preparation && (
        <>
          <p>
            {preparation.baseBranch} · <code>{preparation.baseOid.slice(0, 12)}</code>
          </p>
          {preparation.state !== 'preparing' && preparation.state !== 'claiming' && (
            <p>
              Review the editable task below. Send starts work with the prepared account and model.
            </p>
          )}
          <Link to={`/chat/${encodeURIComponent(preparation.sourceConversationId)}`}>
            Return to parent chat
          </Link>
        </>
      )}
      {handoff.reason && <p role={handoff.loading ? 'status' : 'alert'}>{handoff.reason}</p>}
      {preparation?.state === 'claimed' && preparation.conversationId && (
        <Link to={`/chat/${encodeURIComponent(preparation.conversationId)}`}>
          Open repository conversation
        </Link>
      )}
      {handoff.reason && !handoff.loading && (
        <button type="button" onClick={handoff.retry}>
          Refresh preparation status
        </button>
      )}
    </section>
  );
}
