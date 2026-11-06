import { TaskExecutionStore } from './task-execution-store.js';
let active: TaskExecutionStore | undefined;
export function initializeTaskExecution(path: string) {
  if (active) throw Error('Task execution authority is already initialized');
  active = new TaskExecutionStore(path);
  return active;
}
export function getTaskExecutionStore(): TaskExecutionStore {
  if (!active) throw Error('Task execution authority is not available on this controller');
  return active;
}
export function closeTaskExecution() {
  active?.close();
  active = undefined;
}
