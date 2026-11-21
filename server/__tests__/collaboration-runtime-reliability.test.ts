import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createApplicationJourney } from './fixtures/symposium-application-journey.js';
import { recordApplicationMessagingRuntime } from './fixtures/symposium-recording-runtime.js';
import { parseServerMessage } from '../../packages/client/src/protocol-parser.js';
import {
  INITIAL_MESSAGES_STATE,
  messagesReducer,
} from '../../packages/client/src/slices/messages.js';

// Authentication, joining, ordinary admission, transport adapter, SQLite and
// the public application clients are real. Only external providers are synthetic.
// This is offline source evidence, never live Symposium-seat acceptance.
const journey = createApplicationJourney();
let h: Awaited<ReturnType<typeof journey.initializeReviewedJoin>>;
let runtime: Awaited<ReturnType<typeof recordApplicationMessagingRuntime>>;
let idle: string;
beforeAll(async () => {
  h = await journey.initializeReviewedJoin();
  (await import('../auth.js')).setAuthRevocationStore(h.events);
  runtime = await recordApplicationMessagingRuntime(h.events);
  idle = await journey.joinReviewedParticipant({
    accountId: 'offline-personal',
    harness: 'codex',
    targetId: 'offline-observation',
  });
  const view = await h.api.view(h.group);
  for (const policy of view.policies)
    await h.api.setPolicy(h.group, {
      requestId: crypto.randomUUID(),
      expectedMembershipRevision: view.membershipRevision,
      expectedRevision: policy.revision,
      sessionId: policy.sessionId,
      readsFutureDiscussion: false,
      repliesByDefault: false,
    });
}, 30000);
async function releaseFixtureOwners() {
  const { registry } = await import('../chat.js');
  for (const id of [h?.joinedSessionId, idle]) {
    const live = id && registry.findBySessionId(id);
    if (live) registry.abort(live.clientId);
  }
  const { getRepositoryWorkspaces } = await import('../repository-workspace-runtime.js');
  await vi.waitFor(() => getRepositoryWorkspaces(true).closeIdle());
}
afterAll(async () => {
  await releaseFixtureOwners();
  runtime?.restore();
  await journey.close();
});

async function send(sessionId: string, text: string) {
  const view = await h.api.view(h.group);
  const input = {
    requestId: crypto.randomUUID(),
    expectedMembershipRevision: view.membershipRevision,
    expectedPolicySequence: view.policySequence,
    text,
    responders: { kind: 'selected' as const, sessionIds: [sessionId] },
    snapshot: null,
  };
  return { input, message: await h.api.send(h.group, input) };
}
const steer = (session: string, input: Record<string, unknown>) =>
  journey.state.http!.request('POST', `/api/sessions/${session}/codex-queue/steer`, {
    headers: { cookie: journey.state.cookie },
    body: input,
  });

it('separates active steering from idle ordinary delivery and preserves uncertainty without replay', async () => {
  const warm = await send(idle, 'Warm the idle seat');
  await vi.waitFor(async () =>
    expect((await h.api.observeSend(h.group, warm.input)).terminal).toBe(true),
  );
  runtime.holdTurn(2);
  const active = await send(h.joinedSessionId, 'Keep this exact seat active');
  await vi.waitFor(() =>
    expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(2),
  );
  await vi.waitFor(async () =>
    expect((await h.api.observeSend(h.group, active.input)).message!.deliveries[0].status).toBe(
      'delivered',
    ),
  );
  const activeCommand = active.message.deliveries[0].commandId!;
  const correction = {
    requestId: crypto.randomUUID(),
    targetCommandId: activeCommand,
    text: 'Use the corrected constraint',
  };
  expect(await steer(h.joinedSessionId, correction)).toMatchObject({
    status: 200,
    body: { requestId: correction.requestId, status: 'accepted' },
  });
  expect((await h.api.observeSend(h.group, active.input)).terminal).toBe(false);
  const stale = {
    requestId: crypto.randomUUID(),
    targetCommandId: warm.message.deliveries[0].commandId!,
    text: 'An idle seat has no active turn to correct',
  };
  expect(await steer(idle, stale)).toMatchObject({
    status: 409,
    body: { requestId: stale.requestId, status: 'stale_target' },
  });
  const ordinary = await send(idle, 'Deliver to the idle seat through ordinary admission');
  await vi.waitFor(async () =>
    expect((await h.api.observeSend(h.group, ordinary.input)).terminal).toBe(true),
  );
  expect(ordinary.message.deliveries[0].commandId).not.toBe(activeCommand);
  const corrections = runtime.requests.filter((r) => r.method === 'turn/steer');
  expect(corrections).toHaveLength(1);
  expect(corrections[0].params).toMatchObject({ expectedTurnId: 'private-native-turn-2' });
  expect(JSON.stringify(corrections[0].params)).toContain(correction.text);
  expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(3);
  const capabilities = (await runtime.requestTool(2, 'AgentCommunication', {
    operation: 'list',
    offset: 0,
  })) as { success: boolean; contentItems: Array<{ text: string }> };
  expect(capabilities.success, JSON.stringify(capabilities)).toBe(true);
  const listed = JSON.parse(capabilities.contentItems[0].text).chats as Array<{
    conversationId: string;
    capability: unknown;
  }>;
  expect(listed.find((chat) => chat.conversationId === idle)?.capability).toMatchObject({
    activeDelivery: 'steer',
    idleDelivery: 'queue',
    state: 'idle',
  });
  // The observational source has no admitted owner/custody. It must not be
  // advertised or silently converted into an idle peer command.
  expect(listed.some((chat) => chat.conversationId === 'existing-chat')).toBe(false);
  const refusedId = crypto.randomUUID();
  const refused = (await runtime.requestTool(2, 'AgentCommunication', {
    operation: 'send',
    requestId: refusedId,
    recipientConversationId: 'existing-chat',
    text: 'Unavailable owner must refuse',
  })) as { success: boolean; contentItems: Array<{ text: string }> };
  expect(refused.success).toBe(false);
  expect(JSON.parse(refused.contentItems[0].text)).toMatchObject({
    code: 'recipient_unavailable',
    stage: 'ownership',
    requestId: refusedId,
    recipientConversationId: 'existing-chat',
  });
  runtime.loseNextSteer();
  const uncertain = { ...correction, requestId: crypto.randomUUID(), text: 'Lost ACK correction' };
  expect(await steer(h.joinedSessionId, uncertain)).toMatchObject({
    status: 202,
    body: { status: 'uncertain' },
  });
  expect(await steer(h.joinedSessionId, uncertain)).toMatchObject({
    status: 202,
    body: { status: 'uncertain' },
  });
  expect(runtime.requests.filter((r) => r.method === 'turn/steer')).toHaveLength(2);
  expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(3);
  runtime.finishTurn(2, 'completed');
  await vi.waitFor(async () =>
    expect((await h.api.observeSend(h.group, active.input)).terminal).toBe(true),
  );
  const replies = (await h.api.view(h.group)).messages.filter(
    (m) => m.replyToDeliveryId === active.message.deliveries[0].deliveryId,
  );
  expect(replies).toHaveLength(1);
  expect(replies[0].author.sessionId).toBe(h.joinedSessionId);
  expect(replies[0].source?.commandId).toBe(activeCommand);
  // Neither acceptance nor this synthetic final answer claims the live provider
  // applied the requested correction to its reasoning.
}, 30000);

