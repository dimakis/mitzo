import { afterAll, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';
import { sdkQueryPeer } from './fixtures/sdk-query-peer.js';

const observed = vi.hoisted(() => ({ inputs: [] as Array<{ sessionId: string; text: string }> }));
vi.mock('../claude-account-history.js', () => ({
  readClaudeAccountHistory: async (sessionId: string, cwd: string) => ({
    info: { sessionId, cwd },
    messages: [{ type: 'user', uuid: 'retained-offline-input' }],
  }),
}));
vi.mock('../credential-sdk-boundary.js', async (original) => ({
  ...(await original<object>()),
  credentialSdkBoundary: (await import('./fixtures/sdk-query-peer.js')).sdkFixtureBoundary,
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
      interrupt: async () => {},
    });
  }),
}));

const journey = createApplicationJourney({
  additionalAccountIds: ['offline-api'],
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
      await writeFile(path, JSON.stringify(accounts), { mode: 0o600 });
    }
    vi.stubEnv('MITZO_ORDINARY_LOCAL_VERTEX_ENABLED', '1');
    vi.stubEnv('MITZO_ORDINARY_LOCAL_VERTEX_TARGET_FILE', target);
  },
});
afterAll(async () => {
  try {
    if (journey.state.root) {
      await writeFile(
        '../claude-application-native.log',
        await readFile(join(journey.state.root, 'app.log'), 'utf8'),
      );
      if (journey.state.joinedSessionId)
        await writeFile(
          '../claude-application-state.json',
          JSON.stringify(
            {
              inputs: observed.inputs,
              events: journey.state.events.getSessionEvents(journey.state.joinedSessionId),
            },
            null,
            2,
          ),
        );
    }
  } finally {
    try {
      await journey.close();
    } finally {
      vi.restoreAllMocks();
    }
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
  const native = await recordApplicationMessagingRuntime(events);
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
      await vi.waitFor(async () => {
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
        expect(answer).toMatchObject({
          text: 'Personal Claude reviewed the selected design.',
          author: { sessionId: joinedSessionId },
          source: { commandId: claudeDelivery.commandId },
        });
        expect(
          projected.messages.find(
            (message) => message.replyToDeliveryId === apiDelivery.deliveryId,
          ),
        ).toMatchObject({
          text: 'Reviewed the selected design.',
          author: { sessionId: apiSessionId },
          source: { commandId: apiDelivery.commandId },
        });
        expect(JSON.stringify(answer)).not.toContain('private-claude');
        expect((await api.observeSend(group, input)).terminal).toBe(true);
      });
      const count = observed.inputs.length;
      expect((await api.send(group, input)).messageId).toBe(accepted.messageId);
      expect(observed.inputs).toHaveLength(count);
    }
    expect(observed.inputs).toHaveLength(2);
    expect(native.requests.filter((request) => request.method === 'turn/start')).toHaveLength(2);
    expect(observed.inputs[0].text).toContain('Edited brief retained exactly');
    expect(observed.inputs[1].text).toContain('Review the follow-up');
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
}, 30000);
