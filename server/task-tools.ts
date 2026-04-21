import type { TaskStore, Task, TaskStatus } from './task-store.js';

/**
 * Pure handler functions for task board tools.
 * Each takes a TaskStore + context, returns a result string.
 * Never throws for invalid input — returns error strings.
 */

export interface TaskSetItem {
  title: string;
  description?: string;
  priority?: number;
}

/**
 * Replace current task's children with a new set.
 * Deletes existing children first, then creates new ones.
 */
export function handleTaskSet(
  store: TaskStore,
  currentTaskId: string,
  tasks: TaskSetItem[],
): string {
  const current = store.get(currentTaskId);
  if (!current) return `Error: task ${currentTaskId} not found`;

  if (tasks.length === 0) return 'Error: at least one subtask is required';

  // Delete existing children
  const existingChildren = store.getChildren(currentTaskId);
  for (const child of existingChildren) {
    store.delete(child.id);
  }

  // Create new children
  const created: Task[] = [];
  for (const item of tasks) {
    const task = store.create({
      title: item.title,
      description: item.description,
      parentId: currentTaskId,
      priority: item.priority ?? 0,
    });
    created.push(task);
  }

  return `Created ${created.length} subtask(s) under "${current.title}":\n${created.map((t, i) => `  ${i + 1}. ${t.title}`).join('\n')}`;
}

/**
 * Mark the current task as done (or pending_review if requiresApproval).
 * Stores the summary and cascades status up the tree.
 */
export function handleTaskComplete(
  store: TaskStore,
  currentTaskId: string,
  summary: string,
): string {
  const current = store.get(currentTaskId);
  if (!current) return `Error: task ${currentTaskId} not found`;

  if (!summary.trim()) return 'Error: summary is required';

  const targetStatus: TaskStatus = current.requiresApproval ? 'pending_review' : 'done';

  store.update(currentTaskId, { status: targetStatus, summary });
  store.cascadeStatus(currentTaskId);

  if (targetStatus === 'pending_review') {
    return `Task "${current.title}" marked as pending_review — awaiting approval.`;
  }
  return `Task "${current.title}" completed.`;
}

/**
 * Get formatted status of the current task, siblings, and progress.
 */
export function handleTaskStatus(store: TaskStore, currentTaskId: string): string {
  const current = store.get(currentTaskId);
  if (!current) return `Error: task ${currentTaskId} not found`;

  const lines: string[] = [];
  lines.push(`Current: "${current.title}" [${current.status}]`);

  if (current.description) {
    lines.push(`Description: ${current.description}`);
  }

  if (current.annotations.length > 0) {
    lines.push(`Annotations: ${current.annotations.join(', ')}`);
  }

  // Sibling context
  if (current.parentId) {
    const siblings = store.getChildren(current.parentId);
    const total = siblings.length;
    const done = siblings.filter((s) => s.status === 'done' || s.status === 'skipped').length;
    lines.push(`\nProgress: ${done}/${total} siblings complete`);
    lines.push('Siblings:');
    for (const s of siblings) {
      const marker = s.id === currentTaskId ? '→' : ' ';
      lines.push(`  ${marker} [${s.status}] ${s.title}`);
    }
  }

  return lines.join('\n');
}

/**
 * Mark the current task as blocked with a reason annotation.
 */
export function handleTaskBlock(store: TaskStore, currentTaskId: string, reason: string): string {
  const current = store.get(currentTaskId);
  if (!current) return `Error: task ${currentTaskId} not found`;

  if (!reason.trim()) return 'Error: reason is required';

  const annotations = [...current.annotations, `blocked: ${reason}`];
  store.update(currentTaskId, { status: 'blocked', annotations });
  store.cascadeStatus(currentTaskId);

  return `Task "${current.title}" blocked: ${reason}`;
}

/**
 * Store a structured artifact on the current task.
 * Artifacts are key-value pairs that persist across the workflow.
 */
export function handleTaskArtifact(
  store: TaskStore,
  currentTaskId: string,
  key: string,
  value: string,
): string {
  const current = store.get(currentTaskId);
  if (!current) return `Error: task ${currentTaskId} not found`;

  if (!key.trim()) return 'Error: artifact key is required';

  const artifacts = current.artifacts ? { ...current.artifacts } : {};
  artifacts[key] = value;
  store.update(currentTaskId, { artifacts });

  return `Artifact stored: ${key} = ${value}`;
}
