import { useId, useState } from 'react';
import { getToolStatus, type ToolBlock } from '../lib/tool-status';
import { ToolPill } from './ToolPill';

interface Props {
  tools: ToolBlock[];
  sessionId?: string;
}

export function ToolGroup({ tools, sessionId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  // A single operation already has its own detail disclosure. Show its useful
  // summary directly instead of requiring a second, count-only disclosure.
  if (tools.length === 1) return <ToolPill block={tools[0]} sessionId={sessionId} />;
  const statuses = tools.map(getToolStatus);
  const doneCount = statuses.filter((status) => status.done).length;
  const failedCount = statuses.filter((status) => status.done && status.hasError).length;
  const runningCount = tools.length - doneCount;
  const summary =
    runningCount > 0
      ? `${doneCount}/${tools.length} complete · ${runningCount} running`
      : `${tools.length} tool call${tools.length === 1 ? '' : 's'}`;
  const statusSummary = failedCount > 0 ? `${summary} · ${failedCount} failed` : summary;

  return (
    <div className="tool-group">
      <button
        type="button"
        className="tool-group-header"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-controls={listId}
      >
        <div className="tool-group-dots">
          {tools.slice(0, 8).map((t, i) => (
            <span
              key={t.blockId || i}
              className={`tool-pill-dot ${statuses[i].done ? (statuses[i].hasError ? 'tool-pill-dot--error' : 'tool-pill-dot--done') : 'tool-pill-dot--pending'}`}
            />
          ))}
          {tools.length > 8 && <span className="tool-group-dots-more">+{tools.length - 8}</span>}
        </div>
        <span className="tool-group-label">{statusSummary}</span>
        <span className="tool-group-chevron">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div id={listId} className="tool-group-list">
          {tools.map((t, i) => (
            <ToolPill key={t.blockId || i} block={t} sessionId={sessionId} />
          ))}
        </div>
      )}
    </div>
  );
}
