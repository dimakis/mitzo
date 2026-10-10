import { ConnectionSetupCard } from './ConnectionSetupCard';
import { connectionSetupResult } from '../lib/connection-setup-result';
import { RepositoryChatSetupCard } from './RepositoryChatSetupCard';
import { repositoryChatPreparationResult } from '../lib/repository-chat-preparation';
import type { ToolBlock } from '../lib/tool-status';

export function ToolSetupCards({ tools, sessionId }: { tools: ToolBlock[]; sessionId?: string }) {
  return (
    <>
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
