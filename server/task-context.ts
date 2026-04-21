import type { TaskStore } from './task-store.js';

const SUMMARY_MAX_CHARS = 2000;
const MAX_DEPTH = 5;

/**
 * Build an XML task context block for injection into the system prompt.
 * Per design doc §8.1.
 */
export function buildTaskContextPrompt(store: TaskStore, taskId: string): string | null {
  const task = store.get(taskId);
  if (!task) return null;

  if (task.depth >= MAX_DEPTH) {
    return `<task-context>\n<error>Task depth ${task.depth} exceeds maximum ${MAX_DEPTH}</error>\n</task-context>`;
  }

  const lines: string[] = [];
  lines.push('<task-context>');
  lines.push(`<task id="${task.id}" depth="${task.depth}">`);

  // Parent context
  if (task.parentId) {
    const parent = store.get(task.parentId);
    if (parent) {
      lines.push(`  <parent title="${escapeXml(parent.title)}" />`);
    }
  }

  lines.push(`  <title>${escapeXml(task.title)}</title>`);

  if (task.description) {
    lines.push(`  <description>${escapeXml(task.description)}</description>`);
  }

  if (task.annotations.length > 0) {
    lines.push('  <annotations>');
    for (const a of task.annotations) {
      lines.push(`    <annotation>${escapeXml(a)}</annotation>`);
    }
    lines.push('  </annotations>');
  }

  // Sibling context
  if (task.parentId) {
    const siblings = store.getChildren(task.parentId);
    if (siblings.length > 1) {
      lines.push('  <siblings>');
      for (const s of siblings) {
        const marker = s.id === task.id ? ' current="true"' : '';
        lines.push(
          `    <sibling id="${s.id}" status="${s.status}"${marker}>${escapeXml(s.title)}</sibling>`,
        );
      }
      lines.push('  </siblings>');

      // Completed sibling summaries and artifacts
      const completed = siblings.filter(
        (s) => s.id !== task.id && (s.status === 'done' || s.status === 'skipped'),
      );
      if (completed.length > 0) {
        const withSummaries = completed.filter((s) => s.summary);
        if (withSummaries.length > 0) {
          lines.push('  <completed-siblings>');
          for (const s of withSummaries) {
            const summary = truncate(s.summary!, SUMMARY_MAX_CHARS);
            lines.push(`    <summary task="${escapeXml(s.title)}">`);
            lines.push(`      ${escapeXml(summary)}`);
            lines.push('    </summary>');
          }
          lines.push('  </completed-siblings>');
        }

        // Artifacts from completed siblings — available for reference
        const withArtifacts = completed.filter(
          (s) => s.artifacts && Object.keys(s.artifacts).length > 0,
        );
        if (withArtifacts.length > 0) {
          lines.push('  <sibling-artifacts>');
          for (const s of withArtifacts) {
            for (const [key, value] of Object.entries(s.artifacts!)) {
              lines.push(
                `    <artifact task="${escapeXml(s.title)}" key="${escapeXml(key)}">${escapeXml(String(value))}</artifact>`,
              );
            }
          }
          lines.push('  </sibling-artifacts>');
        }
      }
    }
  }

  lines.push('</task>');
  lines.push('</task-context>');

  return lines.join('\n');
}

/**
 * Build the task board system prompt addition (§8.2).
 */
export function buildTaskSystemPrompt(store: TaskStore, taskId: string): string {
  const context = buildTaskContextPrompt(store, taskId);
  if (!context) return '';

  return (
    '\n\n## Task Board\n\n' +
    'You are working on a task from the task board. ' +
    'Use the TaskSet, TaskComplete, TaskStatus, TaskBlock, and TaskArtifact tools ' +
    'to manage your work.\n\n' +
    '- Call TaskSet to decompose your task into subtasks\n' +
    '- Call TaskComplete with a summary when done\n' +
    '- Call TaskStatus to check progress\n' +
    '- Call TaskBlock if you encounter a blocker\n' +
    '- Call TaskArtifact to store structured output (e.g., PR URLs, file paths) for later stages\n\n' +
    context
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
