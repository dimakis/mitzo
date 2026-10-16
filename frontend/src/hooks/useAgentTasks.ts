import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { AgentTaskRecordSchema, SaveAgentTaskSchema, type AgentTaskRecord } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import {
  AGENT_TASK_SAVED,
  acknowledgeAgentTaskSave,
  type AgentTaskSavedEvent,
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
  const pendingReceipts = useRef(new Map<string, AgentTaskRecord>());
  const update = useCallback((next: AgentTaskWorkingCopy | null) => {
    const retained = next && loadAgentTaskWorkingCopy(next.taskId);
    if (next && retained && retained.expectedRevision > next.expectedRevision)
      next = {
        ...next,
        expectedRevision: retained.expectedRevision,
        idempotencyKey: crypto.randomUUID(),
      };
    setStorageError(
      saveAgentTaskWorkingCopy(next)
        ? ''
        : 'Could not save task input on this device. Keep this page open and retry.',
    );
    setCopy(next);
  }, []);
  const refresh = useCallback(async () => {
    const generation = ++listGeneration.current;
    // A read started after an acknowledgement observes that committed revision.
    pendingReceipts.current.clear();
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch('/api/agent-tasks');
      const body = await response.json();
      if (!response.ok) throw Error(body.error || 'Tasks unavailable');
      const rows = z.array(AgentTaskRecordSchema).parse(body);
      const receipts = [...pendingReceipts.current.values()];
      if (live.current && generation === listGeneration.current)
        setTasks((known) => {
          if (!live.current || generation !== listGeneration.current) return known;
          const merged = new Map(rows.map((row) => [row.taskId, row]));
          for (const receipt of receipts) {
            const current = known?.find((row) => row.taskId === receipt.taskId);
            const saved = current && current.revision > receipt.revision ? current : receipt;
            const fetched = merged.get(saved.taskId);
            if (!fetched || fetched.revision < saved.revision) merged.set(saved.taskId, saved);
          }
          return [...merged.values()];
        });
    } catch (cause) {
      if (live.current && generation === listGeneration.current)
        setError(cause instanceof Error ? cause.message : 'Tasks unavailable');
    } finally {
      if (live.current && generation === listGeneration.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    live.current = true;
    const receive = (event: Event) => {
      const { record, stored } = (event as CustomEvent<AgentTaskSavedEvent>).detail;
      const current = loadAgentTaskWorkingCopy();
      setCopy(current);
      const prior = pendingReceipts.current.get(record.taskId);
      if (!prior || prior.revision < record.revision)
        pendingReceipts.current.set(record.taskId, record);
      setTasks((rows) => {
        const known = rows?.find((task) => task.taskId === record.taskId);
        return known && known.revision > record.revision
          ? rows
          : [record, ...(rows ?? []).filter((task) => task.taskId !== record.taskId)];
      });
      if (current?.taskId === record.taskId) {
        setError('');
        setStorageError(
          stored ? '' : 'Could not save task input on this device. Keep this page open and retry.',
        );
        setNotice(
          current.dirty
            ? 'Earlier task changes saved. Newer input is retained.'
            : 'Task saved. Execution is not available yet.',
        );
      }
    };
    window.addEventListener(AGENT_TASK_SAVED, receive);
    // Catch an acknowledgement delivered between the render and subscription.
    setCopy(loadAgentTaskWorkingCopy());
    void refresh();
    return () => {
      live.current = false;
      window.removeEventListener(AGENT_TASK_SAVED, receive);
    };
  }, [refresh]);
  const save = async () => {
    if (!copy || inFlight.current) return;
    const current = loadAgentTaskWorkingCopy();
    const savingCopy = current?.taskId === copy.taskId ? current : copy;
    setError('');
    setNotice('');
    let request;
    try {
      request = SaveAgentTaskSchema.parse({
        taskId: savingCopy.taskId,
        expectedRevision: savingCopy.expectedRevision,
        idempotencyKey: savingCopy.idempotencyKey,
        definition: {
          name: savingCopy.name,
          objective: savingCopy.objective,
          profile: savingCopy.profile,
          execution: savingCopy.execution,
          workspace: savingCopy.workspaceId.trim()
            ? {
                workspaceId: savingCopy.workspaceId,
                sourceRefs: savingCopy.sourceRefs
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean),
              }
            : null,
          schedule:
            savingCopy.schedule === 'manual'
              ? null
              : {
                  cron: savingCopy.schedule === 'weekday' ? '0 7 * * 1-5' : savingCopy.cron,
                  timezone: savingCopy.timezone,
                  state: 'paused',
                },
          notificationPolicy: savingCopy.notificationPolicy,
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
        savingCopy.expectedRevision === 0
          ? '/api/agent-tasks'
          : `/api/agent-tasks/${encodeURIComponent(taskId)}`,
        {
          method: savingCopy.expectedRevision === 0 ? 'POST' : 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(savingCopy.expectedRevision === 0 ? request : replacement),
        },
      );
      const body = await response.json();
      if (!response.ok) throw Error(body.error || 'Task save failed');
      const saved = AgentTaskRecordSchema.parse(body);
      acknowledgeAgentTaskSave(savingCopy, saved);
    } catch (cause) {
      const latest = loadAgentTaskWorkingCopy(savingCopy.taskId);
      if (live.current && (!latest || latest.expectedRevision <= savingCopy.expectedRevision))
        setError(cause instanceof Error ? cause.message : 'Task save failed');
    } finally {
      inFlight.current = false;
      if (live.current) setBusy(false);
    }
  };
  return { tasks, copy, update, error, notice, storageError, busy, loading, refresh, save };
}
