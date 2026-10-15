import { AgentTaskError, type AgentTaskStore } from './agent-task-store.js';

/** Shared UI/builder boundary. Saving intent does not qualify execution or
 * authorize recurring work. Admission and scheduling consume this owner later. */
export class AgentTaskService {
  constructor(private readonly store: AgentTaskStore) {}
  list(owner: string) {
    return this.store.list(owner);
  }
  read(owner: string, taskId: string) {
    const task = this.store.get(owner, taskId);
    if (!task) throw new AgentTaskError('Task not found', 404);
    return task;
  }
  save(owner: string, input: unknown) {
    return this.store.save(owner, input);
  }
  remove(owner: string, input: unknown) {
    return this.store.remove(owner, input);
  }
}
