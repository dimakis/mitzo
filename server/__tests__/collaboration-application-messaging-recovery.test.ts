import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventStore } from '../event-store.js';
import { ApplicationCollaborationMessaging } from '../collaboration-application-messaging.js';
import type {
  OrdinarySessionPrompt,
  OrdinarySessionPromptPort,
} from '../session-prompt-dispatch.js';
import {
  captureOrdinaryReplyExecution,
  recordOrdinaryReplySource,
} from '../collaboration-ordinary-replies.js';

vi.mock('../auth.js', () => ({ isAuthSessionCurrent: () => true }));
const diagnostics = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../logger.js', () => ({ createLogger: () => diagnostics }));

let store: EventStore;
let owner: ApplicationCollaborationMessaging;
let group: string;
let prompts: OrdinarySessionPrompt[];
const auth = { id: 'operator', expiresAt: Date.now() + 100000 };
const binding = {
  version: 2,
  account: { accountId: 'account', provider: 'openai-codex', profileRevision: 'r1' },
  harness: { implementation: 'codex' },
  execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
} as const;
const selection = {
  version: 1,
  agent: { profileId: 'default-mitzo', revision: 1, kind: 'builtin' },
  context: { source: 'none', revision: null },
  permission: { mode: 'agent', revision: 0 },
  model: 'offline-fixture',
  thinking: null,
} as const;

function port(
  deliverOrdinary: OrdinarySessionPromptPort['deliverOrdinary'],
): OrdinarySessionPromptPort {
  return {
    deliverOrdinary,
    authorized: () => true,
    inspect: async () => ({ busy: false }),
    receipt: () => 'absent',
    deliver: async () => {
      throw Error('Unexpected legacy delivery');
    },
    close: () => {},
  };
}

beforeEach(() => {
  diagnostics.warn.mockClear();
  store = new EventStore(':memory:');
  group = randomUUID();
  prompts = [];
  owner = new ApplicationCollaborationMessaging(
    store,
    port(async (prompt) => {
      prompts.push(prompt);
    }),
  );
  for (const sessionId of ['one', 'two']) {
    store.admitOrdinaryLocalCommand(
      {
        sessionId,
        cwd: '/fixture',
        mode: 'agent',
        repositoryWorkspaceId: 'workspace',
        accountBinding: { ...binding.account, accountLabel: 'Offline', model: selection.model },
      },
      binding,
      {
        clientMsgId: `initial-${sessionId}`,
        requestFingerprint: `fp-${sessionId}`,
        selection,
        payload: { text: 'Explicit initial prompt' },
      },
    );
    store.claimOrdinaryLocalCommandDispatch(`initial-${sessionId}`);
  }
  store.setSessionCollaboration(group, {
    expectedRevision: 0,
    participantSessionIds: ['one', 'two'],
  });
});
afterEach(() => {
  owner.close();
  store.close();
});

function input(responder: string, text: string) {
  const view = store.collaborationConversation.view(group);
  return {
    requestId: randomUUID(),
    expectedMembershipRevision: view.membershipRevision,
    expectedPolicySequence: view.policySequence,
    text,
    responders: { kind: 'selected' as const, sessionIds: [responder] },
    snapshot: null,
  };
}

it('observes recipient readiness without commands and refuses missing ordinary capability', async () => {
  const inspect = vi.fn(async () => {});
  const delivery = vi.fn(async () => {});
  const ordinary = port(delivery);
  Object.assign(ordinary, { inspectCollaboration: inspect });
  const messaging = new ApplicationCollaborationMessaging(store, ordinary);
  const signal = new AbortController().signal;
  const ready = await messaging.recipientReadiness(auth, group, 'one', signal);
  expect(ready).toMatchObject({
    collaborationId: group,
    sessionId: 'one',
    membershipRevision: 1,
    ready: true,
    reason: null,
  });
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(delivery).not.toHaveBeenCalled();
  expect(store.collaborationConversation.view(group).messages).toEqual([]);
  const missing = await owner.recipientReadiness(auth, group, 'one', signal);
  expect(missing.ready).toBe(false);
  inspect.mockRejectedValueOnce(
    new Error('Open a fresh group participant for this delivery route.'),
  );
  expect((await messaging.recipientReadiness(auth, group, 'one', signal)).ready).toBe(false);
  store.hideSession('one');
  expect((await messaging.recipientReadiness(auth, group, 'one', signal)).ready).toBe(false);
  expect(inspect).toHaveBeenCalledTimes(2);
});

