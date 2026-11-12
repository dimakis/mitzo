import { OperationCard } from './OperationCard';
import type { FinishedSubagentState, StreamingSubagentState } from '@mitzo/protocol';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolPill } from './ToolPill';
import { TextBubble } from './MessageBubble';

interface SubagentCardProps {
  subagent: FinishedSubagentState | StreamingSubagentState;
  description?: string;
  sessionId?: string;
}

function formatTokens(usage?: { inputTokens: number; outputTokens: number }): string {
  if (!usage) return '';
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${fmt(usage.inputTokens)}↓ ${fmt(usage.outputTokens)}↑`;
}

export function SubagentCard({ subagent, description, sessionId }: SubagentCardProps) {
  const status =
    subagent.status ?? ('running' in subagent && subagent.running ? 'running' : 'completed');
  const isRunning = status === 'running';
  const label =
    status === 'failed'
      ? 'Failed'
      : status === 'cancelled'
        ? 'Cancelled'
        : status === 'unavailable'
          ? 'Status unavailable'
          : 'Complete';
  const summary = isRunning
    ? description || 'Working...'
    : status === 'completed'
      ? subagent.summary || description || label
      : label;
  const usage = 'usage' in subagent ? subagent.usage : undefined;
  const done = !isRunning;

  // Convert blocks to array for rendering
  const blocks = Array.isArray(subagent.blocks)
    ? subagent.blocks
    : Array.from(subagent.blocks.values());

  // Count nested tool calls for the badge
  const toolCount = blocks.filter((b) => b.blockType === 'tool_use').length;

  return (
    <OperationCard
      title={summary}
      kind="Agent"
      icon="agents"
      status={isRunning ? 'Running...' : status === 'completed' ? 'Done' : undefined}
      tone={status === 'failed' || status === 'unavailable' ? 'error' : 'normal'}
      scope={
        <>
          <span
            className={`tool-pill-dot ${isRunning ? 'tool-pill-dot--pending' : status === 'failed' ? 'tool-pill-dot--error' : status === 'completed' ? 'tool-pill-dot--done' : 'tool-pill-dot--interrupted'}`}
          />
          {toolCount > 0 && <span className="tool-pill-badge">{toolCount}</span>}
          {usage && <span className="tool-pill-tokens">{formatTokens(usage)}</span>}
        </>
      }
      className={`tool-pill tool-pill--agent ${done ? 'tool-pill--done' : 'tool-pill--running'}`}
      toggleLabel={`Details for Agent ${summary}`}
      details={
        <div className="tool-pill-detail">
          {status === 'failed' && (
            <p>Subagent failed. Review retained output before asking the parent to retry.</p>
          )}
          {status === 'unavailable' && (
            <p>
              Subagent status could not be confirmed. Check the parent conversation before retrying
              work.
            </p>
          )}
          {subagent.diagnostic && (
            <p>
              Reference: <code>{subagent.diagnostic.correlationId}</code>
            </p>
          )}
          {blocks.map((block) => {
            if (block.blockType === 'thinking' || block.blockType === 'redacted_thinking') {
              return <ThinkingBlock key={block.blockId} block={block} streaming={isRunning} />;
            }
            if (block.blockType === 'tool_use') {
              return <ToolPill key={block.blockId} block={block} sessionId={sessionId} />;
            }
            if (block.blockType === 'text' && block.content) {
              return (
                <TextBubble
                  key={block.blockId}
                  content={block.content}
                  artifactSessionId={sessionId}
                />
              );
            }
            return null;
          })}
        </div>
      }
    />
  );
}
