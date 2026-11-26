import { MotionPresence } from './MotionPresence';
import { UiIcon } from './UiIcon';
import { useState } from 'react';
import type { FinishedSubagentState, StreamingSubagentState } from '@mitzo/protocol';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolPill } from './ToolPill';
import { TextBubble } from './MessageBubble';
import { BackgroundTaskDetails } from './BackgroundTaskDetails';
import type { BackgroundTaskStopController } from '../lib/background-task-stop';

interface SubagentCardProps {
  subagent: FinishedSubagentState | StreamingSubagentState;
  description?: string;
  sessionId?: string;
  taskControl?: BackgroundTaskStopController;
}

function formatTokens(usage?: { inputTokens: number; outputTokens: number }): string {
  if (!usage) return '';
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${fmt(usage.inputTokens)}↓ ${fmt(usage.outputTokens)}↑`;
}

export function SubagentCard({ subagent, description, sessionId, taskControl }: SubagentCardProps) {
  const [expanded, setExpanded] = useState(false);

  const status =
    subagent.status ?? ('running' in subagent && subagent.running ? 'running' : 'completed');
  const isRunning = status === 'running';
  // Claude chats run with background tasks disabled, so ordinary Agent subagents
  // also carry task receipts. Only a process-generation witness is positive
  // evidence of a separately owned background execution; everything else keeps
  // the ordinary nested Agent presentation.
  const task = subagent.backgroundTask?.processGeneration ? subagent.backgroundTask : undefined;
  const taskDescription = description || subagent.backgroundTask?.description;
  const label =
    status === 'failed'
      ? 'Failed'
      : status === 'cancelled'
        ? subagent.stopReason === 'process_restart'
          ? 'Stopped after restart'
          : 'Cancelled'
        : status === 'unavailable'
          ? 'Status unavailable'
          : 'Complete';
  const summary = isRunning
    ? taskDescription || 'Working...'
    : status === 'completed'
      ? subagent.summary || taskDescription || label
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
    <div
      className={`tool-pill tool-pill--agent ${task ? 'tool-pill--background-task' : ''} ${done ? 'tool-pill--done' : 'tool-pill--running'}`}
    >
      <button
        type="button"
        className="tool-pill-header"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span
          className={`tool-pill-dot ${isRunning ? 'tool-pill-dot--pending' : status === 'failed' ? 'tool-pill-dot--error' : status === 'completed' ? 'tool-pill-dot--done' : 'tool-pill-dot--interrupted'}`}
        />
        <span className="tool-pill-name">{task ? 'Background task' : 'Agent'}</span>
        <span className="tool-pill-input">
          {task ? taskDescription || 'Background work' : summary}
        </span>
        {toolCount > 0 && <span className="tool-pill-badge">{toolCount}</span>}
        {usage && <span className="tool-pill-tokens">{formatTokens(usage)}</span>}
        {task ? (
          <span className="tool-pill-status" role="status">
            {isRunning ? 'Running' : label === 'Complete' ? 'Completed' : label}
          </span>
        ) : (
          !done && <span className="tool-pill-status">Running...</span>
        )}
        <span className="tool-pill-chevron">
          <UiIcon name={expanded ? 'down' : 'forward'} size={16} />
        </span>
      </button>

      <MotionPresence open={expanded} kind="disclosure" appear={false}>
        <div className="tool-pill-detail">
          {task && (
            <BackgroundTaskDetails
              subagent={subagent}
              sessionId={sessionId}
              control={taskControl}
            />
          )}
          {!task && status === 'failed' && (
            <p>Subagent failed. Review retained output before asking the parent to retry.</p>
          )}
          {!task && status === 'unavailable' && (
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
          {!task &&
            blocks.map((block) => {
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
      </MotionPresence>
    </div>
  );
}
