import type { AgentLibraryVersion } from '@mitzo/protocol';
import type { ReactNode } from 'react';
import type { AgentTaskWorkingCopy } from '../lib/agent-task-working-copy';
import { AgentTaskSettings } from './AgentTaskSettings';

export function AgentTaskEditor({
  copy,
  versions,
  update,
  save,
  busy,
  disabled = false,
  onClose,
  footerActions,
}: {
  copy: AgentTaskWorkingCopy;
  versions: AgentLibraryVersion[];
  update(copy: AgentTaskWorkingCopy): void;
  save(): void;
  busy: boolean;
  disabled?: boolean;
  onClose?(): void;
  footerActions?: ReactNode;
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
    <section className="agent-library-detail agent-task-editor" aria-label="Task editor">
      <header className="agent-task-editor-heading">
        <div>
          <h2>{copy.expectedRevision ? 'Task settings' : 'Assign a task'}</h2>
          <p>
            {profile?.definition.name ?? copy.profile.profileId} · Profile r{copy.profile.revision}
            {!profile && ' · Unavailable published revision'}
          </p>
        </div>
        {onClose && (
          <button type="button" aria-label="Close task editor" disabled={busy} onClick={onClose}>
            Close
          </button>
        )}
      </header>
      {newest && newest.revision > copy.profile.revision && (
        <p>r{newest.revision} available. Choose it below to update this task deliberately.</p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <fieldset disabled={busy || disabled} className="agent-task-fields">
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
                Schedules are saved paused. Execution and next-run calculation are not available
                yet.
              </p>
            </>
          )}
          <AgentTaskSettings
            key={copy.taskId}
            id={copy.taskId}
            value={copy.runtime}
            resolveSavedTarget={copy.execution !== null}
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
            disabled={busy || disabled}
          />
          <p className="agent-task-independent-note">
            This task’s execution settings are independent of the profile and Agent Builder.
          </p>
          <details className="agent-task-advanced">
            <summary>Workspace and notifications</summary>
            <div>
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
                Workspace references are saved as intent. They are checked when task execution
                becomes available.
              </p>
              <label>
                Notifications
                <select
                  value={copy.notificationPolicy}
                  onChange={(e) =>
                    change({
                      notificationPolicy: e.target
                        .value as AgentTaskWorkingCopy['notificationPolicy'],
                    })
                  }
                >
                  <option value="results">Results</option>
                  <option value="failures">Failures only</option>
                  <option value="none">None</option>
                </select>
              </label>
            </div>
          </details>
        </fieldset>
        <footer className="agent-task-editor-footer">
          <div className="agent-task-editor-actions">
            <button type="submit" disabled={busy || disabled}>
              {busy ? 'Saving task…' : 'Save task'}
            </button>
            {onClose && (
              <button type="button" disabled={busy} onClick={onClose}>
                Cancel
              </button>
            )}
          </div>
          {footerActions}
          <span>
            {copy.dirty ? 'Unsaved task input' : `Saved task · revision ${copy.expectedRevision}`}
          </span>
        </footer>
      </form>
      <p className="agent-task-independent-note">
        Saving does not start work. Schedules stay paused.
      </p>
    </section>
  );
}