it('retains the originating seat and safe cause after transport retirement in the real application consumer', async () => {
  runtime.holdTurn(4);
  const active = await send(h.joinedSessionId, 'Retain this failed seat');
  await vi.waitFor(async () =>
    expect((await h.api.observeSend(h.group, active.input)).message!.deliveries[0].status).toBe(
      'delivered',
    ),
  );
  const cause = Object.assign(new TypeError('SECRET /private/account'), { code: 'EIO' });
  runtime.closeTurnTransport(4, cause);
  const { getCodexConversationStore } = await import('../codex-chat-session.js');
  const store = getCodexConversationStore();
  const binding = h.events.getSession(h.joinedSessionId)!.accountBinding!;
  const retained = store.commandLifecycle(
    h.joinedSessionId,
    binding,
    active.message.deliveries[0].commandId!,
  );
  expect(retained).toMatchObject({
    diagnostic: {
      lifecycle: {
        stage: 'transport',
        causeType: 'TypeError',
        causeCode: 'EIO',
        diagnosticId: expect.any(String),
      },
    },
  });
  const queue = await journey.state.http!.request(
    'GET',
    `/api/sessions/${h.joinedSessionId}/meta`,
    { headers: { cookie: journey.state.cookie } },
  );
  expect(queue.status).toBe(200);
  expect(JSON.stringify(queue.body)).toContain(retained.diagnostic!.lifecycle!.diagnosticId);
  await vi.waitFor(() =>
    expect(JSON.stringify(h.events.getSessionEvents(h.joinedSessionId))).toContain(
      retained.diagnostic!.lifecycle!.diagnosticId,
    ),
  );
  const failedEvent = h.events
    .getSessionEvents(h.joinedSessionId)
    .find(
      (event) =>
        event.payload.type === 'error' &&
        JSON.stringify(event.payload).includes(retained.diagnostic!.lifecycle!.diagnosticId),
    )!;
  expect(failedEvent.payload).toMatchObject({
    sessionId: h.joinedSessionId,
    runtimeFailure: {
      diagnosticId: retained.diagnostic!.lifecycle!.diagnosticId,
      runtimeFailureStage: 'transport',
      causeCode: 'EIO',
    },
  });
  const actions = parseServerMessage(
    failedEvent.payload as never,
    { currentSessionId: h.joinedSessionId },
    { onSessionAssigned() {}, onSessionExpired() {}, setWsRunning() {} },
    h.joinedSessionId,
  ).messagesActions;
  const consumer = actions.reduce(messagesReducer, INITIAL_MESSAGES_STATE);
  expect(JSON.stringify(consumer.messages)).toContain(retained.diagnostic!.lifecycle!.diagnosticId);
  expect(JSON.stringify(consumer)).not.toMatch(/SECRET|private\/account/);
  const view = await h.api.view(h.group);
  const original = view.messages.find((message) => message.messageId === active.message.messageId)!;
  expect(original.deliveries[0]).toMatchObject({
    sessionId: h.joinedSessionId,
    commandId: active.message.deliveries[0].commandId,
  });
  expect(JSON.stringify([retained, view])).not.toMatch(/SECRET|private\/account/);
  await h.api.observeSend(h.group, active.input);
  await h.api.observeSend(h.group, active.input);
  expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(4);
  await releaseFixtureOwners();
  runtime.restore();
  await journey.restartApplication();
  h = journey.getApplicationJoiningJourney();
  const restored = await journey.state.http!.request(
    'GET',
    `/api/sessions/${h.joinedSessionId}/meta`,
    { headers: { cookie: journey.state.cookie } },
  );
  expect(restored.status).toBe(200);
  expect(JSON.stringify(restored.body)).toContain(retained.diagnostic!.lifecycle!.diagnosticId);
  expect(JSON.stringify(restored.body)).not.toMatch(/SECRET|private\/account/);
  expect(runtime.requests.filter((r) => r.method === 'turn/start')).toHaveLength(4);
}, 30000);
