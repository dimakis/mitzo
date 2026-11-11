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
  const isRunning = 'running' in subagent && subagent.running;
  const summary = isRunning
    ? description || 'Working...'
    : subagent.summary || description || 'Complete';
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
      status={isRunning ? 'Running...' : 'Done'}
      scope={
        <>
          <span
            className={`tool-pill-dot ${isRunning ? 'tool-pill-dot--pending' : 'tool-pill-dot--done'}`}
          />
          {toolCount > 0 && <span className="tool-pill-badge">{toolCount}</span>}
          {usage && <span className="tool-pill-tokens">{formatTokens(usage)}</span>}
        </>
      }
      className={`tool-pill tool-pill--agent ${done ? 'tool-pill--done' : 'tool-pill--running'}`}
      toggleLabel={`Details for Agent ${summary}`}
      details={
        <div className="tool-pill-detail">
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
