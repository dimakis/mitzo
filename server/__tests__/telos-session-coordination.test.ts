import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { TelosWorkStore } from '../telos-work-store.js';
import { TelosItemStore } from '../telos-item-store.js';
import {
  retainTelosWorkRoleContext,
  resolveTelosWorkRoleContext,
} from '../telos-work-role-context.js';
import {
  observeTelosSessionCoordination,
  renderTelosSessionCoordination,
} from '../telos-session-coordination.js';
import { sessionConversationNavigation } from '../session-list-metadata.js';

it('keeps current classification, reporting and discoverable children across reassignment and reconnect without adopting takeover prose', () => {
  const f = createTelosCanonicalData();
  let work = new TelosWorkStore(f.dbPath, {
    ordinaryConversation: (id) => !f.events.getSession(id)?.isHidden,
  });
  const items = new TelosItemStore(f.dbPath);
  try {
    items.editGuarded(
      {
        itemId: 'studio',
        requestId: 'classify',
        expectedRevision: items.read('studio').revision,
        workLevel: 'feature',
        note: 'Feature with direct slices',
      },
      'planning',
      () => {},
    );
    const slice = items.createChildGuarded(
      {
        parentId: 'studio',
        expectedParentRevision: items.read('studio').revision,
        requestId: 'slice',
        summary: 'Restricted skills',
        intent: 'Enforce restrictions',
        rationale: 'Preserve scope',
        acceptanceCriteria: ['Enforced'],
        note: 'Existing child',
      },
      'planning',
      () => {},
      () => {},
    ).item;
    const binding = {
      accountId: 'offline',
      accountLabel: 'Offline',
      provider: 'openai-codex',
      model: 'offline',
      profileRevision: 'r1',
    };
    for (const id of ['lead', 'worker', 'takeover', 'new-lead'])
      f.events.upsertSession({ sessionId: id, summary: id, accountBinding: binding });
    const assign = (itemId: string, role: 'lead' | 'worker', id: string, revision = 0) =>
      work.execute(
        {
          operation: 'setup_role',
          requestId: `assign-${id}`,
          itemId,
          role,
          conversationId: id,
          expectedAssignmentRevision: revision,
          expectedRevision: work.read(itemId, f.actor).revision,
        },
        f.actor,
      );
    assign('studio', 'lead', 'lead');
    assign(slice.id, 'worker', 'worker');
    for (const [id, itemId, role] of [
      ['lead', 'studio', 'lead'],
      ['worker', slice.id, 'worker'],
    ] as const) {
      const text = 'Original reviewed context';
      retainTelosWorkRoleContext(f.events, id, binding, {
        version: 1,
        itemId,
        itemKind: role === 'lead' ? 'coordinator' : 'outcome',
        role,
        brief: {
          revision: 'original',
          text,
          sha256: createHash('sha256').update(text).digest('hex'),
        },
        parentCriteria: [],
        overallGoal: { itemId: 'studio', revision: 'original', text },
        sources: [],
        artifacts: [],
        ...(role === 'worker' ? { leadConversationId: 'lead' } : {}),
      });
    }
    const observe = (id: string) => observeTelosSessionCoordination(f.events, id, work);
    const finishLead = (reason: 'completed' | 'stopped' | 'interrupted') => {
      const { token } = f.events.beginExecution('lead');
      f.events.transitionExecution(token, 'TERMINAL', reason);
    };
    finishLead('completed');
    expect(observe('worker')).toMatchObject({ diagnostic: null });
    for (const reason of ['stopped', 'interrupted'] as const) {
      finishLead(reason);
      expect(observe('worker')).toMatchObject({
        diagnostic: 'assigned_coordinator_unavailable',
      });
    }
    const stopping = f.events.beginExecution('lead').token;
    f.events.transitionExecution(stopping, 'STOPPING');
    expect(observe('worker')).toMatchObject({ diagnostic: 'assigned_coordinator_unavailable' });
    f.events.transitionExecution(stopping, 'TERMINAL', 'stopped');
    finishLead('completed');
    expect(observe('worker')).toMatchObject({
      workLevel: 'slice',
      assignment: 'current',
      reportingTo: { conversationId: 'lead' },
    });
    expect(observe('lead')).toMatchObject({
      workLevel: 'feature',
      children: [
        {
          itemId: slice.id,
          worker: { conversationId: 'worker', startEvidence: { state: 'unknown' } },
        },
      ],
    });
    // A work takeover and stale/missing evidence are not a role assignment or proof of non-start.
    expect(observe('takeover')).toBeUndefined();
    f.events.hideSession('lead');
    expect(observe('worker')).toMatchObject({
      reportingTo: { conversationId: 'lead', availability: 'unavailable' },
      diagnostic: 'assigned_coordinator_unavailable',
    });
    assign('studio', 'lead', 'new-lead', 1);
    work.close();
    work = new TelosWorkStore(
      f.dbPath,
      { ordinaryConversation: (id) => !f.events.getSession(id)?.isHidden },
      true,
    );
    expect(observe('worker')).toMatchObject({
      reportingTo: { conversationId: 'new-lead', assignmentRevision: 2 },
    });
    expect(observe('lead')).toMatchObject({ diagnostic: 'coordination_unavailable' });
    expect(resolveTelosWorkRoleContext(f.events, 'worker', binding)?.leadConversationId).toBe(
      'lead',
    );
    const context = renderTelosSessionCoordination(observe('worker'));
    expect(context).toContain('new-lead');
    expect(context).toContain(
      'created, assigned, admitted, running, received, applied and completed',
    );
    const read = (id: string) => ({ work: work.read(id, f.actor), item: items.read(id) });
    expect(sessionConversationNavigation(f.events, 'worker', undefined, read)).toMatchObject({
      parentConversationId: 'new-lead',
      workRole: { level: 'slice', assignment: 'current' },
    });
    expect(() => work.readConversationCoordination('studio', 'takeover')).toThrow(/authorized/);
  } finally {
    work.close();
    items.close();
    f.close();
  }
});

it('reports canonical observation failure explicitly without inventing or repairing an assignment', () => {
  expect(renderTelosSessionCoordination({ diagnostic: 'coordination_unavailable' })).toContain(
    'coordination_unavailable',
  );
  expect(renderTelosSessionCoordination(undefined)).toBe('');
});
