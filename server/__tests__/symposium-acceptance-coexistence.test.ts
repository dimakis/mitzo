import { afterEach, expect, it } from 'vitest';
import {
  createAcceptanceFixture,
  cleanupAcceptanceFixtures,
} from './fixtures/symposium-acceptance.js';
import {
  assertTelosWorkTaskExecutionScope,
  resolveTelosWorkRoleContext,
} from '../telos-work-role-context.js';

afterEach(cleanupAcceptanceFixtures);

it('keeps same-account role guidance, tools and shared discussion scoped through the ordinary driver', async () => {
  const f = createAcceptanceFixture();
  f.role('architect', 'lead');
  f.role('reviewer', 'worker');
  const discussion = f.message('Discuss only this selected design', ['reviewer']);
  expect(f.store.getOrdinaryCollaborationDeliveryEvents('reviewer', 'initial-reviewer')).toEqual(
    [],
  );
  const architect = f.runtime('architect');
  const reviewer = f.runtime('reviewer', [f.ref(discussion, 'reviewer')]);
  await architect.driver.initialize();
  await reviewer.driver.initialize();
  expect(f.samplingRequests()).toEqual([]);
  await reviewer.driver.send({ id: 'initial-reviewer', prompt: 'Review explicitly' });
  const turn = reviewer.requests.find((row) => row.method === 'turn/start')!;
  expect(JSON.stringify(turn.params)).toContain(discussion.text);
  expect(JSON.stringify(turn.params)).toContain('reviewer private brief');
  expect(JSON.stringify(turn.params)).not.toContain('architect private brief');
  const thread = reviewer.requests.find((row) => row.method === 'thread/start')!;
  expect(JSON.stringify(thread.params)).toContain('reviewer_read');
  expect(JSON.stringify(thread.params)).not.toContain('architect_read');
  expect(architect.requests.some((row) => row.method === 'turn/start')).toBe(false);
  expect(() =>
    assertTelosWorkTaskExecutionScope(f.store, 'architect', f.account, 'task-reviewer'),
  ).toThrow(/authorize/);
  expect(() =>
    assertTelosWorkTaskExecutionScope(f.store, 'reviewer', f.account, 'task-reviewer'),
  ).not.toThrow();
  expect(() =>
    assertTelosWorkTaskExecutionScope(f.store, 'reviewer', f.account, 'task-architect'),
  ).toThrow(/authorize/);
});

it('retains separate authority and recipient identities across canonical EventStore restart', () => {
  const f = createAcceptanceFixture();
  f.role('architect', 'lead');
  f.role('reviewer', 'worker');
  const discussion = f.message('Read before your next requested turn', ['architect']);
  f.reopen();
  expect(resolveTelosWorkRoleContext(f.store, 'reviewer', f.account)).toMatchObject({
    role: 'worker',
    executionTaskId: 'task-reviewer',
  });
  expect(resolveTelosWorkRoleContext(f.store, 'architect', f.account)).toMatchObject({
    role: 'lead',
  });
  expect(() =>
    resolveTelosWorkRoleContext(f.store, 'reviewer', { ...f.account, accountId: 'other' }),
  ).toThrow();
  const delivery = f.store.collaborationConversation.getMessage(f.group, discussion.messageId)!;
  expect(delivery.responders).toEqual(['architect']);
  expect(delivery.deliveries.every((row) => row.commandId === null)).toBe(true);
  expect(f.store.getOrdinaryInitialCommandId('architect')).not.toBe(
    f.store.getOrdinaryInitialCommandId('reviewer'),
  );
});

it('rejects cross-session delivery claims before any ordinary native request', () => {
  const f = createAcceptanceFixture();
  const discussion = f.message('Private directed exchange', ['reviewer']);
  expect(() => f.runtime('architect', [f.ref(discussion, 'reviewer')])).toThrow();
  expect(f.samplingRequests()).toEqual([]);
  expect(f.store.getOrdinaryCollaborationDeliveryEvents('architect', 'initial-architect')).toEqual(
    [],
  );
});
