import { describe, expect, it } from 'vitest';
import { sessionListMetadata, sessionConversationNavigation } from '../session-list-metadata.js';
import { EventStore } from '../event-store.js';
import { retainTelosWorkRoleContext } from '../telos-work-role-context.js';
import { createHash } from 'node:crypto';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { TelosItemStore } from '../telos-item-store.js';
import { TelosWorkStore } from '../telos-work-store.js';

describe('session list metadata', () => {
  it('uses current canonical assignments for every tree level and retains superseded chats at the root', () => {
    const f = createTelosCanonicalData();
    const items = new TelosItemStore(f.dbPath);
    const work = new TelosWorkStore(f.dbPath, { ordinaryConversation: () => true });
    try {
      items.editGuarded(
        {
          itemId: 'studio',
          requestId: 'classify-outcome',
          expectedRevision: items.read('studio').revision,
          workLevel: 'outcome',
          note: 'Shared result',
        },
        'planning',
        () => {},
      );
      const feature = items.createChildGuarded(
        {
          parentId: 'studio',
          expectedParentRevision: items.read('studio').revision,
          requestId: 'feature',
          summary: 'Monitoring',
          intent: 'Monitor PRs',
          rationale: 'Report progress',
          acceptanceCriteria: ['Reports are delivered'],
          note: 'Feature',
        },
        'planning',
        () => {},
        () => items.assertLifecycleActive('studio'),
      ).item;
      const slice = items.createChildGuarded(
        {
          parentId: feature.id,
          expectedParentRevision: items.read(feature.id).revision,
          requestId: 'slice',
          summary: 'Architecture',
          intent: 'Define contract',
          rationale: 'Unblock implementation',
          acceptanceCriteria: ['Contract is reviewed'],
          note: 'Slice',
        },
        'planning',
        () => {},
        () => items.assertLifecycleActive(feature.id),
      ).item;
      const binding = {
        accountId: 'offline',
        accountLabel: 'Offline',
        provider: 'openai-codex',
        profileRevision: 'r1',
        model: 'offline',
      };
      const assign = (itemId: string, role: 'lead' | 'worker', id: string, revision = 0) => {
        f.events.upsertSession({ sessionId: id, summary: id, accountBinding: binding });
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
        const text = JSON.stringify({ summary: items.read(itemId).summary });
        retainTelosWorkRoleContext(f.events, id, binding, {
          version: 1,
          itemId,
          role,
          ...(role === 'worker' ? { leadConversationId: 'feature' } : {}),
          brief: { revision: 'r1', text, sha256: createHash('sha256').update(text).digest('hex') },
          parentCriteria: [],
          overallGoal: { itemId: 'studio', revision: 'r1', text: 'Shared result' },
          sources: [],
          artifacts: [],
        });
      };
      assign('studio', 'lead', 'outcome');
      assign(feature.id, 'lead', 'feature');
      assign(slice.id, 'worker', 'old-worker');
      const read = (id: string) => ({ work: work.read(id, f.actor), item: items.read(id) });
      expect(sessionConversationNavigation(f.events, 'outcome', undefined, read)).toMatchObject({
        workRole: { level: 'outcome', assignment: 'current' },
      });
      expect(sessionConversationNavigation(f.events, 'feature', undefined, read)).toMatchObject({
        parentConversationId: 'outcome',
        workRole: { level: 'feature', assignment: 'current' },
      });
      expect(sessionConversationNavigation(f.events, 'old-worker', undefined, read)).toMatchObject({
        parentConversationId: 'feature',
        workRole: { level: 'slice', assignment: 'current' },
      });
      assign(slice.id, 'worker', 'new-worker', 1);
      expect(sessionConversationNavigation(f.events, 'new-worker', undefined, read)).toMatchObject({
        parentConversationId: 'feature',
        workRole: { assignment: 'current' },
      });
      const old = sessionConversationNavigation(f.events, 'old-worker', undefined, read);
      expect(old).toMatchObject({ workRole: { assignment: 'previous' } });
      expect(old).not.toHaveProperty('parentConversationId');
    } finally {
      work.close();
      items.close();
      f.close();
    }
  });
  it('projects a named worker under its lead without granting execution and preserves an explicit rename', () => {
    const events = new EventStore(':memory:');
    try {
      const binding = {
        accountId: 'offline',
        accountLabel: 'Offline',
        provider: 'openai-codex' as const,
        profileRevision: 'r1',
        model: 'offline',
      };
      events.upsertSession({
        sessionId: 'lead',
        summary: 'PR monitoring',
        accountBinding: binding,
      });
      events.upsertSession({ sessionId: 'worker', accountBinding: binding });
      const text = JSON.stringify({ summary: 'Architecture contract' });
      retainTelosWorkRoleContext(events, 'worker', binding, {
        version: 1,
        itemId: 'slice',
        role: 'worker',
        leadConversationId: 'lead',
        brief: { revision: 'r1', text, sha256: createHash('sha256').update(text).digest('hex') },
        parentCriteria: [],
        overallGoal: { itemId: 'feature', revision: 'r1', text: 'PR monitoring' },
        sources: [],
        artifacts: [],
      });
      expect(sessionConversationNavigation(events, 'worker')).toEqual({
        summary: 'Architecture contract',
        parentConversationId: 'lead',
        parentConversationTitle: 'PR monitoring',
        parentRelationship: 'retained_setup',
      });
      expect(events.getOrdinaryInitialCommandId('worker')).toBeUndefined();
      events.upsertSession({ sessionId: 'worker', summary: 'My chosen title' });
      events.markManuallyRenamed('worker');
      expect(sessionConversationNavigation(events, 'worker')).not.toHaveProperty('summary');
      events.hideSession('lead');
      expect(sessionConversationNavigation(events, 'worker')).not.toHaveProperty(
        'parentConversationId',
      );
    } finally {
      events.close();
    }
  });
  const accountBinding = {
    accountId: 'personal',
    accountLabel: 'Personal',
    provider: 'openai-codex',
    model: 'gpt-6-sol',
    profileRevision: 'r1',
  };
  it('shows the saved model choice rather than the original binding model or engine', () => {
    expect(
      sessionListMetadata({ accountBinding, selectedModel: 'gpt-6.1-sol' }, null),
    ).toMatchObject({ model: 'gpt-6.1-sol', accountLabel: 'Personal' });
  });
  it('uses the recorded binding model for histories without a picker choice', () => {
    expect(sessionListMetadata({ accountBinding }, null)).toMatchObject({ model: 'gpt-6-sol' });
    expect(sessionListMetadata({}, null).model).toBeUndefined();
  });
  it('applies account aliases by ID without using a different account’s model', () => {
    expect(
      sessionListMetadata({ accountBinding, selectedModel: 'gpt-6.1-sol' }, null, (id, fallback) =>
        id === 'personal' ? 'Home' : fallback,
      ),
    ).toMatchObject({ model: 'gpt-6.1-sol', accountLabel: 'Home' });
  });
  it('exposes measured context separately from cumulative usage and retains the exact work link', () => {
    expect(
      sessionListMetadata(
        { telosTaskId: 'task-one', cwd: '/work/mgmt' },
        {
          payload: {
            agentContext: 48000,
            tokenLimits: { model: 'example', source: 'runtime', contextWindow: 200000 },
          },
          createdAt: 123,
        },
      ),
    ).toEqual({
      modelObservedAt: expect.any(Number),
      telosTaskId: 'task-one',
      cwd: '/work/mgmt',
      contextUsage: {
        used: 48000,
        measuredAt: 123,
        limits: { model: 'example', source: 'runtime', contextWindow: 200000, stale: false },
      },
    });
  });
  it('does not turn cumulative tokens or an unmeasured zero into context occupancy', () => {
    expect(
      sessionListMetadata({}, { payload: { sessionTotal: 990000, agentContext: 0 }, createdAt: 1 })
        .contextUsage?.used,
    ).toBeNull();
    expect(sessionListMetadata({}, null).contextUsage).toBeUndefined();
  });
  it('does not trust malformed capacity evidence', () => {
    expect(
      sessionListMetadata(
        {},
        {
          payload: { agentContext: 48000, tokenLimits: { source: 'runtime', contextWindow: -1 } },
          createdAt: 1,
        },
      ).contextUsage?.limits,
    ).toBeNull();
  });
});
