import { expect, it } from 'vitest';
import { TelosWorkDelegationReceiptSchema } from '../telos-work-delegation.js';
const receipt = () => ({
  version: 1,
  state: 'chat_ready',
  execution: 'not_started',
  workerConversationId: 'worker',
  workerPath: '/chat/worker',
  itemPath: '/todos/child',
  leadPath: '/chat/lead',
  attempt: {
    version: 1,
    requestId: 'request',
    attemptId: 'attempt',
    predecessorAttemptId: null,
    leadConversationId: 'lead',
    childItemId: 'child',
    contextSnapshotId: 'context',
    state: 'chat_ready',
    workerConversationId: 'worker',
    allocationReceiptId: 'allocation',
    executionTaskId: 'task',
    accountingGoalId: null,
    turnCommandId: null,
  },
});
it('requires a coherent exact allocation receipt before reporting chat readiness', () => {
  expect(TelosWorkDelegationReceiptSchema.safeParse(receipt()).success).toBe(true);
  for (const change of [
    { workerConversationId: 'other' },
    { workerPath: '/chat/other' },
    { itemPath: '/todos/sibling' },
    { leadPath: '/chat/other' },
    { attempt: { ...receipt().attempt, state: 'allocation_uncertain' } },
    { attempt: { ...receipt().attempt, executionTaskId: null } },
    { attempt: { ...receipt().attempt, allocationReceiptId: null } },
    { attempt: { ...receipt().attempt, turnCommandId: 'implied-turn' } },
  ])
    expect(
      TelosWorkDelegationReceiptSchema.safeParse({ ...receipt(), ...change }).success,
      JSON.stringify(change),
    ).toBe(false);
});
