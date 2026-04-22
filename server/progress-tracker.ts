/**
 * Progress tracker — intercepts TodoWrite tool calls and emits structured
 * progress events for the frontend ProgressWidget.
 *
 * Observe-only: TodoWrite still reaches the SDK normally. This module
 * watches the tool input, diffs against previous state, and produces
 * sideband WS events (progress_start, progress_update, progress_replace).
 */

import type { ProgressItem, ProgressItemStatus } from '@mitzo/protocol';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TodoWriteItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

interface TodoWriteInput {
  todos: TodoWriteItem[];
}

export interface ProgressEvent {
  type: 'progress_start' | 'progress_update' | 'progress_replace';
  [key: string]: unknown;
}

// ─── Status mapping ─────────────────────────────────────────────────────────

function mapStatus(todoStatus: TodoWriteItem['status']): ProgressItemStatus {
  switch (todoStatus) {
    case 'completed':
      return 'done';
    case 'in_progress':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function toProgressItems(todos: TodoWriteItem[]): ProgressItem[] {
  return todos.map((t, i) => ({
    id: String(i),
    title: t.content,
    status: mapStatus(t.status),
  }));
}

// ─── Tracker ────────────────────────────────────────────────────────────────

/**
 * Session-scoped progress tracker. Create one per query-loop invocation.
 * Tracks previous TodoWrite state to emit minimal delta events.
 */
export class ProgressTracker {
  private previousItems: ProgressItem[] | null = null;
  private progressId: string | null = null;

  /**
   * Handle a TodoWrite tool call. Returns progress events to emit, or empty
   * array if the input is not a valid TodoWrite payload.
   */
  handleTodoWrite(
    messageId: string,
    toolId: string,
    inputBuf: string,
  ): ProgressEvent[] {
    let input: TodoWriteInput;
    try {
      input = JSON.parse(inputBuf);
    } catch {
      return [];
    }

    if (!input.todos || !Array.isArray(input.todos)) return [];

    const items = toProgressItems(input.todos);
    const events: ProgressEvent[] = [];

    if (!this.progressId) {
      // First TodoWrite call in this session turn
      this.progressId = `prog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      this.previousItems = items;
      events.push({
        type: 'progress_start',
        v: 2,
        messageId,
        progressId: this.progressId,
        sourceToolId: toolId,
        items,
      });
      return events;
    }

    // Subsequent call — check if we can emit deltas or need a full replace
    const prev = this.previousItems!;

    // If the list structure changed (different length or different IDs/titles),
    // emit a full replace.
    const structureChanged =
      items.length !== prev.length ||
      items.some((item, i) => item.title !== prev[i].title);

    if (structureChanged) {
      this.previousItems = items;
      events.push({
        type: 'progress_replace',
        v: 2,
        progressId: this.progressId,
        sourceToolId: toolId,
        items,
      });
      return events;
    }

    // Same structure — emit individual status updates
    for (let i = 0; i < items.length; i++) {
      if (items[i].status !== prev[i].status) {
        events.push({
          type: 'progress_update',
          v: 2,
          progressId: this.progressId,
          itemId: items[i].id,
          status: items[i].status,
        });
      }
    }

    this.previousItems = items;
    return events;
  }

  /** Reset tracker state (call on message_start). */
  reset(): void {
    this.previousItems = null;
    this.progressId = null;
  }
}
