// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TelosWorkViewSchema } from '@mitzo/protocol';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import type { Task } from '../../types/task';
import { TelosChatWorkTree } from '../TelosChatWorkTree';
const board = vi.hoisted(() => ({
  tasks: [] as Task[],
  approve: vi.fn(),
  reject: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../../hooks/useTaskBoard', () => ({ useTaskBoard: () => board }));
vi.mock('../../hooks/useTodoData', () => ({ useTodoData: () => ({ items: [], error: null }) }));
const canonical = vi.hoisted(() => ({ records: [] as unknown[] }));
vi.mock('../../hooks/useTelosRecords', () => ({
  useTelosRecords: () => ({ records: canonical.records, unavailable: [], refreshKey: 'canonical' }),
}));
vi.mock('../TelosOutcomesTree', () => ({
  TelosOutcomesTree: ({ records }: { records: Array<{ status: string }> }) => (
    <div data-testid="canonical-outcome-state">{records[0]?.status}</div>
  ),
}));
const worker = '3e215a88-597d-8274-b167-834f0ad87838';
const taskId = '96cae921-4df7-4469-8cf5-9fd02a13001d';
const itemId = 'recording-slice';
const record = {
  ...createTelosWorkFixtures().homeStudio.items[0],
  itemId,
  parentId: null,
  kind: 'work_item' as const,
  status: 'active' as const,
};
const work = TelosWorkViewSchema.parse({
  itemId,
  kind: 'work_item',
  parentId: null,
  revision: 'a'.repeat(64),
  sources: [],
  links: [
    {
      version: 1,
      linkId: 'worker-link',
      itemId,
      role: 'worker',
      conversation: { namespace: 'mitzo', conversationId: worker },
      availability: 'available',
      linkedAt: null,
      linkedBy: null,
      attemptId: null,
    },
  ],
  assignments: [
    {
      itemId,
      role: 'worker',
      conversation: { namespace: 'mitzo', conversationId: worker },
      revision: 1,
      assignedAt: null,
      assignedBy: null,
    },
  ],
  attempts: [
    {
      version: 1,
      requestId: 'request',
      attemptId: '66e92c73-1ba6-4e6f-8d78-208f16e44b46',
      predecessorAttemptId: null,
      leadConversationId: 'lead',
      childItemId: itemId,
      contextSnapshotId: 'snapshot',
      state: 'chat_ready',
      workerConversationId: worker,
      allocationReceiptId: 'allocation',
      executionTaskId: taskId,
      accountingGoalId: null,
      turnCommandId: null,
    },
  ],
});
type Data = ComponentProps<typeof TelosChatWorkTree>['data'];
const data: Data = { itemId, record, work, workCurrent: true, refreshKey: 'current' };
function task(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId,
    parentId: null,
    title: 'Exact recording evidence',
    description: null,
    status: 'pending_review',
    sessionId: null,
    sessionPolicy: 'reuse',
    priority: 0,
    depth: 0,
    annotations: [],
    summary: null,
    requiresApproval: true,
    tokenUsage: 0,
    claimedBy: null,
    claimedAt: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    stageType: null,
    gateConfig: null,
    artifacts: null,
    retryCount: 0,
    maxRetries: 0,
    templateId: null,
    children: [],
    ...overrides,
  };
}
function mount(selected: Data = data) {
  return render(<TelosChatWorkTree conversationId={worker} data={selected} onOpen={vi.fn()} />);
}
function noExecutionRows() {
  expect(document.querySelectorAll('.telos-chat-execution')).toHaveLength(0);
}
beforeEach(() => {
  board.tasks = [];
  canonical.records = [record];
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  expect(board.approve).not.toHaveBeenCalled();
  expect(board.reject).not.toHaveBeenCalled();
  expect(board.create).not.toHaveBeenCalled();
  expect(board.update).not.toHaveBeenCalled();
});
it('shows the exact attempt-associated pending task with NULL legacy identity without backfilling or selecting unrelated NULL tasks', () => {
  const selected = Object.freeze(task());
  board.tasks = [selected, task({ id: 'unrelated-task', title: 'Unrelated pending task' })];
  mount();
  expect(screen.getByText('Awaiting review · Exact recording evidence')).toBeTruthy();
  expect(screen.queryByText(/Unrelated pending task/)).toBeNull();
  expect(selected.sessionId).toBeNull();
  expect(selected.claimedBy).toBeNull();
  expect(selected.claimedAt).toBeNull();
});
it('reads done from the same NULL-associated task while the canonical outcome remains active', () => {
  board.tasks = [task({ status: 'done' })];
  mount();
  expect(screen.getByText('Task done · Exact recording evidence')).toBeTruthy();
  expect(screen.getByTestId('canonical-outcome-state').textContent).toBe('active');
});
it('preserves the existing exact non-NULL legacy worker association', () => {
  board.tasks = [task({ sessionId: worker })];
  mount();
  expect(screen.getByText('Awaiting review · Exact recording evidence')).toBeTruthy();
});
it('refuses contradictory non-NULL legacy identity even if it matches the replacement assignment', () => {
  board.tasks = [task({ sessionId: 'replacement-worker' })];
  mount({
    ...data,
    work: {
      ...work,
      assignments: [
        {
          ...work.assignments[0],
          conversation: { namespace: 'mitzo', conversationId: 'replacement-worker' },
        },
      ],
    },
  });
  noExecutionRows();
});
it('refuses a missing attempt or missing execution task ID', () => {
  board.tasks = [task({ sessionId: worker })];
  for (const attempts of [[], [{ ...work.attempts[0], executionTaskId: null }]]) {
    const view = mount({ ...data, work: { ...work, attempts } });
    noExecutionRows();
    view.unmount();
  }
});
it('refuses attempts for a foreign child or original worker despite a plausible legacy session', () => {
  board.tasks = [task({ sessionId: worker })];
  for (const attempt of [
    { ...work.attempts[0], childItemId: 'foreign-child' },
    { ...work.attempts[0], workerConversationId: 'foreign-worker' },
  ]) {
    const view = mount({ ...data, work: { ...work, attempts: [attempt] } });
    noExecutionRows();
    view.unmount();
  }
});
it('refuses missing/foreign task IDs and omitted or empty legacy identity instead of treating them as explicit NULL', () => {
  for (const tasks of [
    [],
    [task({ id: 'foreign-task', sessionId: worker })],
    [task({ sessionId: undefined })],
    [task({ sessionId: '' })],
  ]) {
    board.tasks = tasks;
    const view = mount();
    noExecutionRows();
    view.unmount();
  }
});
it('retains nested read-only original-attempt attribution without substituting the current assignment or changing input records', () => {
  const selected = task();
  Object.freeze(selected.children);
  Object.freeze(selected);
  board.tasks = [task({ id: 'foreign-parent', title: 'Other board task', children: [selected] })];
  const before = JSON.stringify(board.tasks);
  mount({
    ...data,
    workCurrent: false,
    work: {
      ...work,
      assignments: [
        {
          ...work.assignments[0],
          conversation: { namespace: 'mitzo', conversationId: 'replacement-worker' },
        },
      ],
    },
  });
  expect(screen.getByText('Awaiting review · Exact recording evidence')).toBeTruthy();
  expect(screen.queryByText(/Other board task/)).toBeNull();
  expect(JSON.stringify(board.tasks)).toBe(before);
});
