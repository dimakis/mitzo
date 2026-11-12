import { OperationCard } from './OperationCard';
import { connectionSetupResult } from '../lib/connection-setup-result';
import { repositoryChatPreparationResult } from '../lib/repository-chat-preparation';
import { NativeSubagents } from './NativeSubagents';
import { UiIcon } from './UiIcon';
import { useCallback } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import type { StreamingBlock, FinishedBlock, RawToolInput } from '../types/chat';
import { getToolStatus, type ToolBlock } from '../lib/tool-status';
import { SubagentCard } from './SubagentCard';
import { CodeBlock } from './CodeBlock';
import { ToolResultContent } from './ToolResultContent';
import { artifactViewerUrl } from '../lib/file-paths';
import { webAccessOutcome, webAccessSummary } from '../lib/web-access-outcome';
import { ConnectionSetupCard } from './ConnectionSetupCard';
import { RepositoryChatSetupCard } from './RepositoryChatSetupCard';
import { GoogleSearchResult } from './GoogleSearchResult';
import { TelosWorkerReceiptCard, telosWorkerReceipt } from './TelosWorkerReceiptCard';
import { agentTaskProposalLink } from '../lib/agent-task-proposal-link';
import { TelosOutcomeNotice } from './TelosOutcomeNotice';

interface Props {
  block: ToolBlock;
  sessionId?: string;
  showSetupCard?: boolean;
}

function RawInputDetail({
  raw,
  onPopOut,
}: {
  raw: RawToolInput;
  onPopOut?: (path: string) => void;
}) {
  if (raw.type === 'read') {
    // Read tool: path shown in header, no input body to render
    return null;
  }
  if (raw.type === 'write') {
    return (
      <div className="tool-pill-section">
        <CodeBlock
          code={raw.contents || ''}
          language={raw.language}
          label={raw.path}
          maxHeight={300}
          onPopOut={raw.path && onPopOut ? () => onPopOut(raw.path!) : undefined}
        />
      </div>
    );
  }
  if (raw.type === 'diff') {
    return (
      <div className="tool-pill-section">
        <span className="tool-pill-label">
          {raw.path}
          {raw.path && onPopOut && (
            <button
              className="tool-pill-popout-inline"
              onClick={() => onPopOut(raw.path!)}
              aria-label="Open in viewer"
            >
              <UiIcon name="file" size={16} />
            </button>
          )}
        </span>
        {raw.old_string && (
          <CodeBlock
            code={raw.old_string}
            language={raw.language}
            variant="removed"
            maxHeight={200}
          />
        )}
        {raw.new_string && (
          <CodeBlock
            code={raw.new_string}
            language={raw.language}
            variant="added"
            maxHeight={200}
          />
        )}
      </div>
    );
  }
  if (raw.type === 'command') {
    return (
      <div className="tool-pill-section">
        <CodeBlock code={raw.command || ''} language="bash" label="Command" maxHeight={200} />
      </div>
    );
  }
  if (raw.type === 'agent') {
    if (!raw.prompt) return null;
    return (
      <div className="tool-pill-section">
        <CodeBlock code={raw.prompt} label="Prompt" maxHeight={300} />
      </div>
    );
  }
  return null;
}

/** Render tool result with syntax highlighting when language is known. */
function ToolResult({
  block,
  sessionId,
  onPopOut,
}: {
  block: StreamingBlock | FinishedBlock;
  sessionId?: string;
  onPopOut?: (path: string) => void;
}) {
  const hasText = block.toolResult !== undefined && block.toolResult.length > 0;
  const hasImages = block.toolResultImages && block.toolResultImages.length > 0;

  if (!hasText && !hasImages) return null;

  const raw = block.rawInput;
  const isRead = raw?.type === 'read';
  const taskReview = agentTaskProposalLink(block, sessionId);

  return (
    <div className="tool-pill-section">
      {hasImages && (
        <div className="tool-pill-images">
          {block.toolResultImages!.map((img, i) => (
            <img
              key={i}
              src={`/api/images/${img.id}`}
              alt={`Result image ${i + 1}`}
              className="tool-pill-result-img"
            />
          ))}
        </div>
      )}
      {hasText && !taskReview && !raw && <ToolResultContent text={block.toolResult!} />}
      {hasText && !taskReview && raw && (
        <CodeBlock
          code={block.toolResult!}
          language={raw?.language}
          label={isRead ? raw?.path : 'Result'}
          maxHeight={400}
          onPopOut={isRead && raw?.path && onPopOut ? () => onPopOut(raw.path!) : undefined}
        />
      )}
      {taskReview && <p>Task proposal saved. Review it using the action in the header.</p>}
    </div>
  );
}

