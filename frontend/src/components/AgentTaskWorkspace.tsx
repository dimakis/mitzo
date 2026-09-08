import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Task, TaskStatus } from '../types/task';

const lanes: { label: string; statuses: TaskStatus[] }[] = [
  { label: 'Needs attention', statuses: ['pending_review', 'blocked', 'failed'] },
  { label: 'Running', statuses: ['active'] },
  { label: 'Queued', statuses: ['pending'] },
  { label: 'Finished', statuses: ['done', 'skipped'] },
];
const labels: Record<TaskStatus, string> = {
  pending: 'Queued',
  active: 'Running',
  done: 'Task complete',
  pending_review: 'Awaiting review',
  blocked: 'Blocked',
  skipped: 'Skipped',
  failed: 'Failed',
};
function collect(tasks: Task[], parentTitle?: string): { task: Task; parentTitle?: string }[] {
  return tasks.flatMap((task) => [{ task, parentTitle }, ...collect(task.children, task.title)]);
}

export function AgentTaskWorkspace({
  tasks,
  selectedId,
  onSelect,
  renderTask,
}: {
  tasks: Task[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  renderTask: (task: Task) => ReactNode;
}) {
  const entries = collect(tasks);
  const selected = entries.find(({ task }) => task.id === selectedId);
  const task = selected?.task;
  return (
    <div className="agent-workspace">
      <div className="agent-lanes">
        {lanes.map((lane) => {
          const members = entries.filter(({ task }) => lane.statuses.includes(task.status));
          return (
            <section className="agent-lane" key={lane.label} aria-label={lane.label}>
              <h2>
                {lane.label}
                <span>{members.length}</span>
              </h2>
              {members.length === 0 && <p className="workspace-muted">No tasks</p>}
              {members.map(({ task, parentTitle }) => (
                <button
                  className={`agent-card agent-card--${task.status}`}
                  key={task.id}
                  aria-label={`${task.title} — ${labels[task.status]}`}
                  aria-current={selectedId === task.id ? 'true' : undefined}
                  onClick={() => onSelect(task.id)}
                >
                  <strong>{task.title}</strong>
                  <span>{labels[task.status]}</span>
                  {parentTitle && <small>Within {parentTitle}</small>}
                  {task.summary && <p>{task.summary}</p>}
                  {(task.status === 'blocked' || task.status === 'failed') &&
                    task.annotations[0] && <p>{task.annotations[0]}</p>}
                  <small>{task.tokenUsage.toLocaleString()} recorded tokens</small>
                </button>
              ))}
            </section>
          );
        })}
      </div>
      <section className="agent-inspector" aria-label="Execution details">
        {task ? (
          <>
            <p className="workspace-muted">Execution details</p>
            <h2>{task.title}</h2>
            <p className={`agent-state agent-state--${task.status}`}>{labels[task.status]}</p>
            {selected.parentTitle && (
              <p className="workspace-muted">Within {selected.parentTitle}</p>
            )}
            {task.description && <p className="agent-description">{task.description}</p>}
            {task.annotations.length > 0 && (
              <section>
                <h3>Context and signals</h3>
                <ul>
                  {task.annotations.map((annotation, i) => (
                    <li key={i}>{annotation}</li>
                  ))}
                </ul>
              </section>
            )}
            <dl className="agent-facts">
              <div>
                <dt>Recorded tokens for this task</dt>
                <dd>{task.tokenUsage.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Session policy</dt>
                <dd>{task.sessionPolicy}</dd>
              </div>
              {task.claimedBy && (
                <div>
                  <dt>Claimed by</dt>
                  <dd>{task.claimedBy}</dd>
                </div>
              )}
              {task.stageType && (
                <div>
                  <dt>Stage</dt>
                  <dd>{task.stageType.replaceAll('_', ' ')}</dd>
                </div>
              )}
            </dl>
            {task.sessionId && (
              <Link className="agent-session-link" to={`/chat/${task.sessionId}`}>
                Open session
              </Link>
            )}
            <p className="workspace-muted">
              Task completion does not verify goal achievement. Token counts reflect recorded task
              usage.
            </p>
            <h3>Task and sub-task controls</h3>
            {renderTask(task)}
          </>
        ) : (
          <div className="agent-inspector-empty">
            <h2>Select an execution</h2>
            <p>
              {selectedId
                ? 'This task is no longer in the current board.'
                : 'Inspect its context, recorded usage and task controls.'}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
