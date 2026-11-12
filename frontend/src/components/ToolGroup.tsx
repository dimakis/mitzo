import { ToolSetupCards } from './ToolSetupCards';
import { OperationCard } from './OperationCard';
import { getToolStatus, type ToolBlock } from '../lib/tool-status';
import { ToolPill } from './ToolPill';

interface Props {
  tools: ToolBlock[];
  sessionId?: string;
}

export function ToolGroup({ tools, sessionId }: Props) {
  // A single operation already has its own detail disclosure. Show its useful
  // summary directly instead of requiring a second, count-only disclosure.
  if (tools.length === 1) return <ToolPill block={tools[0]} sessionId={sessionId} />;
  const statuses = tools.map(getToolStatus);
  const doneCount = statuses.filter((status) => status.done).length;
  const failedCount = statuses.filter((status) => status.done && status.hasError).length;
  const runningCount = statuses.filter((status) => status.running).length;
  const interruptedCount = statuses.filter((status) => status.interrupted).length;
  const summary =
    runningCount > 0
      ? `${doneCount}/${tools.length} complete · ${runningCount} running`
      : `${tools.length} tool call${tools.length === 1 ? '' : 's'}`;
  const statusSummary = [
    summary,
    interruptedCount > 0 ? `${interruptedCount} interrupted` : '',
    failedCount > 0 ? `${failedCount} failed` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="tool-group">
      <ToolSetupCards tools={tools} sessionId={sessionId} />
      <OperationCard
        title={statusSummary}
        kind="Tool activity"
        icon="layers"
        toggleLabel={statusSummary}
        scope={
          <span className="tool-group-dots">
            {tools.slice(0, 8).map((tool, i) => (
              <span
                key={tool.blockId || i}
                className={`tool-pill-dot ${statuses[i].interrupted ? 'tool-pill-dot--interrupted' : statuses[i].done ? (statuses[i].hasError ? 'tool-pill-dot--error' : 'tool-pill-dot--done') : 'tool-pill-dot--pending'}`}
              />
            ))}
            {tools.length > 8 && <span className="tool-group-dots-more">+{tools.length - 8}</span>}
          </span>
        }
        details={
          <div className="tool-group-list">
            {tools.map((tool, i) => (
              <ToolPill
                key={tool.blockId || i}
                block={tool}
                sessionId={sessionId}
                showSetupCard={false}
              />
            ))}
          </div>
        }
      />
    </div>
  );
}
