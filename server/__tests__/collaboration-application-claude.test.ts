import { afterAll, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';
import { sdkQueryPeer } from './fixtures/sdk-query-peer.js';
import { z } from 'zod';

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

const observed = vi.hoisted(() => ({
  inputs: [] as Array<{ sessionId: string; text: string }>,
  holdNext: false,
  settle: undefined as (() => void) | undefined,
  interrupts: 0,
}));
const specialistDeliveryTimeout = process.env.CI ? 20_000 : 5_000;
vi.mock('../claude-account-history.js', () => ({
  readClaudeAccountHistory: async (sessionId: string, cwd: string) => ({
    info: { sessionId, cwd },
    messages: [{ type: 'user', uuid: 'retained-offline-input' }],
  }),
}));
vi.mock('../credential-sdk-boundary.js', async (original) => ({
  ...(await original<object>()),
  credentialSdkBoundary: (await import('./fixtures/sdk-query-peer.js')).sdkFixtureBoundary,
  runtimeFilesystemSdkBoundary: (await import('./fixtures/sdk-query-peer.js')).sdkFixtureBoundary,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<object>()),
  getSessionInfo: async (sessionId: string, options: { dir: string }) => ({
    sessionId,
    cwd: options.dir,
  }),
  getSessionMessages: async () => [{ type: 'user', uuid: 'retained-offline-input' }],
  query: vi.fn((request) => {
    const sessionId = request.options.sessionId ?? request.options.resume;
    const stream = async function* () {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        tools: [],
        model: 'fixture-model',
      };
      for await (const input of request.prompt) {
        const content = input.message.content;
        const text =
          typeof content === 'string'
            ? content
            : content.map((block: { text?: string }) => block.text ?? '').join('');
        observed.inputs.push({ sessionId, text });
        const uuid = `private-claude-input-${observed.inputs.length}`;
        yield { ...input, session_id: sessionId, uuid, parent_tool_use_id: null };
        if (observed.holdNext) {
          observed.holdNext = false;
          await new Promise<void>((resolve) => {
            observed.settle = resolve;
          });
          observed.settle = undefined;
        }
        yield {
          type: 'stream_event',
          session_id: sessionId,
          parent_tool_use_id: null,
          event: {
            type: 'message_start',
            message: {
              id: `claude-visible-${observed.inputs.length}`,
              role: 'assistant',
              content: [],
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
        };
        yield {
          type: 'stream_event',
          session_id: sessionId,
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        };
        yield {
          type: 'stream_event',
          session_id: sessionId,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Personal Claude reviewed the selected design.' },
          },
        };
        yield {
          type: 'stream_event',
          session_id: sessionId,
          event: { type: 'content_block_stop', index: 0 },
        };
        yield { type: 'stream_event', session_id: sessionId, event: { type: 'message_stop' } };
        yield {
          type: 'assistant',
          session_id: sessionId,
          uuid: `assistant-event-${observed.inputs.length}`,
          parent_tool_use_id: null,
          message: {
            id: `claude-visible-${observed.inputs.length}`,
            type: 'message',
            role: 'assistant',
            model: 'fixture-model',
            content: [{ type: 'text', text: 'Personal Claude reviewed the selected design.' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: 'result',
          session_id: sessionId,
          subtype: 'success',
          is_error: false,
          result: 'Personal Claude reviewed the selected design.',
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
        };
      }
    };
    return Object.assign(sdkQueryPeer(request, stream()), {
      accountInfo: async () => ({
        email: 'claude@example.invalid',
        subscriptionType: 'max',
        apiProvider: 'firstParty',
        apiKeySource: 'none',
      }),
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      setPermissionMode: async () => {},
      interrupt: async () => {
        observed.interrupts++;
      },
    });
  }),
}));

const journey = createApplicationJourney({
  retainedArtifactOwner: true,
  additionalAccountIds: ['offline-api', 'offline-messages'],
  participant: {
    accountId: 'offline-claude',
    harness: 'claude-sdk',
    targetId: 'offline-claude-target',
  },
  configureExternalTarget: async (root, fresh) => {
    const { KeychainCredentialProvider } = await import('../credentials.js');
    vi.spyOn(KeychainCredentialProvider.prototype, 'resolve').mockImplementation(async (ref) => {
      expect(ref).toEqual({ provider: 'keychain', service: 'offline-test', account: 'api' });
      return 'synthetic-api-key';
    });
    const { KeychainRotationCredentials } = await import('../keychain-rotation-credentials.js');
    const read = KeychainRotationCredentials.prototype.read;
    vi.spyOn(KeychainRotationCredentials.prototype, 'read').mockImplementation((ref, signal) =>
      ref.service === 'offline-messages'
        ? Promise.resolve({
            value: 'synthetic-messages-key',
            version: 'eec02914-ac1f-4369-ab86-8e4f130abc92',
            managed: true,
          })
        : read.call(new KeychainRotationCredentials(), ref, signal),
    );
    const config = join(root, 'claude-subscription');
    const executable = join(root, 'inert-claude');
    const target = join(root, 'claude-target.json');
    const { ClaudeSubscriptionCustody } = await import('../claude-subscription-custody.js');
    const capture = ClaudeSubscriptionCustody.capture;
    vi.spyOn(ClaudeSubscriptionCustody, 'capture').mockImplementation((env) =>
      capture(env, executable),
    );
    vi.spyOn(ClaudeSubscriptionCustody.prototype, 'verify').mockResolvedValue();
    if (fresh) {
      await mkdir(config, { mode: 0o700 });
      await writeFile(executable, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
      const { ordinaryLocalVertexContractRevision } =
        await import('../ordinary-local-vertex-capabilities.js');
      await writeFile(
        target,
        JSON.stringify({
          version: 1,
          targetId: 'offline-claude-target',
          label: 'Offline Claude',
          hostId: hostname(),
          runtimeContractRevision: ordinaryLocalVertexContractRevision(),
        }),
        { mode: 0o600 },
      );
      const path = join(root, 'accounts.json');
      const accounts = JSON.parse(await readFile(path, 'utf8'));
      accounts.push({
        id: 'offline-claude',
        label: 'Personal Claude subscription',
        provider: 'anthropic-claude',
        credentialRef: config,
        email: 'claude@example.invalid',
        planType: 'max',
        models: [{ id: 'fixture-model', label: 'Offline Claude', reasoningEfforts: ['low'] }],
      });
      accounts.push({
        id: 'offline-api',
        label: 'Separate API-key participant',
        provider: 'openai',
        credentialRef: { provider: 'keychain', service: 'offline-test', account: 'api' },
        models: [{ id: 'fixture-model', label: 'Offline API', reasoningEfforts: ['low'] }],
      });
      accounts.push({
        id: 'offline-messages',
        label: 'Qualified Anthropic Messages endpoint',
        provider: 'anthropic-api',
        credentialRef: { provider: 'keychain', service: 'offline-messages', account: 'api' },
        credentialVersion: 'eec02914-ac1f-4369-ab86-8e4f130abc92',
        connection: {
          endpoint: 'https://messages.example.invalid',
          protocol: 'messages',
          authentication: 'api-key',
          qualification: {
            source: 'operator',
            streaming: true,
            toolCalls: true,
            continuation: true,
            cancellation: true,
          },
        },
        models: [{ id: 'fixture-model', label: 'Offline Messages', reasoningEfforts: ['low'] }],
      });
      await writeFile(path, JSON.stringify(accounts), { mode: 0o600 });
    }
    vi.stubEnv('MITZO_ORDINARY_LOCAL_VERTEX_ENABLED', '1');
    vi.stubEnv('MITZO_ORDINARY_LOCAL_VERTEX_TARGET_FILE', target);
  },
});
afterAll(async () => {
  try {
    await journey.close();
  } finally {
    vi.restoreAllMocks();
  }
});

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
