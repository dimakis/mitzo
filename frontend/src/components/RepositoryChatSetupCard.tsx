import { Link } from 'react-router-dom';
import type { ToolBlock } from '../lib/tool-status';
import { repositoryChatPreparationResult } from '../lib/repository-chat-preparation';
import '../styles/connection-setup-card.css';

export function RepositoryChatSetupCard({
  block,
  sessionId,
}: {
  block: ToolBlock;
  sessionId?: string;
}) {
  const preparation = repositoryChatPreparationResult(block, sessionId);
  if (!preparation) return null;
  return (
    <section className="connection-setup-chat-card" aria-label="Repository chat preparation">
      <h3>{preparation.state === 'ready' ? 'Repository ready' : 'Repository chat preparation'}</h3>
      <strong>{preparation.repository}</strong>
      <p>
        {preparation.baseBranch} · <code>{preparation.baseOid.slice(0, 12)}</code>
      </p>
      <p>
        New branch: <code>{preparation.featureBranch}</code>
      </p>
      <p>{preparation.prompt}</p>
      <p>
        Review this draft in a new chat. Sending the prompt starts work with the prepared account
        and model.
      </p>
      {preparation.state === 'claimed' ? (
        <Link
          className="workspace-primary"
          to={`/chat/${encodeURIComponent(preparation.conversationId!)}`}
        >
          Open repository conversation
        </Link>
      ) : (
        preparation.state !== 'discarded' && (
          <Link className="workspace-primary" to={preparation.setupUrl}>
            Open repository chat
          </Link>
        )
      )}
    </section>
  );
}
