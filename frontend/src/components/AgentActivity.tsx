import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MotionPresence } from './MotionPresence';
import { UiIcon } from './UiIcon';
import { ToolSetupCards } from './ToolSetupCards';
import { getToolStatus } from '../lib/tool-status';
import type { ActivityRow } from '../lib/groupActivityRows';

export function AgentActivity({
  rows,
  sessionId,
  replied,
}: {
  rows: ActivityRow<ReactNode>[];
  sessionId?: string;
  replied: boolean;
}) {
  const [choice, setChoice] = useState<{ replied: boolean; expanded: boolean } | null>(null);
  // Keep manual choices within a phase; the first reply starts a new collapsed phase.
  const expanded = choice?.replied === replied ? choice.expanded : !replied;
  const detailsId = useId();
  const headerRef = useRef<HTMLButtonElement>(null);
  const detailsFocused = useRef(false);
  useLayoutEffect(() => {
    if (!expanded && detailsFocused.current) {
      headerRef.current?.focus({ preventScroll: true });
      detailsFocused.current = false;
    }
  }, [expanded]);
  const latest = rows.at(-1)!;
  const block = latest.block!;
  const tools = rows.flatMap((row) => (row.block?.blockType === 'tool_use' ? [row.block] : []));
  const failed = tools.filter((tool) => tool.toolError).length;
  const active = rows.some(
    (row) =>
      row.streaming &&
      row.block &&
      (('done' in row.block && !row.block.done) ||
        (row.block.blockType === 'tool_use' && !getToolStatus(row.block).done)),
  );
  const preview =
    block.blockType === 'tool_use'
      ? [block.toolName ?? 'Tool call', block.toolInput].filter(Boolean).join(' · ')
      : block.blockType === 'redacted_thinking'
        ? 'Reasoning redacted'
        : block.content?.trim().replace(/\s+/g, ' ') || 'Thinking…';
  return (
    <div className="agent-activity">
      {rows[0].attribution}
      <ToolSetupCards tools={tools} sessionId={sessionId} />
      <button
        type="button"
        className="agent-activity-header"
        ref={headerRef}
        aria-label={`Agent at work: ${preview}${active ? ' · Running' : ''}${failed ? ` · ${failed} failed` : ''}`}
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setChoice({ replied, expanded: !expanded })}
      >
        <UiIcon name={active ? 'running' : 'layers'} size={16} />
        <span className="agent-activity-label">Agent at work</span>
        <span className="agent-activity-preview">{preview}</span>
        {failed > 0 && <span className="agent-activity-error">{failed} failed</span>}
        <UiIcon name={expanded ? 'down' : 'forward'} size={16} />
      </button>
      <MotionPresence open={expanded} kind="disclosure" appear={false}>
        <div
          id={detailsId}
          className="agent-activity-details"
          onFocusCapture={() => {
            detailsFocused.current = true;
          }}
          onBlurCapture={(event) => {
            // Ignore the blur caused by making closing details inert; the
            // layout effect returns that focus to the disclosure header.
            if (expanded)
              detailsFocused.current = event.currentTarget.contains(event.relatedTarget);
          }}
        >
          {rows.map((row) => (
            <div key={row.key}>{row.value}</div>
          ))}
        </div>
      </MotionPresence>
    </div>
  );
}
