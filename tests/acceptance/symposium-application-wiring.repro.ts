import { expect, it, vi } from 'vitest';
import { getApplicationJoiningJourney } from '../../server/__tests__/collaboration-application-joining-integration.test.js';

// Importing the passing journey registers its actual-app review/join/restart tests.
// This remaining required reproduction stays red until ordinary group delivery and
// reply projection are wired. No hand-built router or fake capacity can satisfy it.
it('requires finalized reply owners after the ordinary join', async () => {
  const { api, events, group, joinedSessionId } = getApplicationJoiningJourney();
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
