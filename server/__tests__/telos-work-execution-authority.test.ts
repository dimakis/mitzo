import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type {
  AccountBinding,
  TelosWorkAttempt,
  TelosWorkRoleContextSelection,
} from '@mitzo/protocol';
import {
  retainTelosWorkRoleContext,
  resolveTelosWorkRoleContext,
} from '../telos-work-role-context.js';
import {
  assertTelosWorkExecutionAuthority,
  resolveTelosWorkTaskToolContext,
} from '../telos-work-execution-authority.js';
const account: AccountBinding = {
  accountId: 'offline',
  accountLabel: 'Offline',
  provider: 'openai-codex',
  model: 'offline-luna',
  profileRevision: 'v1',
};
function fixture() {
  const selected: TelosWorkRoleContextSelection = {
    version: 1,
    role: 'worker',
    itemId: 'child',
    leadConversationId: 'lead',
    brief: {
      revision: 'r1',
      text: 'Reviewed child',
      sha256: createHash('sha256').update('Reviewed child').digest('hex'),
    },
    parentCriteria: [],
    overallGoal: { itemId: 'goal', revision: 'r1', text: 'Reviewed goal' },
    sources: [],
    artifacts: [],
  };
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const eventStore = {
    getSessionEvents: () => events,
    append: (_id: string, type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
      return events.length;
    },
  };
  retainTelosWorkRoleContext(eventStore, 'worker', account, selected);
  const mapping = {
    attemptId: 'attempt',
    childItemId: 'child',
    leadConversationId: 'lead',
    workerConversationId: 'worker',
    contextSnapshotId: 'snapshot',
    contextHash: createHash('sha256')
      .update(JSON.stringify(resolveTelosWorkRoleContext(eventStore, 'worker', account)))
      .digest('hex'),
  };
  const attempt: TelosWorkAttempt = {
    version: 1,
    requestId: 'request',
    attemptId: 'attempt',
    predecessorAttemptId: null,
    leadConversationId: 'lead',
    childItemId: 'child',
    contextSnapshotId: 'snapshot',
    state: 'chat_ready',
    workerConversationId: 'worker',
    allocationReceiptId: 'receipt',
    executionTaskId: 'task',
    accountingGoalId: null,
    turnCommandId: null,
  };
  const getTelosExecutionBinding = vi.fn(() => mapping);
  const executionTaskBinding = vi.fn(() => attempt);
  const work = vi.fn(() => ({ executionTaskBinding }));
  const owners = { events: eventStore, tasks: { getTelosExecutionBinding }, work };
  return { owners, events, mapping, attempt, work, executionTaskBinding, getTelosExecutionBinding };
}
it('requires retained worker context and matching durable task and work owners without mutating them', () => {
  const f = fixture();
  const before = JSON.stringify(f.events);
  expect(() =>
    assertTelosWorkExecutionAuthority(f.owners, 'worker', account, 'task'),
  ).not.toThrow();
  expect(f.executionTaskBinding).toHaveBeenCalledWith('task', 'worker');
  expect(JSON.stringify(f.events)).toBe(before);
  for (const key of [
    'attemptId',
    'childItemId',
    'leadConversationId',
    'contextSnapshotId',
    'workerConversationId',
    'executionTaskId',
  ] as const) {
    const prior = f.attempt[key];
    f.attempt[key] = 'wrong';
    expect(() => assertTelosWorkExecutionAuthority(f.owners, 'worker', account, 'task')).toThrow();
    f.attempt[key] = prior;
  }
  expect(() =>
    assertTelosWorkExecutionAuthority(
      { ...f.owners, work: () => ({ executionTaskBinding: () => null }) },
      'worker',
      account,
      'task',
    ),
  ).toThrow();
  expect(() =>
    assertTelosWorkExecutionAuthority(f.owners, 'other-worker', account, 'task'),
  ).toThrow();
  f.mapping.contextHash = '0'.repeat(64);
  expect(() => assertTelosWorkExecutionAuthority(f.owners, 'worker', account, 'task')).toThrow();
  f.events.splice(0);
  expect(() => assertTelosWorkExecutionAuthority(f.owners, 'worker', account, 'task')).toThrow();
});
it('preserves ordinary S4 behavior without opening Telos for unbound tasks', () => {
  const f = fixture();
  const owners = { ...f.owners, tasks: { getTelosExecutionBinding: () => null } };
  expect(() => assertTelosWorkExecutionAuthority(owners, 'worker', account, 'task')).toThrow();
  f.events.splice(0);
  expect(() =>
    assertTelosWorkExecutionAuthority(owners, 'ordinary', undefined, 'task'),
  ).not.toThrow();
  expect(f.work).not.toHaveBeenCalled();
});

it('binds task tool requests to the captured worker and task before checking mutable client ownership', () => {
  const f = fixture();
  const current = { sessionId: 'worker', taskId: 'task', accountBinding: account };
  expect(
    resolveTelosWorkTaskToolContext(f.owners, current, { sessionId: 'worker', taskId: 'task' }),
  ).toBe('task');
  f.work.mockClear();
  for (const expected of [
    { sessionId: undefined, taskId: undefined },
    { sessionId: 'previous-worker', taskId: 'task' },
    { sessionId: 'worker', taskId: 'previous-task' },
  ])
    expect(resolveTelosWorkTaskToolContext(f.owners, current, expected)).toBeNull();
  expect(f.work).not.toHaveBeenCalled();
  expect(
    resolveTelosWorkTaskToolContext(
      f.owners,
      { ...current, sessionId: 'replacement-worker', taskId: 'replacement-task' },
      { sessionId: 'worker', taskId: 'task' },
    ),
  ).toBeNull();
  expect(f.work).not.toHaveBeenCalled();
});