it('retains a readiness failure diagnostic while refusing delivery without exposing its cause', async () => {
  const cause = new Error('Private native inspection failure');
  const delivery = vi.fn(async () => {});
  const ordinary = port(delivery);
  Object.assign(ordinary, { inspectCollaboration: vi.fn().mockRejectedValue(cause) });
  const messaging = new ApplicationCollaborationMessaging(store, ordinary);
  const result = await messaging.recipientReadiness(
    auth,
    group,
    'one',
    new AbortController().signal,
  );
  expect(result.ready).toBe(false);
  expect(result.reason).not.toContain(cause.message);
  expect(delivery).not.toHaveBeenCalled();
  expect(diagnostics.warn).toHaveBeenCalledWith(
    'Could not verify collaboration recipient readiness',
    expect.objectContaining({
      err: cause,
      code: 'collaboration_recipient_readiness_failed',
      stage: 'recipient_readiness',
      collaborationId: group,
      sessionId: 'one',
    }),
  );
});

it.each([false, true])(
  'preserves the first context ACK across overlapping commands (reverse=%s)',
  async (reverse) => {
    store.collaborationConversation.setPolicy(group, {
      requestId: randomUUID(),
      expectedMembershipRevision: 1,
      sessionId: 'two',
      expectedRevision: 0,
      readsFutureDiscussion: true,
      repliesByDefault: false,
    });
    const shared = store.collaborationConversation.acceptMessage(
      group,
      input('one', 'Unread discussion'),
    );
    const send = (text: string) =>
      owner.send(auth, group, input('two', text), new AbortController().signal);
    const first = await send('First reply');
    const second = await send('Second reply');
    expect(prompts).toHaveLength(2);
    expect(prompts[0].text).toContain(shared.text);
    expect(prompts[1].text).not.toContain(shared.text);
    const order = reverse ? [...prompts].reverse() : prompts;
    for (const prompt of order) {
      expect(() => prompt.turnLifecycle!.beforeDispatch(prompt.commandId)).not.toThrow();
      expect(() =>
        prompt.turnLifecycle!.accepted(prompt.commandId, 'thread', `turn-${prompt.commandId}`),
      ).not.toThrow();
    }
    const context = store.collaborationConversation
      .getMessage(group, shared.messageId)!
      .deliveries.find((d) => d.sessionId === 'two')!;
    expect(context).toMatchObject({
      purpose: 'context',
      status: 'delivered',
      commandId: prompts[0].commandId,
    });
    expect(context.revision).toBe(2);
    for (const [index, message] of [first, second].entries()) {
      expect(
        store.collaborationConversation
          .getMessage(group, message.messageId)!
          .deliveries.find((d) => d.sessionId === 'two'),
      ).toMatchObject({ status: 'delivered', commandId: prompts[index].commandId });
    }
  },
);

it('refuses an overlapping unclaimed fan-out reply without adopting or partially accepting it', async () => {
  let release!: () => void;
  const preparing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatch = vi.fn(async (prompt: OrdinarySessionPrompt) => {
    prompts.push(prompt);
    if (prompt.sessionId === 'one') await preparing;
  });
  owner = new ApplicationCollaborationMessaging(store, port(dispatch));
  const first = owner.send(
    auth,
    group,
    {
      ...input('one', 'Reply independently'),
      responders: { kind: 'all' },
    },
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(prompts).toHaveLength(1));
  try {
    await expect(
      owner.send(auth, group, input('two', 'Overlapping reply'), new AbortController().signal),
    ).rejects.toThrow('execution_unavailable');
    const retained = store.collaborationConversation.view(group).messages;
    expect(retained).toHaveLength(1);
    expect(retained[0].deliveries.find((d) => d.sessionId === 'two')).toMatchObject({
      status: 'pending',
      commandId: null,
    });
    expect(prompts).toHaveLength(1);
  } finally {
    release();
    await first;
  }
  expect(prompts).toHaveLength(2);
  expect(prompts[0].commandId).not.toBe(prompts[1].commandId);
  for (const prompt of prompts)
    prompt.turnLifecycle!.accepted(prompt.commandId, 'thread', prompt.commandId);
  expect(
    store.collaborationConversation
      .view(group)
      .messages[0].deliveries.every((d) => d.status === 'delivered'),
  ).toBe(true);
});

it('returns the original receipt for concurrent exact fan-out retries during preparation', async () => {
  let release!: () => void;
  const preparing = new Promise<void>((resolve) => {
    release = resolve;
  });
  owner = new ApplicationCollaborationMessaging(
    store,
    port(async (prompt) => {
      prompts.push(prompt);
      if (prompt.sessionId === 'one') await preparing;
    }),
  );
  const request = { ...input('one', 'Answer independently'), responders: { kind: 'all' } };
  const first = owner.send(auth, group, request, new AbortController().signal);
  const retry = owner.send(auth, group, request, new AbortController().signal);
  let original;
  let retained;
  try {
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    retained = await retry;
    expect(store.collaborationConversation.view(group).messages).toHaveLength(1);
    expect(retained.deliveries.find((d) => d.sessionId === 'two')).toMatchObject({
      status: 'pending',
      commandId: null,
    });
    expect(prompts).toHaveLength(1);
  } finally {
    release();
    original = await first;
  }
  expect(retained!.messageId).toBe(original.messageId);
  expect(prompts).toHaveLength(2);
  expect(new Set(prompts.map((p) => p.commandId)).size).toBe(2);
});

