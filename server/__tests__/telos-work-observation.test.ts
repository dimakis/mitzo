import { expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { observeWorkConversation, telosWorkContext } from '../telos-work-observation.js';
import { TelosWorkViewSchema, type SessionRuntimeBinding } from '@mitzo/protocol';

it.each([
  ['codex', 'openai-codex', 'openshell'],
  ['claude-sdk', 'anthropic-claude', 'local'],
  ['responses', 'openai', 'local'],
  ['gemini', 'google-vertex', 'local'],
] as const)(
  'observes %s on %s/%s independently without claiming it is running',
  (engine, provider, location) => {
    const events = new EventStore(':memory:');
    try {
      const binding = {
        version: 2,
        account: { accountId: 'offline', provider, profileRevision: 'r1' },
        harness: { implementation: engine },
        execution: { location, targetId: 'fixture', targetRevision: 'r1' },
      } satisfies SessionRuntimeBinding;
      events.createSessionWithRuntimeBinding(
        {
          sessionId: 'worker',
          summary: 'Architecture',
          agentName: 'Architect',
          repositoryWorkspaceId: 'offline-workspace',
          cwd: '/offline/workspace',
          accountBinding: { ...binding.account, accountLabel: 'Offline', model: 'fixture-model' },
        },
        binding,
      );
      expect(observeWorkConversation(events, 'worker')).toMatchObject({
        name: 'Architecture',
        agentName: 'Architect',
        engine,
        executionLocation: location,
        runtimeState: 'not_live',
      });
      expect(events.getOrdinaryInitialCommandId('worker')).toBeUndefined();
      const work = TelosWorkViewSchema.parse({
        itemId: 'slice',
        kind: 'work_item',
        parentId: 'feature',
        revision: 'a'.repeat(64),
        links: [],
        sources: [],
        assignments: [],
        attempts: [],
      });
      expect(telosWorkContext(work, events).startExistingWorker).toMatchObject({
        supported: false,
        reason: 'worker_setup_required',
      });
    } finally {
      events.close();
    }
  },
);

it('does not substitute a historical allocation for the current worker and keeps runtime read failure visible', () => {
  const events = new EventStore(':memory:');
  try {
    events.upsertSession({ sessionId: 'current', summary: 'Current architecture worker' });
    const work = TelosWorkViewSchema.parse({
      itemId: 'slice',
      kind: 'work_item',
      parentId: 'feature',
      revision: 'a'.repeat(64),
      links: [],
      sources: [],
      assignments: [
        {
          itemId: 'slice',
          role: 'worker',
          conversation: { namespace: 'mitzo', conversationId: 'current' },
          revision: 2,
          assignedAt: null,
          assignedBy: null,
        },
      ],
      attempts: [
        {
          version: 1,
          requestId: 'original-request',
          attemptId: 'old-attempt',
          predecessorAttemptId: null,
          leadConversationId: 'lead',
          childItemId: 'slice',
          contextSnapshotId: 'context',
          state: 'chat_ready',
          workerConversationId: 'previous',
          allocationReceiptId: 'receipt',
          executionTaskId: null,
          accountingGoalId: null,
          turnCommandId: null,
        },
      ],
    });
    vi.spyOn(events, 'getSessionRuntimeBinding').mockImplementation(() => {
      throw Error('offline read failed');
    });
    const context = telosWorkContext(work, events);
    expect(context.currentWorker).toMatchObject({
      conversationId: 'current',
      name: 'Current architecture worker',
      assignmentRevision: 2,
      runtimeState: 'unknown',
      runtimeUnavailable: true,
    });
    expect(context.latestAllocation?.workerConversationId).toBe('previous');
    expect(context.startExistingWorker).toMatchObject({
      supported: false,
      conversationId: 'current',
      reason: 'current_worker_differs_from_allocation',
    });
  } finally {
    vi.restoreAllMocks();
    events.close();
  }
});
