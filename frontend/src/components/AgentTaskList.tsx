import type { AgentTaskRecord, AgentLibraryVersion } from '@mitzo/protocol';
export function AgentTaskList({
  tasks,
  versions,
  onEdit,
  disabled = false,
}: {
  tasks: AgentTaskRecord[];
  versions: AgentLibraryVersion[];
  onEdit(task: AgentTaskRecord): void;
  disabled?: boolean;
}) {
  return (
    <div className="agent-task-list">
      {!tasks.length && <p>No assigned tasks yet.</p>}
      {tasks.map((task) => {
        const d = task.definition;
        const profile = versions.find(
          (v) =>
            v.profileId === d.profile.profileId &&
            v.revision === d.profile.revision &&
            v.contentHash === d.profile.contentHash,
        );
        const latest = Math.max(
          0,
          ...versions.filter((v) => v.profileId === d.profile.profileId).map((v) => v.revision),
        );
        return (
          <article className="agent-task-row" key={task.taskId}>
            <div className="agent-library-heading">
              <h3>{d.name}</h3>
              <span>
                {task.configuration.state === 'draft' ? 'Draft' : 'Blocked · admission unavailable'}
              </span>
            </div>
            <p>{d.objective || 'No objective yet.'}</p>
            <p>
              {profile?.definition.name ?? d.profile.profileId} · r{d.profile.revision} · Task
              revision {task.revision}
            </p>
            <p>
              {d.schedule ? `Paused · ${d.schedule.cron} · ${d.schedule.timezone}` : 'On demand'}
            </p>
            {latest > d.profile.revision && (
              <p>r{latest} available · Review task settings to update.</p>
            )}
            <p>Run history unavailable · Execution is not enabled.</p>
            <button type="button" disabled={disabled} onClick={() => onEdit(task)}>
              Task settings: {d.name}
            </button>
          </article>
        );
      })}
    </div>
  );
}
