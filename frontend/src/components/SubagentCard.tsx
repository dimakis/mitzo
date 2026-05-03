import { useState } from 'react';
import type { FinishedSubagentState, StreamingSubagentState } from '@mitzo/protocol';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolPill } from './ToolPill';

interface SubagentCardProps {
  subagent: FinishedSubagentState | StreamingSubagentState;
}

function formatTokens(usage?: { inputTokens: number; outputTokens: number }): string {
  if (!usage) return '';
  return `${usage.inputTokens}↓ ${usage.outputTokens}↑`;
}

export function SubagentCard({ subagent }: SubagentCardProps) {
  const [expanded, setExpanded] = useState(false);

  const isRunning = 'running' in subagent && subagent.running;
  const summary = isRunning ? 'Working...' : subagent.summary || 'Complete';
  const usage = 'usage' in subagent ? subagent.usage : undefined;

  // Convert blocks to array for rendering
  const blocks = Array.isArray(subagent.blocks)
    ? subagent.blocks
    : Array.from(subagent.blocks.values());

  return (
    <div className="subagent-card">
      <button
        className="subagent-header"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span
          className={`subagent-dot ${isRunning ? 'subagent-dot--running' : 'subagent-dot--done'}`}
        />
        <span className="subagent-summary">{summary}</span>
        {usage && <span className="subagent-tokens">{formatTokens(usage)}</span>}
        <span className="subagent-chevron">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="subagent-detail">
          {blocks.map((block) => {
            if (block.blockType === 'thinking' || block.blockType === 'redacted_thinking') {
              return <ThinkingBlock key={block.blockId} block={block} />;
            }
            if (block.blockType === 'tool_use') {
              return <ToolPill key={block.blockId} block={block} />;
            }
            if (block.blockType === 'text') {
              return (
                <div key={block.blockId} className="subagent-text">
                  {block.content}
                </div>
              );
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}
