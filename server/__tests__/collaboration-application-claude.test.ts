import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { journey, sdkApplicationState } from './fixtures/symposium-claude-application.js';

const observed = sdkApplicationState();

const specialistDeliveryTimeout = process.env.CI ? 20_000 : 5_000;

function forwardedArtifacts(text: string) {
  const packet = text
    .split('\n')
    .find((line) => line.startsWith('{"version":1,"collaborationId":'));
  return z
    .object({
      discussion: z.array(
        z.object({
          forwardedContext: z
            .object({
              artifacts: z.array(
                z.object({ content: z.string(), sha256: z.string(), revision: z.number() }),
              ),
            })
            .optional(),
        }),
      ),
    })
    .parse(JSON.parse(packet!))
    .discussion.flatMap((message) => message.forwardedContext?.artifacts ?? []);
}

it('silently joins personal Claude alongside a separate API-key participant and attributes both first and later requested answers', async () => {
  const { api, events, group, joinedSessionId } = await journey.initializeReviewedJoin();
  (await import('../auth.js')).setAuthRevocationStore(events);
  expect(events.getSessionRuntimeBinding(joinedSessionId)!.account.provider).toBe(
    'anthropic-claude',
  );
  expect(observed.inputs).toEqual([]);
  const view = await api.view(group);
  const source = view.policies.find((policy) => policy.sessionId === 'existing-chat')!;
  await api.setPolicy(group, {
    requestId: crypto.randomUUID(),
    expectedMembershipRevision: view.membershipRevision,
    expectedRevision: source.revision,
    sessionId: 'existing-chat',
    readsFutureDiscussion: false,
    repliesByDefault: false,
  });
  expect(await api.recipientReadiness(group, joinedSessionId)).toMatchObject({ ready: true });
  const { recordApplicationMessagingRuntime } =
    await import('./fixtures/symposium-recording-runtime.js');
  let native = await recordApplicationMessagingRuntime(events);
  const apiSessionId = await journey.joinReviewedParticipant({
    accountId: 'offline-api',
    harness: 'codex',
    targetId: 'offline-observation',
  });
  expect(events.getSessionRuntimeBinding(apiSessionId)!.account).toMatchObject({
    provider: 'openai',
    accountId: 'offline-api',
  });
  expect(native.requests.filter((request) => request.method === 'turn/start')).toEqual([]);
  expect(await api.recipientReadiness(group, apiSessionId)).toMatchObject({ ready: true });
  try {
    for (const text of ['Review this as personal Claude', 'Review the follow-up']) {
      const current = await api.view(group);
      const input = {
        requestId: crypto.randomUUID(),
        expectedMembershipRevision: current.membershipRevision,
        expectedPolicySequence: current.policySequence,
        text,
        responders: { kind: 'selected' as const, sessionIds: [joinedSessionId, apiSessionId] },
        snapshot: null,
      };
      const accepted = await api.send(group, input);
      await vi.waitFor(
        async () => {
          const projected = await api.view(group);
          const claudeDelivery = accepted.deliveries.find(
            (delivery) => delivery.sessionId === joinedSessionId,
          )!;
          const apiDelivery = accepted.deliveries.find(
            (delivery) => delivery.sessionId === apiSessionId,
          )!;
          const answer = projected.messages.find(
            (message) => message.replyToDeliveryId === claudeDelivery.deliveryId,
          );
          expect(
            answer,
            readFileSync(join(journey.state.root!, 'app.log'), 'utf8')
              .split('\n')
              .filter((line) => line.includes('"level":40') || line.includes('"level":50'))
              .slice(-20)
              .join('\n'),
          ).toMatchObject({
            text: 'Personal Claude reviewed the selected design.',
            author: { sessionId: joinedSessionId },
            source: { commandId: claudeDelivery.commandId },
          });
          expect(
            projected.messages.find(
              (message) => message.replyToDeliveryId === apiDelivery.deliveryId,
            ),
            readFileSync(join(journey.state.root!, 'app.log'), 'utf8')
              .split('\n')
              .filter((line) => line.includes('"level":40') || line.includes('"level":50'))
              .slice(-10)
              .join('\n'),
          ).toMatchObject({
            text: 'Reviewed the selected design.',
            author: { sessionId: apiSessionId },
            source: { commandId: apiDelivery.commandId },
          });
          expect(JSON.stringify(answer)).not.toContain('private-claude');
          expect((await api.observeSend(group, input)).terminal).toBe(true);
        },
        { timeout: 5000 },
      );
      const count = observed.inputs.length;
      expect((await api.send(group, input)).messageId).toBe(accepted.messageId);
      expect(observed.inputs).toHaveLength(count);
    }
    expect(observed.inputs).toHaveLength(2);
    expect(native.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(observed.inputs[0].text).toContain('Edited brief retained exactly');
    expect(observed.inputs[1].text).toContain('Review the follow-up');
    const h = await journey.getApplicationUiJourney();
    const beforeForward = await api.view(group);
    const prepared = await h.typedApi.collaborations.prepareForward(group, h.clientId, {
      selection: {
        requestId: crypto.randomUUID(),
        target: {
          collaborationId: group,
          expectedMembershipRevision: beforeForward.membershipRevision,
          sessionIds: [joinedSessionId, apiSessionId],
        },
        sourceConversationId: null,
        boundary: null,
        messages: [],
        artifacts: [{ kind: 'retained_artifact', ...h.retainedArtifact! }],
      },
      note: 'Exact saved design for both participants.',
    });
    await h.typedApi.collaborations.confirmForward(group, h.clientId, {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: beforeForward.membershipRevision,
      forward: {
        forwardId: prepared.forwardId,
        packetSha256: prepared.packetSha256!,
        selectionFingerprint: prepared.selectionFingerprint,
      },
      requestReply: false,
    });
    expect(observed.inputs).toHaveLength(2);
    expect(native.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    observed.holdNext = true;
    native.holdTurn(3);
    const beforeStop = await api.view(group);
    const stoppable = {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: beforeStop.membershipRevision,
      expectedPolicySequence: beforeStop.policySequence,
      text: 'Review the exact saved design together.',
      responders: { kind: 'selected' as const, sessionIds: [joinedSessionId, apiSessionId] },
      snapshot: null,
    };
    await api.send(group, stoppable);
    await vi.waitFor(() => {
      expect(observed.settle).toBeTypeOf('function');
      expect(native.requests.filter((request) => request.method === 'turn/start')).toHaveLength(3);
    });
    const stopped = await api.stopSend(group, stoppable);
    expect(stopped.recipients.map((recipient) => recipient.status)).toEqual([
      'requested',
      'requested',
    ]);
    expect(await api.stopSend(group, stoppable)).toEqual({
      ...stopped,
      recipients: stopped.recipients.map((recipient) => ({ ...recipient, status: 'uncertain' })),
    });
    expect(observed.interrupts).toBe(1);
    expect(native.requests.filter((request) => request.method === 'turn/interrupt')).toHaveLength(
      1,
    );
    expect((await api.observeSend(group, stoppable)).terminal).toBe(false);
    observed.settle!();
    native.finishTurn(3, 'completed');
    await vi.waitFor(async () =>
      expect((await api.observeSend(group, stoppable)).terminal).toBe(true),
    );
    const exactArtifact = {
      content: 'Original independently retained design • 台灣\r\n',
      sha256: h.retainedArtifact!.sha256,
      revision: h.retainedArtifact!.revision,
    };
    expect(forwardedArtifacts(observed.inputs[2].text)).toEqual([exactArtifact]);
    expect(observed.inputs[2].text).not.toContain('NEWER VERSION');
    const lastNative = native.requests.filter((request) => request.method === 'turn/start')[2];
    const apiInput = z
      .object({ input: z.array(z.object({ type: z.literal('text'), text: z.string() })) })
      .parse(lastNative.params)
      .input.map((input) => input.text)
      .join('\n');
    expect(forwardedArtifacts(apiInput)).toEqual([exactArtifact]);
    expect(apiInput).not.toContain('NEWER VERSION');
    const { registry } = await import('../chat.js');
    for (const sessionId of [joinedSessionId, apiSessionId]) {
      const live = registry.findBySessionId(sessionId);
      if (live) registry.abort(live.clientId);
    }
    const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    await vi.waitFor(() => getRepositoryWorkspaces(true).closeIdle());
    native.restore();
    await journey.restartApplication();
    const restored = await journey.getApplicationUiJourney();
    (await import('../auth.js')).setAuthRevocationStore(restored.events);
    native = await recordApplicationMessagingRuntime(restored.events);
    expect((await restored.api.observeSend(group, stoppable)).terminal).toBe(true);
    expect(observed.inputs).toHaveLength(3);
    expect(native.requests).toEqual([]);
    const reopened = await restored.api.view(group);
    expect(reopened.messages.filter((message) => message.author !== 'operator')).toHaveLength(6);
    const cold = {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: reopened.membershipRevision,
      expectedPolicySequence: reopened.policySequence,
      text: 'Continue the original personal Claude session after restart.',
      responders: { kind: 'selected' as const, sessionIds: [joinedSessionId] },
      snapshot: null,
    };
    const continued = await restored.api.send(group, cold);
    // Cold restoration crosses asynchronous history, admission and SDK boundaries.
    await vi.waitFor(
      async () => expect((await restored.api.observeSend(group, cold)).terminal).toBe(true),
      { timeout: 10000 },
    );
    expect(observed.inputs).toHaveLength(4);
    expect(observed.inputs[3].sessionId).toBe(observed.inputs[0].sessionId);
    expect((await restored.api.send(group, cold)).messageId).toBe(continued.messageId);
    expect(observed.inputs).toHaveLength(4);

    // Stop A with shared B durably queued, then lose B's in-memory source
    // observer through restart. An explicit cold continuation cannot authorize B.
    observed.holdNext = true;
    const held = { ...cold, requestId: crypto.randomUUID(), text: 'Hold before queued recovery' };
    await restored.api.send(group, held);
    await vi.waitFor(() => expect(observed.settle).toBeTypeOf('function'));
    const queued = await restored.api.send(group, {
      ...cold,
      requestId: crypto.randomUUID(),
      text: 'Private queued context must not escape',
    });
    const queuedId = queued.deliveries.find((d) => d.sessionId === joinedSessionId)!.commandId!;
    expect(restored.events.getOrdinaryLocalVertexCommandAdmission(queuedId)?.state).toBe(
      'consumed',
    );
    expect(restored.events.getExecutionAdmission(joinedSessionId, queuedId)).toBeUndefined();
    await restored.api.stopSend(group, held);
    observed.settle!();
    await vi.waitFor(async () =>
      expect((await restored.api.observeSend(group, held)).terminal).toBe(true),
    );
    expect(observed.inputs).toHaveLength(5);
    const currentChat = await import('../chat.js');
    const currentWorkspaces = await import('../repository-workspace-runtime.js');
    const live = currentChat.registry.findBySessionId(joinedSessionId);
    if (live) currentChat.registry.abort(live.clientId);
    await vi.waitFor(() => currentWorkspaces.getRepositoryWorkspaces(true).closeIdle());
    native.restore();
    await journey.restartApplication();
    const recovered = await journey.getApplicationUiJourney();
    (await import('../auth.js')).setAuthRevocationStore(recovered.events);
    native = await recordApplicationMessagingRuntime(recovered.events);
    const recoveryView = await recovered.api.view(group);
    const refusal = await recovered.api.send(group, {
      ...cold,
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: recoveryView.membershipRevision,
      expectedPolicySequence: recoveryView.policySequence,
      text: 'Explicit cold continuation cannot replace the original sharing authority',
    });
    expect(refusal.deliveries.find((d) => d.sessionId === joinedSessionId)?.status).toBe(
      'uncertain',
    );
    expect(recovered.events.getExecutionAdmission(joinedSessionId, queuedId)).toBeUndefined();
    expect(observed.inputs).toHaveLength(5);
  } finally {
    const { registry } = await import('../chat.js');
    for (const sessionId of [joinedSessionId, apiSessionId]) {
      const live = registry.findBySessionId(sessionId);
      if (live) registry.abort(live.clientId);
    }
    const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    await vi.waitFor(() => getRepositoryWorkspaces(true).closeIdle());
    native.restore();
  }
}, 60000);

it('routes an independent specialist review across OpenAI and qualified Anthropic Messages accounts', async () => {
  if (journey.state.root !== undefined) await journey.restartApplication();
  const h = await journey.getApplicationUiJourney();
  const { getSpecialistConsultations } = await import('../specialist-consultation-runtime.js');
  const { captureAgentLibraryAuthorization } = await import('../agent-library-transport.js');
  const { getAgentLibrary } = await import('../agent-library-runtime.js');
  const auth = captureAgentLibraryAuthorization(h.clientId);
  (await import('../auth.js')).setAuthRevocationStore(h.events);
  const service = getSpecialistConsultations();
  const initialView = await h.api.view(h.group);
  for (const reader of initialView.policies.filter((policy) => policy.readsFutureDiscussion)) {
    await h.api.setPolicy(h.group, {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: initialView.membershipRevision,
      expectedRevision: reader.revision,
      sessionId: reader.sessionId,
      readsFutureDiscussion: false,
      repliesByDefault: false,
    });
  }
  const library = getAgentLibrary();
  for (const role of ['consult-planner', 'consult-reviewer']) {
    library.saveDraft('user', {
      profileId: role,
      expectedVersion: 0,
      expectedRevision: 0,
      idempotencyKey: role,
      definition: {
        name: role,
        role,
        modelPolicyRole: role,
        instructions: 'Contribute to the bounded assignment.',
        expectedOutput: 'Evidence',
        acceptanceCriteria: ['Cite evidence'],
      },
    });
    library.publish('user', {
      profileId: role,
      expectedVersion: 1,
      idempotencyKey: 'publish-' + role,
    });
  }
  const authority = {
    leadSessionId: 'existing-chat',
    operatorConnectionId: h.clientId,
    auth: auth.auth,
    signal: new AbortController().signal,
    assertCurrent: () => auth.assertCurrent(),
  };
  const catalog = await service.catalog(authority);
  const source = catalog.repositories.find((row) => row.accountId === 'offline-messages')!;
  const policy = await service.authorize(
    authority,
    {
      requestId: crypto.randomUUID(),
      repository: source.repository,
      connectionId: source.connectionId,
      maxConsultations: 2,
      routes: [
        {
          role: 'consult-planner',
          modelFamily: 'synthetic-openai-family',
          accountId: 'offline-api',
          model: 'fixture-model',
          reasoningEffort: 'low',
          runOn: 'local',
          targetId: 'offline-observation',
        },
        {
          role: 'consult-reviewer',
          modelFamily: 'synthetic-anthropic-family',
          accountId: 'offline-messages',
          model: 'fixture-model',
          reasoningEffort: 'low',
          runOn: 'local',
          targetId: 'offline-claude-target',
        },
      ],
    },
    async () => true,
  );
  const { recordApplicationMessagingRuntime } =
    await import('./fixtures/symposium-recording-runtime.js');
  const native = await recordApplicationMessagingRuntime(h.events);
  try {
    const input = {
      requestId: crypto.randomUUID(),
      role: 'consult-planner',
      assignment: 'Plan the change.',
      messageIds: [],
      artifacts: [],
    };
    await service.consult(authority, policy.policyId, input);
    await vi.waitFor(
      () =>
        expect(
          service.read(authority, input.requestId).status,
          JSON.stringify({
            observed: service.read(authority, input.requestId).deliveries,
            native: native.requests.map((r) => r.method),
          }),
        ).toBe('completed'),
      { timeout: specialistDeliveryTimeout },
    );
    const review = {
      ...input,
      requestId: crypto.randomUUID(),
      role: 'consult-reviewer',
      assignment: 'Review independently.',
      reviewOf: input.requestId,
    };
    const requested = await service.consult(authority, policy.policyId, review);
    expect(requested.independence).toMatchObject({ independent: true, differentFamily: true });
    await vi.waitFor(
      () =>
        expect(
          service.read(authority, review.requestId).status,
          JSON.stringify(service.read(authority, review.requestId).deliveries),
        ).toBe('completed'),
      { timeout: specialistDeliveryTimeout },
    );
    expect(service.read(authority, review.requestId).contributions[0]).toMatchObject({
      role: 'consult-reviewer',
      accountId: 'offline-messages',
      text: 'Personal Claude reviewed the selected design.',
    });
    const before = observed.inputs.length;
    await service.consult(authority, policy.policyId, review);
    expect(observed.inputs).toHaveLength(before);
    expect(observed.inputs.at(-1)?.text).toContain('Reviewed the selected design.');
    expect(JSON.stringify(service.read(authority, review.requestId))).not.toContain(
      'synthetic-messages-key',
    );
  } finally {
    const { registry } = await import('../chat.js');
    for (const entry of registry.entries(true)) registry.abort(entry[0]);
    const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
    await vi.waitFor(() => getRepositoryWorkspaces(true).closeIdle());
    native.restore();
  }
}, 60000);
