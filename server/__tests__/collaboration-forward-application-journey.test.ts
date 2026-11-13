import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';
import { recordApplicationMessagingRuntime } from './fixtures/symposium-recording-runtime.js';

const journey = createApplicationJourney({ retainedArtifactOwner: true });
afterAll(() => journey.close());
it('forwards an independently retained older artifact through real public application and ordinary native consumers', async () => {
  let h = await journey.getApplicationUiJourney();
  // Production index.ts installs this real durable revocation owner. Importing
  // the application alone intentionally does not start that service entrypoint.
  (await import('../auth.js')).setAuthRevocationStore(h.events);
  let runtime = await recordApplicationMessagingRuntime(h.events);
  const participants = (await h.api.view(h.group)).participantSessionIds;
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
    const preparation = {
      selection: {
        requestId: randomUUID(),
        target: {
          collaborationId: h.group,
          expectedMembershipRevision: view.membershipRevision,
          sessionIds: [h.joinedSessionId!],
        },
        sourceConversationId: null,
        boundary: null,
        messages: [],
        artifacts: [{ kind: 'retained_artifact' as const, ...h.retainedArtifact! }],
      },
      note: 'Review this deliberately shared saved version on your next requested turn.',
    };
    expect(
      await h.typedApi.collaborations.observeForwardPreparation(
        h.group,
        preparation.selection.requestId,
        h.clientId,
      ),
    ).toBeNull();
    const { TelosArtifactStore } = await import('../telos-artifact-store.js');
    const failure = vi
      .spyOn(TelosArtifactStore.prototype, 'readBoundedRevision')
      .mockImplementationOnce(() => {
        throw Error('Synthetic retained storage failure');
      });
    try {
      await expect(
        h.typedApi.collaborations.prepareForward(h.group, h.clientId, preparation),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      failure.mockRestore();
    }
    expect(
      await h.typedApi.collaborations.observeForwardPreparation(
        h.group,
        preparation.selection.requestId,
        h.clientId,
      ),
    ).toMatchObject({ state: 'preparing', packetSha256: null, confirmation: null });
    expect(runtime.requests).toEqual([]);
    const prepared = await h.typedApi.collaborations.prepareForward(
      h.group,
      h.clientId,
      preparation,
    );
    expect(prepared.state).toBe('prepared');
    expect(JSON.stringify(prepared)).not.toContain('/private/');
    expect(JSON.stringify(prepared)).not.toContain('Original independently');
    expect(runtime.requests).toEqual([]);
    // A lost prepare response can be observed by the retained request ID. A
    // complete process restart must not silently confirm or request a reply.
    expect(
      await h.typedApi.collaborations.observeForwardPreparation(
        h.group,
        preparation.selection.requestId,
        h.clientId,
      ),
    ).toEqual(prepared);
    runtime.restore();
    await journey.restartApplication();
    h = await journey.getApplicationUiJourney();
    (await import('../auth.js')).setAuthRevocationStore(h.events);
    runtime = await recordApplicationMessagingRuntime(h.events);
    expect(
      await h.typedApi.collaborations.observeForwardPreparation(
        h.group,
        preparation.selection.requestId,
        h.clientId,
      ),
    ).toEqual(prepared);
    expect(runtime.requests).toEqual([]);
    const confirm = {
      requestId: randomUUID(),
      expectedMembershipRevision: view.membershipRevision,
      forward: {
        forwardId: prepared.forwardId,
        packetSha256: prepared.packetSha256!,
        selectionFingerprint: prepared.selectionFingerprint,
      },
      requestReply: false as const,
    };
    const receipt = await h.typedApi.collaborations.confirmForward(h.group, h.clientId, confirm);
    expect(await h.typedApi.collaborations.confirmForward(h.group, h.clientId, confirm)).toEqual(
      receipt,
    );
    expect(runtime.requests).toEqual([]);
    view = await h.api.view(h.group);
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]).toMatchObject({
      responders: [],
      deliveries: [{ purpose: 'context', commandId: null, status: 'pending' }],
    });
    const input = {
      requestId: randomUUID(),
      expectedMembershipRevision: view.membershipRevision,
      expectedPolicySequence: view.policySequence,
      text: 'Now respond explicitly to the shared saved design.',
      snapshot: null,
      responders: { kind: 'selected' as const, sessionIds: [h.joinedSessionId!] },
    };
    await h.api.send(h.group, input);
    await vi.waitFor(async () =>
      expect(
        (await h.api.view(h.group)).messages.filter((m) => m.author !== 'operator'),
      ).toHaveLength(1),
    );
    const turns = runtime.requests.filter((r) => r.method === 'turn/start');
    expect(turns).toHaveLength(1);
    const text = (turns[0].params.input as Array<{ text?: string }>)
      .map((p) => p.text ?? '')
      .join('');
    const packet = JSON.parse(text.split('\n')[2]);
    const forwarded = packet.discussion.find(
      (m: { forwardedContext?: unknown }) => m.forwardedContext,
    );
    expect(forwarded.forwardedContext.artifacts[0].content).toBe(
      'Original independently retained design • 台灣\r\n',
    );
    expect(text).not.toContain('NEWER VERSION');
    expect(text).not.toContain('/private/original-design.md');
    expect(text).not.toContain('contentBase64');
    expect(text).not.toContain('removed-origin');
    const observed = await h.typedApi.collaborations.forward(
      h.group,
      prepared.forwardId,
      h.clientId,
    );
    expect(observed.deliveries).toMatchObject([
      {
        purpose: 'context',
        status: 'delivered',
        commandId: `collaboration:${(await h.api.view(h.group)).messages.find((m) => m.text === input.text)!.deliveries[0].deliveryId}`,
      },
    ]);
    await h.api.send(h.group, input);
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1);
  } finally {
    const { registry } = await import('../chat.js');
    for (const id of participants) {
      const live = registry.findBySessionId(id);
      if (live) registry.abort(live.clientId);
    }
    const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    await vi.waitFor(() => getRepositoryWorkspaces(true).closeIdle());
    runtime.restore();
  }
}, 30000);

