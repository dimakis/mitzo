import { randomUUID } from 'node:crypto';
import { afterAll, it, expect, vi } from 'vitest';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';
import { recordApplicationMessagingRuntime } from './fixtures/symposium-recording-runtime.js';
const journey = createApplicationJourney({ retainedArtifactOwner: true });
afterAll(() => journey.close());
it('reviews and forwards exact shared user and agent replies without starting a model', async () => {
  const selectedJourney = journey;
  const h = await selectedJourney.getApplicationUiJourney();
  (await import('../auth.js')).setAuthRevocationStore(h.events);
  const runtime = await recordApplicationMessagingRuntime(h.events);
  try {
    let view = await h.api.view(h.group);
    await h.api.setPolicy(h.group, {
      requestId: randomUUID(),
      expectedMembershipRevision: view.membershipRevision,
      expectedRevision: view.policies.find((p) => p.sessionId === 'existing-chat')!.revision,
      sessionId: 'existing-chat',
      readsFutureDiscussion: false,
      repliesByDefault: false,
    });
    view = await h.api.view(h.group);
    await h.api.send(h.group, {
      requestId: randomUUID(),
      expectedMembershipRevision: view.membershipRevision,
      expectedPolicySequence: view.policySequence,
      text: 'Canonical shared source for forwarding',
      responders: { kind: 'selected', sessionIds: [h.joinedSessionId!] },
      snapshot: null,
    });
    await vi.waitFor(async () =>
      expect((await h.api.view(h.group)).messages.some((m) => m.author !== 'operator')).toBe(true),
    );
    view = await h.api.view(h.group);
    const selected = [
      view.messages.find((m) => m.text === 'Canonical shared source for forwarding')!,
      view.messages.find((m) => m.author !== 'operator')!,
    ];
    const turns = runtime.requests.filter((r) => r.method === 'turn/start').length;
    for (const message of selected) {
      const reviewed = await h.typedApi.collaborations.reviewPrompt(h.group, h.clientId, {
        selection: {
          requestId: randomUUID(),
          sourceConversationId: h.group,
          boundary: { sequence: message.sequence, messageId: message.messageId },
          expectedMembershipRevision: view.membershipRevision,
          mode: 'selected',
          messageIds: [message.messageId],
          artifacts: [],
          purpose: 'Forward this exact shared message',
          joiningBrief: '',
        },
        recipientSessionIds: [h.joinedSessionId!],
        expectedPolicySequence: view.policySequence,
      });
      expect(reviewed.snapshot.messages).toMatchObject([
        {
          messageId: message.messageId,
          author: message.author,
          blocks: [{ content: message.text }],
        },
      ]);
      const prepared = await h.typedApi.collaborations.prepareForward(h.group, h.clientId, {
        selection: {
          requestId: randomUUID(),
          target: {
            collaborationId: h.group,
            expectedMembershipRevision: view.membershipRevision,
            sessionIds: [h.joinedSessionId!],
          },
          sourceConversationId: h.group,
          boundary: reviewed.snapshot.boundary,
          messages: reviewed.snapshot.messages.map(({ messageId, sequence, blocks }) => ({
            messageId,
            sequence,
            blocks: blocks.map(({ blockId, sha256 }) => ({ blockId, sha256 })),
          })),
          artifacts: [],
        },
        note: 'Forwarded shared message',
      });
      await h.typedApi.collaborations.confirmForward(h.group, h.clientId, {
        requestId: randomUUID(),
        expectedMembershipRevision: view.membershipRevision,
        forward: {
          forwardId: prepared.forwardId,
          packetSha256: prepared.packetSha256!,
          selectionFingerprint: prepared.selectionFingerprint,
        },
        requestReply: false,
      });
    }
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(turns);
    const reply = await h.api.send(h.group, {
      requestId: randomUUID(),
      expectedMembershipRevision: view.membershipRevision,
      expectedPolicySequence: view.policySequence,
      text: 'Reply to the original shared source',
      responders: { kind: 'selected', sessionIds: [h.joinedSessionId!] },
      snapshot: null,
      replyToMessageId: selected[0].messageId,
    });
    expect(reply.inReplyTo).toMatchObject({
      messageId: selected[0].projectionId,
      text: selected[0].text,
      timestamp: selected[0].recordedAt,
    });
    await expect(
      h.api.send(h.group, {
        requestId: randomUUID(),
        expectedMembershipRevision: view.membershipRevision,
        expectedPolicySequence: view.policySequence,
        text: 'Unavailable quote',
        responders: { kind: 'selected', sessionIds: [h.joinedSessionId!] },
        snapshot: null,
        replyToMessageId: randomUUID(),
      }),
    ).rejects.toThrow();
  } finally {
    const { registry } = await import('../chat.js');
    for (const id of (await h.api.view(h.group)).participantSessionIds) {
      const live = registry.findBySessionId(id);
      if (live) registry.abort(live.clientId);
    }
    const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    await vi.waitFor(() => getRepositoryWorkspaces(true).closeIdle());
    runtime.restore();
  }
}, 30000);
