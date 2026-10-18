import { afterEach, expect, it } from 'vitest';
import {
  createAcceptanceFixture,
  cleanupAcceptanceFixtures,
} from './fixtures/symposium-acceptance.js';
import { OrdinaryCollaborationReplies } from '../collaboration-ordinary-replies.js';

afterEach(cleanupAcceptanceFixtures);

it('overrides Defaults with stable explicit recipients while preserving independent partial outcomes', async () => {
  const f = createAcceptanceFixture();
  f.policy('architect', true, true);
  f.policy('reviewer', true, false);
  expect(f.message('Default architect').responders).toEqual(['architect']);
  const directed = f.message('Explicit reviewer', ['reviewer']);
  expect(directed.responders).toEqual(['reviewer']);
  const reviewer = f.runtime('reviewer', [f.ref(directed, 'reviewer')]);
  await reviewer.driver.initialize();
  await reviewer.driver.send({ id: 'initial-reviewer', prompt: directed.text });
  const before = f.store.collaborationConversation.getMessage(f.group, directed.messageId)!;
  expect(before.deliveries.find((row) => row.sessionId === 'reviewer')!.status).toBe('delivered');
  const reader = before.deliveries.find((row) => row.sessionId === 'architect')!;
  f.store.collaborationConversation.recordDelivery(f.group, directed.messageId, reader.deliveryId, {
    requestId: crypto.randomUUID(),
    expectedRevision: reader.revision,
    status: 'failed',
    commandId: null,
    reason: 'Offline isolated recipient failure',
  });
  f.reopen();
  const recovered = f.store.collaborationConversation.getMessage(f.group, directed.messageId)!;
  expect(recovered.deliveries.find((row) => row.sessionId === 'architect')!.status).toBe('failed');
  expect(recovered.deliveries.find((row) => row.sessionId === 'reviewer')).toEqual(
    before.deliveries.find((row) => row.sessionId === 'reviewer'),
  );
  expect(f.samplingRequests()).toHaveLength(1);
});

it('rejects aliases, foreign command sources and removed recipients without allocating or broadcasting', () => {
  const f = createAcceptanceFixture();
  const before = f.store.collaborationConversation.view(f.group);
  expect(() => f.message('Unknown alias', ['@reviewer'])).toThrow('unknown_recipient');
  expect(f.store.collaborationConversation.view(f.group)).toEqual(before);
  const origin = f.message('Exact recipient', ['reviewer']);
  const reply = f.finalizedReply(origin);
  expect(reply.author).toEqual({ sessionId: 'reviewer' });
  expect(JSON.stringify(reply)).not.toContain('private-thread');
  expect(() =>
    new OrdinaryCollaborationReplies(f.store).record(f.group, {
      requestId: crypto.randomUUID(),
      messageId: origin.messageId,
      deliveryId: f.ref(origin, 'reviewer').deliveryId,
      source: { ...reply.source, commandId: 'initial-architect' },
    }),
  ).toThrow('reply_conflict');
  f.store.setSessionCollaboration(f.group, {
    expectedRevision: 1,
    participantSessionIds: ['architect'],
  });
  expect(() => f.message('Removed reviewer', ['reviewer'])).toThrow('unknown_recipient');
  expect(f.samplingRequests()).toEqual([]);
});
