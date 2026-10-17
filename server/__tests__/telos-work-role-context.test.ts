import { expect, it } from 'vitest';
import type { AccountBinding } from '@mitzo/protocol';
import { resolveOrdinaryContributorGuidance } from '../ordinary-contributor-guidance.js';

const binding: AccountBinding = {
  accountId: 'offline',
  accountLabel: 'Offline',
  provider: 'openai-codex',
  model: 'offline-luna',
  profileRevision: 'v1',
};
it('fails admission when retained Telos role context exists without its immutable ordinary guidance', () => {
  const store = {
    getSessionEvents: () => [
      {
        type: 'telos_work_role_context',
        payload: {
          version: 1,
          sessionId: 'lead',
          role: 'lead',
          itemId: 'outcome',
          mandate: 'Coordinate the outcome; delegate child execution to a worker.',
          brief: { revision: 'reviewed-v1', text: 'Reviewed outcome brief.' },
          parentCriteria: [],
          overallGoal: 'Deliver the reviewed outcome.',
          sources: [],
          artifacts: [],
        },
      },
    ],
  };
  expect(() => resolveOrdinaryContributorGuidance(store, 'lead', binding)).toThrow(/role context/i);
});

import { createHash } from 'node:crypto';
import {
  assertTelosWorkTaskExecutionScope,
  retainTelosWorkRoleContext,
  resolveTelosWorkRoleContext,
  type TelosWorkRoleContextSelection,
} from '../telos-work-role-context.js';
function owner() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    getSessionEvents: () => events,
    append: (_id: string, type: string, payload: Record<string, unknown>) => {
      events.push({ type, payload });
      return events.length;
    },
  };
}
function selected(
  role: TelosWorkRoleContextSelection['role'] = 'lead',
): TelosWorkRoleContextSelection {
  const text = 'Reviewed item brief.';
  return {
    version: 1,
    itemId: 'item',
    role,
    brief: { revision: 'brief-1', text, sha256: createHash('sha256').update(text).digest('hex') },
    parentCriteria: [
      { itemId: 'parent', revision: 'parent-1', criteria: ['Reviewed parent criterion'] },
    ],
    overallGoal: { itemId: 'goal', revision: 'goal-1', text: 'Reviewed goal' },
    sources: [],
    artifacts: [],
    ...(role === 'worker' ? { executionTaskId: 'task-1', leadConversationId: 'lead-chat' } : {}),
  };
}
it('restores the exact host-selected context through ordinary guidance without changing its selection', () => {
  const store = owner();
  const input = selected();
  retainTelosWorkRoleContext(store, 'lead', binding, input);
  input.brief.text = 'Later mutable caller bytes';
  expect(resolveTelosWorkRoleContext(store, 'lead', binding)?.brief.text).toBe(
    'Reviewed item brief.',
  );
  expect(resolveOrdinaryContributorGuidance(store, 'lead', binding)).toContain(
    'Reviewed parent criterion',
  );
  expect(() => retainTelosWorkRoleContext(store, 'lead', binding, selected('advisor'))).toThrow(
    /replaced/,
  );
  expect(() =>
    resolveTelosWorkRoleContext(store, 'lead', { ...binding, accountId: 'other' }),
  ).toThrow();
});
it('denies task execution by coordination roles and limits workers to their selected task', () => {
  for (const role of ['lead', 'advisor', 'reviewer'] as const) {
    const store = owner();
    retainTelosWorkRoleContext(store, role, binding, selected(role));
    expect(() => assertTelosWorkTaskExecutionScope(store, role, binding, 'task-1')).toThrow(
      /authorize/,
    );
  }
  const store = owner();
  retainTelosWorkRoleContext(store, 'worker', binding, selected('worker'));
  expect(() => assertTelosWorkTaskExecutionScope(store, 'worker', binding, 'task-1')).not.toThrow();
  expect(() => assertTelosWorkTaskExecutionScope(store, 'worker', binding, 'sibling')).toThrow(
    /authorize/,
  );
  expect(() =>
    assertTelosWorkTaskExecutionScope(owner(), 'ordinary', undefined, 'task'),
  ).not.toThrow();
});
it('rejects changed reviewed bytes and conflicting retained role records', () => {
  const store = owner();
  const changed = selected();
  changed.brief.text = 'Unreviewed';
  expect(() => retainTelosWorkRoleContext(store, 'lead', binding, changed)).toThrow();
  retainTelosWorkRoleContext(store, 'lead', binding, selected());
  store.events.push({
    type: 'telos_work_role_context',
    payload: {
      ...store.events.find((event) => event.type === 'telos_work_role_context')!.payload,
      sessionId: 'other',
    },
  });
  expect(() => resolveTelosWorkRoleContext(store, 'lead', binding)).toThrow();
});
it('fails closed after an interrupted guidance append and repairs the same selection on retry', () => {
  const store = owner();
  const append = store.append;
  let interrupt = true;
  store.append = (id, type, payload) => {
    if (interrupt && store.events.length === 1) throw new Error('Interrupted between appends');
    return append(id, type, payload);
  };
  expect(() => retainTelosWorkRoleContext(store, 'worker', binding, selected('worker'))).toThrow(
    /Interrupted/,
  );
  expect(store.events.map((event) => event.type)).toEqual(['telos_work_role_context']);
  expect(() => resolveOrdinaryContributorGuidance(store, 'worker', binding)).toThrow();
  expect(() => assertTelosWorkTaskExecutionScope(store, 'worker', binding, 'task-1')).toThrow();
  interrupt = false;
  retainTelosWorkRoleContext(store, 'worker', binding, selected('worker'));
  expect(store.events).toHaveLength(2);
  expect(() => assertTelosWorkTaskExecutionScope(store, 'worker', binding, 'task-1')).not.toThrow();
});
it('requires complete matching ordinary guidance before authorizing host execution', () => {
  const store = owner();
  retainTelosWorkRoleContext(store, 'worker', binding, selected('worker'));
  store.events.splice(
    store.events.findIndex((event) => event.type === 'contributor_guidance'),
    1,
  );
  expect(() => assertTelosWorkTaskExecutionScope(store, 'worker', binding, 'task-1')).toThrow();
});
it('requires the independently selected worker lead and retains return references', () => {
  const store = owner();
  const input = selected('worker');
  delete input.leadConversationId;
  expect(() => retainTelosWorkRoleContext(store, 'worker', binding, input)).toThrow(
    /lead conversation/,
  );
  retainTelosWorkRoleContext(store, 'worker', binding, selected('worker'));
  const guidance = resolveOrdinaryContributorGuidance(store, 'worker', binding);
  expect(guidance).toContain('"leadConversationId":"lead-chat"');
  expect(guidance).toContain('"itemReturnPath":"/todos/item"');
  expect(guidance).toContain('"leadReturnPath":"/chat/lead-chat"');
});
it('rejects oversized reviewed context before retaining either role or guidance events', () => {
  const store = owner();
  const input = selected();
  input.brief.text = 'Reviewed bytes '.repeat(10_000);
  input.brief.sha256 = createHash('sha256').update(input.brief.text).digest('hex');
  expect(() => retainTelosWorkRoleContext(store, 'lead', binding, input)).toThrow(/size|exceed/i);
  expect(store.events).toHaveLength(0);
});

import * as protocol from '@mitzo/protocol';
it('exposes the role context shape through the browser-safe shared protocol boundary', () => {
  const shared = Reflect.get(protocol, 'TelosWorkRoleContextSelectionSchema') as
    { parse(value: unknown): unknown } | undefined;
  expect(shared, 'shared role context schema must exist for ordinary frontend setup').toBeDefined();
  expect(shared?.parse(selected())).toEqual(selected());
});
