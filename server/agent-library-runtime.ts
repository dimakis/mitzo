import { join } from 'node:path';
import { AgentLibraryStore } from './agent-library-store.js';

let active: { path: string; store: AgentLibraryStore } | undefined;
export function getAgentLibrary(): AgentLibraryStore {
  const path = join(process.env.REPO_PATH || '.', '.mitzo', 'events.db');
  if (!active || active.path !== path) {
    active?.store.close();
    active = { path, store: new AgentLibraryStore(path) };
  }
  return active.store;
}
