import type { UiIconName } from '../components/UiIcon';
import type { TaskStatus } from '../types/task';
import type { TodoItem } from '../types/todo';
import type { SessionActivityState, ProgressItem } from '@mitzo/protocol';

export const taskStatusIcons = {
  pending: 'circle',
  active: 'running',
  done: 'complete',
  pending_review: 'review',
  blocked: 'unavailable',
  skipped: 'minus',
  failed: 'failed',
} satisfies Record<TaskStatus, UiIconName>;

export const outcomeStatusIcons = {
  active: 'running',
  acknowledged: 'eye',
  snoozed: 'clock',
  completed: 'complete',
} satisfies Record<TodoItem['status'], UiIconName>;

export const sessionStatusIcons = {
  init: 'circle',
  working: 'running',
  waiting: 'warning',
  done: 'complete',
  idle: 'circle',
  paused: 'pause',
} satisfies Record<SessionActivityState, UiIconName>;

export const progressStatusIcons = {
  done: 'complete',
  in_progress: 'running',
  pending: 'circle',
} satisfies Record<ProgressItem['status'], UiIconName>;
