import type { BackgroundTaskObservation } from './types.js';

/** Optional display metadata must not turn malformed historical data into a task. */
export function parseBackgroundTaskObservation(
  value: unknown,
): BackgroundTaskObservation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const task = value as Record<string, unknown>;
  if (
    typeof task.taskId !== 'string' ||
    !task.taskId ||
    task.taskId.length > 2000 ||
    (task.runId !== undefined &&
      (typeof task.runId !== 'string' || !task.runId || task.runId.length > 2000)) ||
    (task.processGeneration !== undefined &&
      (typeof task.processGeneration !== 'string' ||
        !task.processGeneration ||
        task.processGeneration.length > 2000)) ||
    (task.description !== undefined && typeof task.description !== 'string')
  )
    return undefined;
  return {
    taskId: task.taskId,
    ...(typeof task.runId === 'string' ? { runId: task.runId } : {}),
    ...(typeof task.processGeneration === 'string'
      ? { processGeneration: task.processGeneration }
      : {}),
    ...(typeof task.description === 'string'
      ? { description: task.description.slice(0, 2000) }
      : {}),
  };
}

export function sameBackgroundTask(a: BackgroundTaskObservation, b: BackgroundTaskObservation) {
  return (
    a.taskId === b.taskId && a.runId === b.runId && a.processGeneration === b.processGeneration
  );
}
