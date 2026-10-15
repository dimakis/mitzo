import { join } from 'node:path';
import { AgentTaskStore } from './agent-task-store.js';
import { AgentTaskService } from './agent-task-service.js';

let active: { path: string; store: AgentTaskStore; service: AgentTaskService } | undefined;
export function getAgentTasks(): AgentTaskService {
  const path = join(process.env.REPO_PATH || '.', '.mitzo', 'events.db');
  if (!active || active.path !== path) {
    active?.store.close();
    const store = new AgentTaskStore(path);
    active = { path, store, service: new AgentTaskService(store) };
  }
  return active.service;
}