it('reviews and forwards a completed earlier message through the real source reader while a later reply streams', async () => {
  const h = await journey.getApplicationUiJourney();
  (await import('../auth.js')).setAuthRevocationStore(h.events);
  const runtime = await recordApplicationMessagingRuntime(h.events);
  const active = randomUUID();
  try {
    const before = await h.typedApi.getDurableSessionTranscript('existing-chat');
    const selected = before.messages[0];
    h.events.append('existing-chat', 'message_start', { messageId: active });
    h.events.append('existing-chat', 'block_start', {
      messageId: active,
      blockId: 'stream',
      blockType: 'text',
    });
    h.events.append('existing-chat', 'block_delta', {
      messageId: active,
      blockId: 'stream',
      delta: 'Unfinished reply',
    });
    const captured = await h.typedApi.getDurableSessionTranscript('existing-chat');
    expect(captured).toEqual(before);
    const view = await h.api.view(h.group);
    const review = await h.typedApi.collaborations.reviewPrompt(h.group, h.clientId, {
      selection: {
        requestId: randomUUID(),
        expectedMembershipRevision: view.membershipRevision,
        sourceConversationId: 'existing-chat',
        boundary: captured.boundary,
        mode: 'selected',
        messageIds: [selected.messageId],
        artifacts: [],
        purpose: 'Share the earlier plan',
        joiningBrief: 'Read this selected message.',
      },
      recipientSessionIds: [h.joinedSessionId!],
      expectedPolicySequence: view.policySequence,
    });
    h.events.append('existing-chat', 'block_delta', {
      messageId: active,
      blockId: 'stream',
      delta: ' continues',
    });
    const prepared = await h.typedApi.collaborations.prepareForward(h.group, h.clientId, {
      selection: {
        requestId: randomUUID(),
        target: {
          collaborationId: h.group,
          expectedMembershipRevision: view.membershipRevision,
          sessionIds: [h.joinedSessionId!],
        },
        sourceConversationId: 'existing-chat',
        boundary: review.snapshot.boundary,
        messages: review.snapshot.messages.map(({ messageId, sequence, blocks }) => ({
          messageId,
          sequence,
          blocks: blocks.map(({ blockId, sha256 }) => ({ blockId, sha256 })),
        })),
        artifacts: [],
      },
      note: review.snapshot.joiningBrief,
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
    const observed = await h.typedApi.collaborations.forward(
      h.group,
      prepared.forwardId,
      h.clientId,
    );
    expect(observed.state).toBe('confirmed');
    expect(observed.selection.target.sessionIds).toEqual([h.joinedSessionId]);
    expect(review.snapshot.messages).toEqual([selected]);
    expect(JSON.stringify(review.snapshot.messages)).not.toContain('Unfinished reply');
    expect(runtime.requests).toEqual([]);
  } finally {
    h.events.append('existing-chat', 'block_end', { messageId: active, blockId: 'stream' });
    h.events.append('existing-chat', 'message_end', { messageId: active });
    runtime.restore();
  }
}, 30000);