export function ToolPill({ block, sessionId, showSetupCard = true }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const { done, hasError, interrupted, running } = getToolStatus(block);
  const input = block.toolInput || '';
  const webOutcome = webAccessOutcome(block);
  const webSummary = webAccessSummary(input);

  const handlePopOut = useCallback(
    (filePath: string) => {
      const currentPath = location.pathname + location.search;
      navigate(artifactViewerUrl(filePath, currentPath, sessionId));
    },
    [navigate, location, sessionId],
  );

  const details = (
    <div className="tool-pill-detail">
      {block.rawInput ? (
        <RawInputDetail raw={block.rawInput} onPopOut={handlePopOut} />
      ) : (
        <div className="tool-pill-section">
          <ToolResultContent text={input} label="Input" />
        </div>
      )}
      <ToolResult block={block} sessionId={sessionId} onPopOut={handlePopOut} />
    </div>
  );
  if (showSetupCard && connectionSetupResult(block, sessionId))
    return <ConnectionSetupCard block={block} sessionId={sessionId} details={details} />;
  if (showSetupCard && repositoryChatPreparationResult(block, sessionId))
    return <RepositoryChatSetupCard block={block} sessionId={sessionId} details={details} />;
  if (showSetupCard && telosWorkerReceipt(block, sessionId))
    return <TelosWorkerReceiptCard block={block} sessionId={sessionId} details={details} />;
  const taskReview = agentTaskProposalLink(block, sessionId);
  const status = interrupted
    ? 'Interrupted'
    : webOutcome || (hasError ? 'Failed' : running ? 'Running...' : 'Done');
  const title = webOutcome ? webSummary.name : block.toolName || 'Tool call';
  const summary = webOutcome ? webSummary.target : input;
  const rawType = block.rawInput?.type;
  const kind =
    rawType === 'command'
      ? 'Command'
      : rawType === 'read'
        ? 'Read file'
        : rawType === 'write' || rawType === 'diff'
          ? 'File changes'
          : rawType === 'agent'
            ? 'Agent'
            : 'Tool call';
  return (
    <OperationCard
      title={title}
      kind={kind}
      icon={
        rawType === 'command'
          ? 'terminal'
          : rawType === 'read' || rawType === 'write' || rawType === 'diff'
            ? 'file'
            : rawType === 'agent'
              ? 'agents'
              : 'work'
      }
      scope={summary}
      status={
        <>
          <span
            aria-hidden="true"
            className={`tool-pill-dot ${interrupted ? 'tool-pill-dot--interrupted' : hasError ? 'tool-pill-dot--error' : running ? 'tool-pill-dot--pending' : 'tool-pill-dot--done'}`}
          />
          {status}
        </>
      }
      tone={hasError ? 'error' : 'normal'}
      className={`tool-pill ${interrupted ? 'tool-pill--interrupted' : done ? (hasError ? 'tool-pill--error' : 'tool-pill--done') : 'tool-pill--running'}`}
      toggleLabel={`Details for ${title} ${input} ${status}`}
      details={details}
      actions={
        showSetupCard &&
        taskReview && (
          <Link
            className="operation-primary"
            aria-label="Review task in Library"
            to={taskReview.url}
          >
            Review task
          </Link>
        )
      }
    >
      {showSetupCard && <TelosOutcomeNotice block={block} embedded />}
      {['RequestWebAccess', 'mcp__mitzo-web-access__RequestWebAccess'].includes(
        block.toolName ?? '',
      ) &&
        !hasError && <GoogleSearchResult result={block.toolResult} />}
      {sessionId && block.rawInput?.nativeSubagentCommandId && (
        <NativeSubagents sessionId={sessionId} commandId={block.rawInput.nativeSubagentCommandId} />
      )}
      {block.subagent && (
        <SubagentCard
          subagent={block.subagent}
          sessionId={sessionId}
          description={block.rawInput?.type === 'agent' ? block.rawInput.description : undefined}
        />
      )}
    </OperationCard>
  );
}
