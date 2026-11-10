import { afterAll, expect, it, vi } from 'vitest';
import { createApplicationJourney } from '../../server/__tests__/fixtures/symposium-application-journey.js';

const journey = createApplicationJourney();
afterAll(() => journey.close());

// Historical negative reproduction without a recording native transport.
// Explicit setup registers no prerequisite tests. This cannot establish positive
// reply acceptance without that external execution boundary and is not current acceptance.
it('requires finalized reply owners after the ordinary join', async () => {
  const { api, events, group, joinedSessionId } = await journey.initializeReviewedJoin();
  expect(events.getOrdinaryInitialCommandId(joinedSessionId)).toBeUndefined();
  const afterJoin = await api.view(group);
  const prompt = await api.send(group, {
    requestId: crypto.randomUUID(),
    expectedMembershipRevision: afterJoin.membershipRevision,
    expectedPolicySequence: afterJoin.policySequence,
    text: 'Review the selected design explicitly',
    responders: { kind: 'selected', sessionIds: [joinedSessionId] },
    snapshot: null,
  });
  await vi.waitFor(async () => {
    const projected = await api.view(group);
    const reply = projected.messages.find(
      (row) =>
        row.replyToDeliveryId !== null &&
        prompt.deliveries.some((d) => d.deliveryId === row.replyToDeliveryId),
    );
    expect(reply).toMatchObject({ author: { sessionId: joinedSessionId } });
    expect(reply!.source?.conversationId).toBe(joinedSessionId);
    expect(reply!.source?.commandId).toBeTruthy();
  });
}, 20000);
