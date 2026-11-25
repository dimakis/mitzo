import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MotionPresence } from './MotionPresence';
import { UiIcon } from './UiIcon';
import { ToolSetupCards } from './ToolSetupCards';
import { getToolStatus } from '../lib/tool-status';
import type { ChatBlock } from '../lib/groupMessages';
import type { ActivityRow } from '../lib/groupActivityRows';
import { webAccessSummary } from '../lib/web-access-outcome';
import { SeatLabel } from './SeatLabel';

const TASK_OPERATION_LABELS: Readonly<Record<string, string>> = {
  run: 'Run command',
  commit: 'Save code changes',
  github_read: 'Read repository',
  status: 'Check task access',
  authorize: 'Request task access',
};

function activityPreview(block: ChatBlock): string {
  if (block.blockType === 'redacted_thinking') return 'Reasoning redacted';
  if (block.blockType !== 'tool_use') {
    // A short heading conveys progress without repeating the whole reasoning summary.
    return (
      block.content
        ?.trim()
        .split(/\r?\n/, 1)[0]
        .replace(/^#{1,6}\s+/, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*_`]/g, '')
        .slice(0, 160) || 'Thinking…'
    );
  }
  if (
    ['RequestWebAccess', 'mcp__mitzo-web-access__RequestWebAccess'].includes(block.toolName ?? '')
  ) {
    const summary = webAccessSummary(block.toolInput ?? '');
    return `${summary.name} · ${summary.target}`;
  }
  if (block.toolName === 'Bash') {
    const status = getToolStatus(block);
    return status.interrupted
      ? 'Command interrupted'
      : status.done
        ? 'Command completed'
        : 'Running command';
  }
  const tool = block.toolName?.split('__').at(-1) ?? 'Tool call';
  if (tool === 'TaskExecution') {
    // Arguments are displayed even when execution rejects them: only an own,
    // known operation name may select a label, so inherited keys stay generic.
    let operation: unknown;
    try {
      operation = (JSON.parse(block.toolInput ?? '{}') as { operation?: unknown } | null)
        ?.operation;
    } catch {
      return 'Task operation';
    }
    return typeof operation === 'string' && Object.hasOwn(TASK_OPERATION_LABELS, operation)
      ? TASK_OPERATION_LABELS[operation]
      : 'Task operation';
  }
  if (['exec_command', 'write_stdin'].includes(tool))
    return tool === 'exec_command' ? 'Run command' : 'Check command output';
  const name =
    block.toolName === 'WebSearch'
      ? 'Web search'
      : block.toolName === 'WebFetch'
        ? 'Website read'
        : tool.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
  // Arguments and results remain in the expanded tool, never raw JSON in the summary.
  const input = block.toolInput?.trim();
  return input && !/^[{[]/.test(input) ? `${name} · ${input.slice(0, 160)}` : name;
}

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
  const reversed = [...rows].reverse();
  const latest =
    reversed.find((row) => row.block?.blockType === 'tool_use') ??
    reversed.find((row) => row.block)!;
  const block = latest.block!;
  const tools = rows.flatMap((row) => (row.block?.blockType === 'tool_use' ? [row.block] : []));
  const delegated: NonNullable<ChatBlock['subagent']>[] = [];
  const allTools: ChatBlock[] = [...tools];
  const collectDelegates = (tool: ChatBlock) => {
    if (!tool.subagent) return;
    delegated.push(tool.subagent);
    const blocks = Array.isArray(tool.subagent.blocks)
      ? tool.subagent.blocks
      : Array.from(tool.subagent.blocks.values());
    for (const child of blocks) {
      if (child.blockType === 'tool_use') {
        allTools.push(child);
        collectDelegates(child);
      }
    }
  };
  tools.forEach(collectDelegates);
  const delegatedRunning = delegated.filter((agent) => 'running' in agent && agent.running).length;
  const interrupted = allTools.filter((tool) => getToolStatus(tool).interrupted).length;
  const failed = allTools.filter(
    (tool) => tool.toolError && !getToolStatus(tool).interrupted,
  ).length;
  const active =
    delegatedRunning > 0 ||
    rows.some(
      (row) =>
        row.streaming &&
        row.block &&
        (row.block.blockType === 'tool_use'
          ? getToolStatus(row.block).running
          : 'done' in row.block && !row.block.done),
    );
  const label = delegated.length ? 'Agents at work' : 'Activity';
  const delegateSummary = delegated.length
    ? `${delegated.length} delegated${delegatedRunning ? ` · ${delegatedRunning} running` : ''}`
    : '';
  const preview = activityPreview(block);
  const speaker = rows[0].speaker;
  return (
    <div className="agent-activity">
      {!speaker && rows[0].attribution}
      <ToolSetupCards tools={tools} sessionId={sessionId} />
      <button
        type="button"
        className="agent-activity-header"
        ref={headerRef}
        aria-label={`${speaker ? `${speaker.name} · ` : ''}${label}: ${delegateSummary ? `${delegateSummary} · ` : ''}${preview}${interrupted ? ` · ${interrupted} interrupted` : ''}${active ? ' · Running' : ''}${failed ? ` · ${failed} failed` : ''}`}
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setChoice({ replied, expanded: !expanded })}
      >
        <UiIcon name={active ? 'running' : 'layers'} size={16} />
        <span className="agent-activity-label">{label}</span>
        {speaker && <SeatLabel seatId={speaker.id} name={speaker.name} />}
        <span className="agent-activity-preview">
          {delegateSummary && `${delegateSummary} · `}
          {preview}
          {interrupted > 0 && ` · ${interrupted} interrupted`}
        </span>
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
          {speaker && rows[0].attribution}
          {reversed.find((row) => row.requestStatus)?.requestStatus && (
            <p className="chat-command-meta">
              {reversed.find((row) => row.requestStatus)!.requestStatus}
            </p>
          )}
          {rows.map((row) => (
            <div key={row.key}>{row.value}</div>
          ))}
        </div>
      </MotionPresence>
    </div>
  );
}
