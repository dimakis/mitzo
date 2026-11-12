import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { OperationCard } from './OperationCard';
import type { ToolBlock } from '../lib/tool-status';
import { repositoryChatPreparationResult } from '../lib/repository-chat-preparation';

export function RepositoryChatSetupCard({
  block,
  sessionId,
  details,
}: {
  block: ToolBlock;
  sessionId?: string;
  details?: ReactNode;
}) {
  const preparation = repositoryChatPreparationResult(block, sessionId);
  if (!preparation) return null;
  return (
    <OperationCard
      title={preparation.repository}
      kind="Repository setup"
      icon="worktree"
      label="Repository chat preparation"
      scope={`${preparation.baseBranch} · isolated task workspace`}
      pending={!['claimed', 'discarded'].includes(preparation.state)}
      status={preparation.state === 'discarded' ? 'Discarded' : undefined}
      tone={preparation.state === 'failed' ? 'error' : 'normal'}
      actions={
        preparation.state === 'claimed' ? (
          <Link
            className="operation-primary"
            to={`/chat/${encodeURIComponent(preparation.conversationId!)}`}
          >
            Open repository conversation
          </Link>
        ) : (
          preparation.state !== 'discarded' && (
            <Link className="operation-primary" to={preparation.setupUrl}>
              Open repository chat
            </Link>
          )
        )
      }
      details={
        <>
          <p>
            {preparation.baseBranch} · <code>{preparation.baseOid.slice(0, 12)}</code>
          </p>
          <p>
            New branch: <code>{preparation.featureBranch}</code>
          </p>
          <p>{preparation.prompt}</p>
          {details}
        </>
      }
    >
      {preparation.failure && <p className="operation-error">{preparation.failure.message}</p>}
      <p>
        Review this draft in a new chat. Sending the prompt starts work with the prepared account
        and model.
      </p>
    </OperationCard>
  );
}
