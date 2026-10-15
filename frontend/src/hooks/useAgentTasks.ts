import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { AgentTaskRecordSchema, SaveAgentTaskSchema, type AgentTaskRecord } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import {
  loadAgentTaskWorkingCopy,
  saveAgentTaskWorkingCopy,
  type AgentTaskWorkingCopy,
} from '../lib/agent-task-working-copy';

export function useAgentTasks() {
  const [tasks, setTasks] = useState<AgentTaskRecord[] | null>(null);
  const [copy, setCopy] = useState(loadAgentTaskWorkingCopy);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [storageError, setStorageError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const live = useRef(false);
  const inFlight = useRef(false);
  const listGeneration = useRef(0);
  const update = useCallback((next: AgentTaskWorkingCopy | null) => {
    setStorageError(
      saveAgentTaskWorkingCopy(next)
        ? ''
        : 'Could not save task input on this device. Keep this page open and retry.',
    );
    setCopy(next);
  }, []);
  const refresh = useCallback(async () => {
    const generation = ++listGeneration.current;
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch('/api/agent-tasks');
      const body = await response.json();
      if (!response.ok) throw Error(body.error || 'Tasks unavailable');
      const rows = z.array(AgentTaskRecordSchema).parse(body);
      if (live.current && generation === listGeneration.current) setTasks(rows);
    } catch (cause) {
      if (live.current && generation === listGeneration.current)
        setError(cause instanceof Error ? cause.message : 'Tasks unavailable');
    } finally {
      if (live.current && generation === listGeneration.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    live.current = true;
    void refresh();
    return () => {
      live.current = false;
      listGeneration.current++;
    };
  }, [refresh]);
  const save = async () => {
    if (!copy || inFlight.current) return;
    setError('');
    setNotice('');
    let request;
    try {
      request = SaveAgentTaskSchema.parse({
        taskId: copy.taskId,
        expectedRevision: copy.expectedRevision,
        idempotencyKey: copy.idempotencyKey,
        definition: {
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
        },
      });
    } catch {
      setError(
        'Check the task name, profile, workspace references, five-field cron and IANA timezone. Your input is retained.',
      );
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const { taskId, ...replacement } = request;
      const response = await apiFetch(
        copy.expectedRevision === 0
          ? '/api/agent-tasks'
          : `/api/agent-tasks/${encodeURIComponent(taskId)}`,
        {
          method: copy.expectedRevision === 0 ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(copy.expectedRevision === 0 ? request : replacement),
        },
      );
      const body = await response.json();
      if (!response.ok) throw Error(body.error || 'Task save failed');
      const saved = AgentTaskRecordSchema.parse(body);
      // Commit the receipt to device recovery even if navigation unmounted the page.
      const next = {
        ...copy,
        expectedRevision: saved.revision,
        idempotencyKey: crypto.randomUUID(),
        dirty: false,
      };
      const currentCopy = loadAgentTaskWorkingCopy();
      if (currentCopy?.taskId !== copy.taskId || currentCopy.idempotencyKey !== copy.idempotencyKey)
        return;
      saveAgentTaskWorkingCopy(next);
      if (!live.current) return;
      update(next);
      listGeneration.current++;
      setLoading(false);
      setTasks((current) => [saved, ...(current ?? []).filter((t) => t.taskId !== saved.taskId)]);
      setNotice('Task saved. Execution is not available yet.');
    } catch (cause) {
      if (live.current) setError(cause instanceof Error ? cause.message : 'Task save failed');
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  };
  return { tasks, copy, update, error, notice, storageError, busy, loading, refresh, save };
}