it('keeps a just-admitted command readable before its first ordinary transcript event', () => {
  const message = store.collaborationConversation.acceptMessage(group, input('two', 'Reply'));
  const delivery = message.deliveries.find((d) => d.sessionId === 'two')!;
  store.collaborationConversation.recordDelivery(group, message.messageId, delivery.deliveryId, {
    requestId: randomUUID(),
    expectedRevision: 0,
    status: 'queued',
    commandId: 'initial-two',
    reason: null,
  });
  expect(store.getSessionPredecessorSeq('two', Number.MAX_SAFE_INTEGER)).toBe(0);
  const transcript = vi.spyOn(store, 'getDurableSessionTranscript');
  expect(() => owner.reconcile(auth, group)).not.toThrow();
  expect(transcript).not.toHaveBeenCalled();
  expect(store.collaborationConversation.view(group).messages).toHaveLength(1);
});

it('defers oversized ordinary history without failing group reads or hiding integrity failures', () => {
  const message = store.collaborationConversation.acceptMessage(group, input('two', 'Reply'));
  const delivery = message.deliveries.find((d) => d.sessionId === 'two')!;
  store.collaborationConversation.recordDelivery(group, message.messageId, delivery.deliveryId, {
    requestId: randomUUID(),
    expectedRevision: 0,
    status: 'queued',
    commandId: 'initial-two',
    reason: null,
  });
  store.append('two', 'message_start', { messageId: 'large' });
  store.append('two', 'block_start', { messageId: 'large', blockId: 'text', blockType: 'text' });
  store.append('two', 'block_delta', {
    messageId: 'large',
    blockId: 'text',
    delta: 'x'.repeat(513 * 1024),
  });
  store.append('two', 'block_end', { messageId: 'large', blockId: 'text', blockType: 'text' });
  store.append('two', 'message_end', { messageId: 'large' });
  expect(() => store.getDurableSessionTranscript('two')).toThrow();
  expect(() => owner.reconcile(auth, group)).not.toThrow();
  expect(store.collaborationConversation.view(group).messages).toHaveLength(1);
  vi.spyOn(store, 'getDurableSessionTranscript').mockImplementation(() => {
    throw Error('Broken ledger');
  });
  expect(() => owner.reconcile(auth, group)).toThrow('Broken ledger');
});

it.each(['hide', 'unlink'] as const)(
  'keeps group reads available without reading a revoked late reply (%s)',
  (action) => {
    const message = store.collaborationConversation.acceptMessage(
      group,
      input('two', 'Reply explicitly'),
    );
    const delivery = message.deliveries.find((d) => d.sessionId === 'two')!;
    store.collaborationConversation.recordDelivery(group, message.messageId, delivery.deliveryId, {
      requestId: randomUUID(),
      expectedRevision: delivery.revision,
      status: 'queued',
      commandId: 'initial-two',
      reason: null,
    });
    const source = {
      commandId: 'initial-two',
      messageId: 'answer',
      providerThreadId: 'thread',
      providerTurnId: 'turn',
    };
    const execution = captureOrdinaryReplyExecution(store, 'two', source);
    recordOrdinaryReplySource(store, 'two', source, execution);
    store.append('two', 'message_start', { messageId: 'answer' });
    store.append('two', 'block_start', { messageId: 'answer', blockId: 'text', blockType: 'text' });
    store.append('two', 'block_delta', {
      messageId: 'answer',
      blockId: 'text',
      delta: 'Late private answer',
    });
    store.append('two', 'block_end', { messageId: 'answer', blockId: 'text', blockType: 'text' });
    store.append('two', 'message_end', { messageId: 'answer' });
    if (action === 'hide') store.hideSession('two');
    else
      store.setSessionCollaboration(group, { expectedRevision: 1, participantSessionIds: ['one'] });
    const transcript = vi.spyOn(store, 'getDurableSessionTranscript');
    expect(() => owner.reconcile(auth, group)).not.toThrow();
    expect(() => owner.reconcile(auth, group)).not.toThrow();
    expect(transcript).not.toHaveBeenCalled();
    expect(store.collaborationConversation.view(group).messages).toHaveLength(1);
  },
);
