import { ConnectionSetupCard } from './ConnectionSetupCard';
import { connectionSetupResult } from '../lib/connection-setup-result';
import { RepositoryChatSetupCard } from './RepositoryChatSetupCard';
import { repositoryChatPreparationResult } from '../lib/repository-chat-preparation';
import type { ToolBlock } from '../lib/tool-status';
import { TelosOutcomeNotice } from './TelosOutcomeNotice';
import { TelosWorkerReceiptCard, telosWorkerReceipt } from './TelosWorkerReceiptCard';
import { OperationCard } from './OperationCard';
import { Link } from 'react-router-dom';
import { agentTaskProposalLink } from '../lib/agent-task-proposal-link';

export function ToolSetupCards({ tools, sessionId }: { tools: ToolBlock[]; sessionId?: string }) {
  return (
    <>
      {tools
        .filter((tool, index) => {
          const review = agentTaskProposalLink(tool, sessionId);
          return (
            review &&
            !tools
              .slice(index + 1)
              .some((later) => agentTaskProposalLink(later, sessionId)?.url === review.url)
          );
        })
        .map((tool) => (
          <OperationCard
            key={tool.blockId}
            title="Review saved task"
            kind="Task proposal"
            icon="work"
            actions={
              <Link
                className="operation-primary"
                aria-label="Review task in Library"
                to={agentTaskProposalLink(tool, sessionId)!.url}
              >
                Review task
              </Link>
            }
          />
        ))}
      {tools
        .filter((tool, index) => {
          const receipt = telosWorkerReceipt(tool, sessionId);
          return (
            receipt &&
            !tools
              .slice(index + 1)
              .some(
                (later) =>
                  telosWorkerReceipt(later, sessionId)?.workerConversationId ===
                  receipt.workerConversationId,
              )
          );
        })
        .map((tool) => (
          <TelosWorkerReceiptCard key={tool.blockId} block={tool} sessionId={sessionId} />
        ))}
      {tools.map((tool) => (
        <TelosOutcomeNotice key={tool.blockId} block={tool} />
      ))}
      {tools
        .filter((tool, index) => {
          const preparation = repositoryChatPreparationResult(tool, sessionId);
          return (
            preparation &&
            !tools
              .slice(index + 1)
              .some(
                (later) => repositoryChatPreparationResult(later, sessionId)?.id === preparation.id,
              )
          );
        })
        .map((tool) => (
          <RepositoryChatSetupCard key={tool.blockId} block={tool} sessionId={sessionId} />
        ))}
      {tools
        .filter((tool, index) => {
          const setup = connectionSetupResult(tool, sessionId);
          return (
            setup &&
            !tools
              .slice(index + 1)
              .some((later) => connectionSetupResult(later, sessionId)?.id === setup.id)
          );
        })
        .map((tool) => (
          <ConnectionSetupCard key={tool.blockId} block={tool} sessionId={sessionId} />
        ))}
    </>
  );
}
