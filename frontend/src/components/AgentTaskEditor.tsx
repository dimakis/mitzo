import type { AgentLibraryVersion } from '@mitzo/protocol';
import type { AgentTaskWorkingCopy } from '../lib/agent-task-working-copy';
import { AgentTaskSettings } from './AgentTaskSettings';

export function AgentTaskEditor({
  copy,
  versions,
  update,
  save,
  busy,
}: {
  copy: AgentTaskWorkingCopy;
  versions: AgentLibraryVersion[];
  update(copy: AgentTaskWorkingCopy): void;
  save(): void;
  busy: boolean;
}) {
  const change = (patch: Partial<AgentTaskWorkingCopy>) => {
    if (JSON.stringify({ ...copy, ...patch }) === JSON.stringify(copy)) return;
    update({ ...copy, ...patch, idempotencyKey: crypto.randomUUID(), dirty: true });
  };
  const profile = versions.find(
    (v) =>
      v.profileId === copy.profile.profileId &&
      v.revision === copy.profile.revision &&
      v.contentHash === copy.profile.contentHash,
  );
  const newest = versions
    .filter((v) => v.profileId === copy.profile.profileId)
    .sort((a, b) => b.revision - a.revision)[0];
  return (
    <section className="agent-library-detail" aria-label="Task editor">
      <h2>{copy.expectedRevision ? 'Task settings' : 'Assign a task'}</h2>
      <p>
        {profile?.definition.name ?? copy.profile.profileId} · Profile r{copy.profile.revision}
        {!profile && ' · Unavailable published revision'}
      </p>
      {newest && newest.revision > copy.profile.revision && (
        <p>r{newest.revision} available. Choose it below to update this task deliberately.</p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <fieldset disabled={busy} className="agent-task-fields">
          <label>
            Agent profile
            <select
              value={`${copy.profile.profileId}:${copy.profile.revision}:${copy.profile.contentHash}`}
              onChange={(event) => {
                const v = versions.find(
                  (v) => `${v.profileId}:${v.revision}:${v.contentHash}` === event.target.value,
                );
                if (v)
                  change({
                    profile: {
                      profileId: v.profileId,
                      revision: v.revision,
                      contentHash: v.contentHash,
                    },
                    runtime: {
                      ...copy.runtime,
                      agentProfile: { profileId: v.profileId, revision: v.revision },
                    },
                  });
              }}
            >
              {!profile && (
                <option
                  value={`${copy.profile.profileId}:${copy.profile.revision}:${copy.profile.contentHash}`}
                  disabled
                >
                  {copy.profile.profileId} · r{copy.profile.revision} · Unavailable
                </option>
              )}
              {versions.map((v) => (
                <option
                  key={`${v.profileId}:${v.revision}`}
                  value={`${v.profileId}:${v.revision}:${v.contentHash}`}
                >
                  {v.definition.name} · r{v.revision}
                </option>
              ))}
            </select>
          </label>
          <label>
            Task name
            <input
              value={copy.name}
              maxLength={200}
              onChange={(e) => change({ name: e.target.value })}
            />
          </label>
          <label>
            Objective
            <textarea
              rows={4}
              value={copy.objective}
              maxLength={32000}
              onChange={(e) => change({ objective: e.target.value })}
            />
          </label>
          <label>
            Schedule
            <select
              value={copy.schedule}
              onChange={(e) =>
                change({ schedule: e.target.value as AgentTaskWorkingCopy['schedule'] })
              }
            >
              <option value="manual">Run on demand</option>
              <option value="weekday">Weekdays at 07:00</option>
              <option value="cron">Custom cron</option>
            </select>
          </label>
          {copy.schedule !== 'manual' && (
            <>
              <label>
                Timezone
                <input
                  value={copy.timezone}
                  onChange={(e) => change({ timezone: e.target.value })}
                />
              </label>
              {copy.schedule === 'cron' && (
                <label>
                  Cron expression
                  <input
                    value={copy.cron}
                    placeholder="0 7 * * 1-5"
                    onChange={(e) => change({ cron: e.target.value })}
                  />
                </label>
              )}
              <p>
                Saved paused. Schedule execution and next-run calculation are not available yet.
              </p>
            </>
          )}
          <AgentTaskSettings
            key={copy.taskId}
            id={copy.taskId}
            value={copy.runtime}
            resolveSavedTarget={copy.expectedRevision > 0}
            retainedExecution={copy.execution}
            profileLabel={profile?.definition.name ?? copy.profile.profileId}
            onChange={(runtime, execution) => {
              const choices = (value: typeof runtime) =>
                JSON.stringify({
                  account: value.account,
                  accountReference: value.accountReference ?? null,
                  agentProfile: value.agentProfile,
                  execution: value.execution,
                });
              const nextExecution = execution ? { ...execution, mode: copy.mode } : execution;
              if (
                execution === undefined ||
                (JSON.stringify(nextExecution) === JSON.stringify(copy.execution) &&
                  choices(runtime) === choices(copy.runtime))
              ) {
                // Catalog hydration/review changes no persisted task definition.
                update({ ...copy, runtime });
              } else change({ runtime, execution: nextExecution ?? null });
            }}
            disabled={busy}
          />
          <label>
            Workspace reference
            <input
              value={copy.workspaceId}
              onChange={(e) => change({ workspaceId: e.target.value })}
            />
          </label>
          <label>
            Source references (one per line)
            <textarea
              rows={2}
              value={copy.sourceRefs}
              onChange={(e) => change({ sourceRefs: e.target.value })}
            />
          </label>
          <p>
            Workspace references are saved as intent. They are checked when task execution becomes
            available.
          </p>
          <label>
            Notifications
            <select
              value={copy.notificationPolicy}
              onChange={(e) =>
                change({
                  notificationPolicy: e.target.value as AgentTaskWorkingCopy['notificationPolicy'],
                })
              }
            >
              <option value="results">Results</option>
              <option value="failures">Failures only</option>
              <option value="none">None</option>
            </select>
          </label>
          <div className="agent-library-actions">
            <button type="submit">{busy ? 'Saving task…' : 'Save task'}</button>
            <span>
              {copy.dirty ? 'Unsaved task input' : `Saved task · revision ${copy.expectedRevision}`}
            </span>
          </div>
        </fieldset>
      </form>
      <p>
        Incomplete settings are retained on this device. Execution and schedules are not available
        yet; saving does not start work.
      </p>
    </section>
  );
}
