import { apiFetch, invalidateTodoReads } from './api-fetch';

export interface ConfirmedTodoPriority {
  id: string;
  priority: number;
}

const writes = new Map<string, Promise<void>>();
const listeners = new Set<(change: ConfirmedTodoPriority) => void>();

/** Shared by legacy collections and canonical record views. Notifications only
 * describe acknowledged writes; canonical owners must fence older reads and
 * reread their record/revision while retaining the confirmed displayed value. */
export function subscribeTodoPriorityUpdates(
  listener: (change: ConfirmedTodoPriority) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Absolute, confirmed-only writes stay ordered across components and remounts. */
export async function setTodoPriority(id: string, priority: number): Promise<void> {
  if (!Number.isInteger(priority) || priority < 1 || priority > 10)
    throw new Error('Priority must be from 1 to 10');
  const write = async () => {
    const response = await apiFetch(`/api/todos/${encodeURIComponent(id)}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'priority', priority }),
    });
    if (!response.ok || (await response.json()).ok !== true)
      throw new Error('Priority change was not confirmed');
    invalidateTodoReads();
    for (const listener of [...listeners]) {
      try {
        listener({ id, priority });
      } catch {
        console.error('Unable to refresh a confirmed Telos priority view');
      }
    }
  };
  const previous = writes.get(id);
  const pending = previous ? previous.catch(() => {}).then(write) : write();
  writes.set(id, pending);
  try {
    await pending;
  } finally {
    if (writes.get(id) === pending) writes.delete(id);
  }
}
