import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AgentTaskDefinitionSchema,
  AgentTaskRecordSchema,
  SaveAgentTaskSchema,
  type AgentLibraryVersion,
  type AgentTaskDefinition,
  type AgentTaskRecord,
} from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import {
  AgentTaskWorkingCopySchema,
  editAgentTask,
  type AgentTaskWorkingCopy,
} from '../lib/agent-task-working-copy';
import { AgentTaskEditor } from './AgentTaskEditor';
import '../styles/agent-library.css';

export type TaskProposal = {
  kind: 'task';
  proposalId: string;
  taskId: string;
  expectedRevision: number;
  definition: AgentTaskDefinition;
  state: 'pending' | 'saved' | 'discarded';
  savedTask?: AgentTaskRecord | null;
};
type SaveRequest = {
  sessionId: string;
  kind: 'task';
  taskId: string;
  expectedRevision: number;
  definition: AgentTaskDefinition;
};
function taskDefinition(copy: AgentTaskWorkingCopy): AgentTaskDefinition {
  return {
    name: copy.name,
    objective: copy.objective,
    profile: copy.profile,
    execution: copy.execution,
    workspace: copy.workspaceId.trim()
      ? {
          workspaceId: copy.workspaceId,
          sourceRefs: copy.sourceRefs
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : null,
    schedule:
      copy.schedule === 'manual'
        ? null
        : {
            cron: copy.schedule === 'weekday' ? '0 7 * * 1-5' : copy.cron,
            timezone: copy.timezone,
            state: 'paused',
          },
    notificationPolicy: copy.notificationPolicy,
    outputPolicy: 'session',
  };
}
const matches = (record: AgentTaskRecord, proposal: TaskProposal, request?: SaveRequest | null) =>
  !record.deleted &&
  record.taskId === proposal.taskId &&
  record.revision === proposal.expectedRevision + 1 &&
  (!request || JSON.stringify(record.definition) === JSON.stringify(request.definition));
function receipt(value: unknown, proposal: TaskProposal, request?: SaveRequest | null) {
  const parsed = AgentTaskRecordSchema.safeParse(value);
  if (!parsed.success || !matches(parsed.data, proposal, request))
    throw Error('Task save receipt is invalid. Your review is retained.');
  return parsed.data;
}
function initialReview(proposal: TaskProposal, sessionId: string, key: string) {
  const fallback = editAgentTask({
    taskId: proposal.taskId,
    revision: proposal.expectedRevision,
    definition: proposal.definition,
  } as AgentTaskRecord);
  fallback.dirty = true;
  try {
    const retained = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    const copy = AgentTaskWorkingCopySchema.safeParse(retained?.copy);
    if (
      !copy.success ||
      copy.data.taskId !== proposal.taskId ||
      copy.data.expectedRevision !== proposal.expectedRevision
    )
      return { copy: fallback, pending: null };
    if (!retained.pending) return { copy: copy.data, pending: null };
    const pending = retained.pending as SaveRequest;
    SaveAgentTaskSchema.parse({
      taskId: pending.taskId,
      expectedRevision: pending.expectedRevision,
      definition: pending.definition,
      idempotencyKey: copy.data.idempotencyKey,
    });
    if (
      pending.sessionId !== sessionId ||
      pending.kind !== 'task' ||
      pending.taskId !== proposal.taskId ||
      pending.expectedRevision !== proposal.expectedRevision
    )
      return { copy: fallback, pending: null };
    return { copy: copy.data, pending };
  } catch {
    return { copy: fallback, pending: null };
  }
}
/** A review card in ordinary chat. The only mutation is its explicit Save/Discard action. */
export function AgentTaskProposal({
  proposal,
  sessionId,
  disabled,
  onDiscard,
}: {
  proposal: TaskProposal;
  sessionId: string;
  disabled: boolean;
  onDiscard(): void;
}) {
  const key = `mitzo-task-proposal-review:${sessionId}:${proposal.proposalId}`;
  const [initial] = useState(() => initialReview(proposal, sessionId, key));
  const [copy, setCopy] = useState(initial.copy);
  const [pending, setPending] = useState<SaveRequest | null>(initial.pending);
  const [saved, setSaved] = useState<AgentTaskRecord | null>(null);
  const [versions, setVersions] = useState<AgentLibraryVersion[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const attempt = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const live = useRef(true);
  const invalidateSave = useCallback(() => {
    attempt.current++;
    controller.current?.abort();
    controller.current = null;
  }, []);
  useEffect(() => {
    live.current = true;
    const abort = new AbortController();
    void apiFetch('/api/agent-library', { signal: abort.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((catalog) => {
        if (!abort.signal.aborted && Array.isArray(catalog?.versions))
          setVersions(catalog.versions);
      })
      .catch(() => {});
    return () => {
      live.current = false;
      invalidateSave();
      abort.abort();
    };
  }, [invalidateSave]);
  useEffect(() => {
    if (!disabled || !controller.current) return;
    invalidateSave();
    setBusy(false);
    setError(
      'Conversation authority changed. The original task save is retained for an authorized retry.',
    );
  }, [disabled, invalidateSave]);
  const retain = (next: AgentTaskWorkingCopy, request: SaveRequest | null) => {
    try {
      sessionStorage.setItem(key, JSON.stringify({ copy: next, pending: request }));
      return true;
    } catch {
      setError('Could not retain this task review on this device. Keep this page open and retry.');
      return false;
    }
  };
  const update = (next: AgentTaskWorkingCopy) => {
    if (busy || disabled || pending || saved) return;
    setCopy(next);
    retain(next, null);
  };
  const save = async () => {
    if (disabled || controller.current || saved) return;
    setError('');
    let request = pending;
    try {
      if (!request)
        request = {
          sessionId,
          kind: 'task',
          taskId: proposal.taskId,
          expectedRevision: proposal.expectedRevision,
          definition: AgentTaskDefinitionSchema.parse(taskDefinition(copy)),
        };
    } catch {
      setError(
        'Check the task name, profile, workspace references, five-field cron and IANA timezone. Your input is retained.',
      );
      return;
    }
    if (!retain(copy, request)) return;
    setPending(request);
    const abort = new AbortController();
    controller.current = abort;
    const generation = ++attempt.current;
    setBusy(true);
    try {
      const response = await apiFetch(
        `/api/symposium/profile-proposals/${encodeURIComponent(proposal.proposalId)}/save`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: abort.signal,
        },
      );
      const body = await response.json();
      if (!live.current || attempt.current !== generation || abort.signal.aborted) return;
      if (!response.ok) {
        if ([400, 404, 409].includes(response.status) && typeof body?.error === 'string') {
          setPending(null);
          retain(copy, null);
        }
        throw Error(body?.error || 'Task save failed');
      }
      setSaved(receipt(body, proposal, request));
      sessionStorage.removeItem(key);
    } catch (cause) {
      if (live.current && attempt.current === generation)
        setError(cause instanceof Error ? cause.message : 'Task save failed');
    } finally {
      if (live.current && attempt.current === generation) {
        controller.current = null;
        setBusy(false);
      }
    }
  };
  const cancel = () => {
    invalidateSave();
    setBusy(false);
    setError(
      'Stopped waiting for the task save. Its outcome is unconfirmed. Retry the original save to recover its receipt.',
    );
  };
  const discard = async () => {
    if (disabled || busy || pending) return;
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch(
        `/api/symposium/profile-proposals/${encodeURIComponent(proposal.proposalId)}/discard`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, kind: 'task' }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw Error(body?.error || 'Task proposal discard failed');
      if (live.current) {
        sessionStorage.removeItem(key);
        onDiscard();
      }
    } catch (cause) {
      if (live.current)
        setError(cause instanceof Error ? cause.message : 'Task proposal discard failed');
    } finally {
      if (live.current) setBusy(false);
    }
  };
  let confirmed = saved;
  if (!confirmed && proposal.state === 'saved') {
    try {
      confirmed = receipt(proposal.savedTask, proposal, pending);
    } catch {
      return (
        <p role="alert">
          Saved task receipt is unavailable. Reload to retry; no task will be resaved.
        </p>
      );
    }
  }
  if (confirmed)
    return (
      <p role="status">
        Saved {confirmed.definition.name} · task {confirmed.taskId} · revision {confirmed.revision}.{' '}
        {confirmed.configuration.state === 'draft'
          ? 'Task draft.'
          : 'Blocked: admission-unavailable.'}{' '}
        {confirmed.definition.schedule && 'Schedule paused. '}Saving does not start work.{' '}
        <a href={`/agent-library?task=${encodeURIComponent(confirmed.taskId)}`}>
          Open Library task
        </a>
      </p>
    );
  return (
    <section
      className="symposium-profile-picker symposium-profile-proposal"
      aria-label="Agent task proposal"
    >
      <p>
        {proposal.expectedRevision
          ? `Review changes to task ${proposal.taskId} at revision ${proposal.expectedRevision}.`
          : 'Task draft for your review. Nothing is saved as a task yet.'}{' '}
        Saving does not start work.
      </p>
      <p>
        Profile {copy.profile.profileId} · revision {copy.profile.revision} · hash{' '}
        {copy.profile.contentHash}
      </p>
      <details>
        <summary>Review exact task definition</summary>
        <pre className="agent-task-proposal-source">
          {JSON.stringify(pending?.definition ?? taskDefinition(copy), null, 2)}
        </pre>
      </details>
      <AgentTaskEditor
        copy={copy}
        versions={versions}
        update={update}
        save={() => void save()}
        busy={busy}
        disabled={disabled || !!pending}
      />
      {pending && !busy && (
        <button type="button" disabled={disabled} onClick={() => void save()}>
          Retry task save
        </button>
      )}
      {pending && (
        <p>
          The original reviewed save is retained until its receipt is confirmed. Task input stays
          locked while its outcome is uncertain.
        </p>
      )}
      {busy && pending && (
        <button type="button" onClick={cancel}>
          Cancel save wait
        </button>
      )}
      <button type="button" disabled={disabled || busy || !!pending} onClick={() => void discard()}>
        Discard task proposal
      </button>
      {error && (
        <p role="alert">
          {error}
          {!pending && (
            <>
              {' '}
              <a href={`/agent-library?task=${encodeURIComponent(proposal.taskId)}`}>
                Review current Library task
              </a>
              . Request a fresh proposal if the saved revision changed.
            </>
          )}
        </p>
      )}
    </section>
  );
}
