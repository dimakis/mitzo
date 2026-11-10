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

function shareWithReader() {
  store.collaborationConversation.setPolicy(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    sessionId: 'two',
    expectedRevision: 0,
    readsFutureDiscussion: true,
    repliesByDefault: false,
  });
}

function acknowledgeRecordedPrompts() {
  owner = new ApplicationCollaborationMessaging(
    store,
    port(async (prompt) => {
      prompts.push(prompt);
      prompt.turnLifecycle!.beforeDispatch(prompt.commandId);
      prompt.turnLifecycle!.accepted(prompt.commandId, 'thread', `turn-${prompt.commandId}`);
    }),
  );
}

it('keeps readiness and new explicit sends available after the display page overflows', async () => {
  acknowledgeRecordedPrompts();
  const ordinary = port(async () => {});
  Object.assign(ordinary, { inspectCollaboration: vi.fn(async () => {}) });
  const readiness = new ApplicationCollaborationMessaging(store, ordinary);
  for (let i = 0; i < 55; i++)
    await owner.send(auth, group, input('one', `Completed ${i}`), new AbortController().signal);
  expect(store.collaborationConversation.view(group).hasEarlierMessages).toBe(true);
  expect(
    (await readiness.recipientReadiness(auth, group, 'one', new AbortController().signal)).ready,
  ).toBe(true);
  const request = input('one', 'Continue the long conversation');
  const accepted = await owner.send(auth, group, request, new AbortController().signal);
  expect(prompts).toHaveLength(56);
  expect(prompts.at(-1)!.text).not.toContain('Completed 0');
  await owner.send(auth, group, request, new AbortController().signal);
  expect(prompts).toHaveLength(56);
  expect(accepted.deliveries[0].status).toBe('delivered');
  readiness.close();
});

it('delivers every old pending reader item once across keyset pages and owner restart', async () => {
  shareWithReader();
  acknowledgeRecordedPrompts();
  const old = [];
  for (let i = 0; i < 105; i++)
    old.push(
      await owner.send(
        auth,
        group,
        input('one', `Ordered context ${i}`),
        new AbortController().signal,
      ),
    );
  owner.close();
  acknowledgeRecordedPrompts();
  const request = input('two', 'Review all retained discussion');
  const accepted = await owner.send(auth, group, request, new AbortController().signal);
  const packet = JSON.parse(prompts.at(-1)!.text.split('\n')[2]);
  expect(packet.discussion.map((m: { text: string }) => m.text)).toEqual([
    ...old.map((m) => m.text),
    request.text,
  ]);
  for (const message of old)
    expect(
      store.collaborationConversation
        .getMessage(group, message.messageId)!
        .deliveries.find((d) => d.sessionId === 'two'),
    ).toMatchObject({ status: 'delivered', commandId: accepted.deliveries[0].commandId });
  await owner.send(auth, group, request, new AbortController().signal);
  expect(prompts).toHaveLength(106);
  await owner.send(auth, group, input('two', 'Next explicit turn'), new AbortController().signal);
  expect(prompts.at(-1)!.text).not.toContain('Ordered context');
});

it('refuses an old unclaimed reply outside the display page before accepting another request', async () => {
  const original = store.collaborationConversation.acceptMessage(
    group,
    input('two', 'Still unclaimed'),
  );
  acknowledgeRecordedPrompts();
  for (let i = 0; i < 55; i++)
    await owner.send(
      auth,
      group,
      input('one', `Later completed ${i}`),
      new AbortController().signal,
    );
  const before = store.collaborationConversation.view(group);
  const request = input('two', 'Do not steal the old request');
  await expect(owner.send(auth, group, request, new AbortController().signal)).rejects.toThrow(
    'execution_unavailable',
  );
  expect(store.collaborationConversation.getMessageForRequest(group, request)).toBeNull();
  expect(store.collaborationConversation.view(group).cursor).toBe(before.cursor);
  expect(
    store.collaborationConversation.getMessage(group, original.messageId)!.deliveries[0].commandId,
  ).toBeNull();
  expect(prompts).toHaveLength(55);
});

it.each(['plain', 'escaped'] as const)(
  'refuses an oversized pending packet (%s) without accepting or claiming it',
  async (encoding) => {
    shareWithReader();
    acknowledgeRecordedPrompts();
    const text = encoding === 'plain' ? 'x'.repeat(90000) : '\u0000'.repeat(20000);
    const old = [];
    for (let i = 0; i < 6; i++)
      old.push(
        await owner.send(auth, group, input('one', `${i}${text}`), new AbortController().signal),
      );
    const before = store.collaborationConversation.view(group);
    const request = input('two', 'Oversized reader backlog');
    await expect(owner.send(auth, group, request, new AbortController().signal)).rejects.toThrow(
      'capacity_refused',
    );
    expect(store.collaborationConversation.getMessageForRequest(group, request)).toBeNull();
    expect(store.collaborationConversation.view(group).cursor).toBe(before.cursor);
    for (const message of old)
      expect(
        store.collaborationConversation
          .getMessage(group, message.messageId)!
          .deliveries.find((d) => d.sessionId === 'two'),
      ).toMatchObject({ commandId: null, status: 'pending' });
    expect(prompts).toHaveLength(6);
  },
);

it('does not restore old reader authority after unlinking and rejoining', async () => {
  shareWithReader();
  acknowledgeRecordedPrompts();
  for (let i = 0; i < 55; i++)
    await owner.send(
      auth,
      group,
      input('one', `Old membership ${i}`),
      new AbortController().signal,
    );
  store.setSessionCollaboration(group, { expectedRevision: 1, participantSessionIds: ['one'] });
  store.setSessionCollaboration(group, {
    expectedRevision: 2,
    participantSessionIds: ['one', 'two'],
  });
  const request = input('two', 'Rejoining does not authorize old context');
  await expect(owner.send(auth, group, request, new AbortController().signal)).rejects.toThrow();
  expect(store.collaborationConversation.getMessageForRequest(group, request)).toBeNull();
  expect(prompts).toHaveLength(55);
});

it.each([false, true])(
  'renews old attributed reply visibility before the reader turn (hidden=%s)',
  async (hidden) => {
    store.collaborationConversation.setPolicy(group, {
      requestId: randomUUID(),
      expectedMembershipRevision: 1,
      sessionId: 'one',
      expectedRevision: 0,
      readsFutureDiscussion: true,
      repliesByDefault: false,
    });
    retainedPrompt();
    finalizedAnswer('Old attributed reviewer answer');
    owner.reconcile(auth, group);
    acknowledgeRecordedPrompts();
    for (let i = 0; i < 55; i++)
      await owner.send(
        auth,
        group,
        input('two', `Later discussion ${i}`),
        new AbortController().signal,
      );
    expect(
      store.collaborationConversation
        .view(group)
        .messages.some((m) => m.text === 'Old attributed reviewer answer'),
    ).toBe(false);
    if (hidden) store.hideSession('two');
    const request = input('one', 'Read the old answer and respond');
    if (hidden) {
      await expect(owner.send(auth, group, request, new AbortController().signal)).rejects.toThrow(
        'snapshot_changed',
      );
      expect(store.collaborationConversation.getMessageForRequest(group, request)).toBeNull();
      expect(prompts).toHaveLength(55);
    } else {
      await owner.send(auth, group, request, new AbortController().signal);
      const packet = JSON.parse(prompts.at(-1)!.text.split('\n')[2]);
      expect(packet.discussion).toContainEqual(
        expect.objectContaining({
          text: 'Old attributed reviewer answer',
          author: { sessionId: 'two' },
          source: expect.objectContaining({ conversationId: 'two', commandId: 'initial-two' }),
        }),
      );
      await owner.send(
        auth,
        group,
        input('one', 'Continue once more'),
        new AbortController().signal,
      );
      expect(prompts.at(-1)!.text).not.toContain('Old attributed reviewer answer');
    }
  },
);

it('keeps unexpected pending-inventory failures observable without accepting a request', async () => {
  const cause = Error('Synthetic storage read failure');
  vi.spyOn(store.collaborationConversation, 'pendingDeliveryPage').mockImplementation(() => {
    throw cause;
  });
  const request = input('one', 'Do not hide the storage failure');
  await expect(owner.send(auth, group, request, new AbortController().signal)).rejects.toBe(cause);
  expect(store.collaborationConversation.getMessageForRequest(group, request)).toBeNull();
  expect(prompts).toEqual([]);
});

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

it.each(
  (
    ['completed', 'failed', 'interrupted', 'stopped', 'server_restart', 'abandoned'] as const
  ).flatMap((reason) =>
    (['available', 'hidden', 'unlinked'] as const).map((availability) => ({
      reason,
      availability,
    })),
  ),
)(
  'observes the exact durable $reason outcome with a $availability recipient without a transcript or resend',
  async ({ reason, availability }) => {
    const request = input('one', 'A prompt with no visible answer');
    await owner.send(auth, group, request, new AbortController().signal);
    const prompt = prompts[0];
    store.completeOrdinaryLocalCommand('initial-one');
    store.admitOrdinaryLocalContinuation(
      {
        sessionId: 'one',
        cwd: '/fixture',
        mode: 'agent',
        repositoryWorkspaceId: 'workspace',
        accountBinding: { ...binding.account, accountLabel: 'Offline', model: selection.model },
      },
      binding,
      {
        clientMsgId: prompt.commandId,
        requestFingerprint: 'terminal-fixture',
        selection,
        payload: { text: prompt.text },
      },
    );
    store.claimOrdinaryLocalCommandDispatch(prompt.commandId);
    store.append('one', 'user_message', { messageId: prompt.commandId, text: prompt.text });
    prompt.turnLifecycle!.accepted(prompt.commandId, 'thread', 'turn');
    const execution = store.beginExecution(
      'one',
      randomUUID(),
      prompt.commandId,
      'terminal-fixture',
    );
    expect(owner.observe(auth, group, request).terminal).toBe(false);
    store.transitionExecution(execution.token, 'TERMINAL', reason);
    if (reason === 'completed' || reason === 'failed' || reason === 'interrupted') {
      store.recordOrdinaryProviderTurnTerminal('one', prompt.commandId, reason);
      store.recordOrdinaryProviderTurnTerminal('one', prompt.commandId, reason);
      expect(store.getEventsOfType('one', 'ordinary_provider_turn_terminal')).toHaveLength(1);
      expect(() =>
        store.recordOrdinaryProviderTurnTerminal('two', prompt.commandId, reason),
      ).toThrow('identity');
      expect(() =>
        store.recordOrdinaryProviderTurnTerminal(
          'one',
          prompt.commandId,
          reason === 'failed' ? 'completed' : 'failed',
        ),
      ).toThrow('Conflicting');
    }
    if (availability === 'hidden') store.hideSession('one');
    if (availability === 'unlinked')
      store.setSessionCollaboration(group, { expectedRevision: 1, participantSessionIds: ['two'] });
    const transcript = vi.spyOn(store, 'getDurableSessionTranscript');
    const observed = owner.observe(auth, group, request);
    if (availability !== 'available') expect(transcript).not.toHaveBeenCalled();
    expect(observed.terminal).toBe(['completed', 'failed', 'interrupted'].includes(reason));
    expect(observed.message?.deliveries[0].status).toBe('delivered');
    expect(prompts).toHaveLength(1);
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

it('does not read unrelated oversized history and preserves unexpected source failures', () => {
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
  vi.spyOn(store, 'getOrdinaryReplySourcePage').mockImplementation(() => {
    throw Error('Broken ledger');
  });
  expect(() => owner.reconcile(auth, group)).toThrow('Broken ledger');
});

function retainedPrompt() {
  const message = store.collaborationConversation.acceptMessage(group, input('two', 'Reply'));
  const delivery = message.deliveries.find((d) => d.sessionId === 'two')!;
  store.collaborationConversation.recordDelivery(group, message.messageId, delivery.deliveryId, {
    requestId: randomUUID(),
    expectedRevision: 0,
    status: 'queued',
    commandId: 'initial-two',
    reason: null,
  });
  return { message, delivery };
}

function finalizedAnswer(text = 'Retained answer', beforeEnd?: (id: string) => void) {
  const messageId = randomUUID();
  const source = {
    commandId: 'initial-two',
    messageId,
    providerThreadId: 'thread',
    providerTurnId: 'turn',
  };
  recordOrdinaryReplySource(
    store,
    'two',
    source,
    captureOrdinaryReplyExecution(store, 'two', source),
  );
  store.append('two', 'message_start', { messageId });
  store.append('two', 'block_start', { messageId, blockId: 'text', blockType: 'text' });
  store.append('two', 'block_delta', { messageId, blockId: 'text', delta: text });
  store.append('two', 'block_end', { messageId, blockId: 'text' });
  beforeEnd?.(messageId);
  store.append('two', 'message_end', { messageId });
  return source;
}

it.each([
  'providerThreadId',
  'providerTurnId',
  'executionFingerprint',
  'version',
  'unknown fingerprint',
] as const)('refuses malformed retained %s with a valid finalized message identity', (field) => {
  retainedPrompt();
  // Simulate malformed legacy/corrupt retained evidence, not the validated writer.
  const append = store.append.bind(store);
  const corrupt = vi.spyOn(store, 'append').mockImplementation((session, type, payload) =>
    append(
      session,
      type,
      type === 'ordinary_reply_source'
        ? {
            ...payload,
            [field === 'unknown fingerprint' ? 'executionFingerprint' : field]:
              field === 'version'
                ? 'unknown'
                : field === 'unknown fingerprint'
                  ? 'forged'
                  : 'x'.repeat(100001),
          }
        : payload,
    ),
  );
  finalizedAnswer();
  corrupt.mockRestore();
  expect(() => owner.reconcile(auth, group)).not.toThrow();
  expect(store.collaborationConversation.view(group).messages).toHaveLength(1);
  finalizedAnswer('Later eligible answer');
  owner.reconcile(auth, group);
  expect(store.collaborationConversation.view(group).messages.at(-1)?.text).toBe(
    'Later eligible answer',
  );
  expect(diagnostics.warn).toHaveBeenCalledWith(
    'Could not project finalized collaboration reply',
    expect.objectContaining({ code: 'reply_conflict' }),
  );
});

it('refuses an empty finalized answer without poisoning subsequent reads', () => {
  retainedPrompt();
  finalizedAnswer('');
  expect(() => owner.reconcile(auth, group)).not.toThrow();
  expect(store.collaborationConversation.view(group).messages).toHaveLength(1);
  finalizedAnswer('Later eligible answer');
  owner.reconcile(auth, group);
  expect(store.collaborationConversation.view(group).messages.at(-1)?.text).toBe(
    'Later eligible answer',
  );
});

it('uses only the retained source fingerprint when historical execution is ambiguous', () => {
  retainedPrompt();
  finalizedAnswer();
  const read = store.readOrdinaryCommandExecutionEvidence.bind(store);
  vi.spyOn(store, 'readOrdinaryCommandExecutionEvidence').mockImplementation(
    (command, fingerprint) => {
      if (!fingerprint) throw Error('Exact historical execution fingerprint required');
      return read(command, fingerprint);
    },
  );
  expect(() => owner.reconcile(auth, group)).not.toThrow();
  expect(store.collaborationConversation.view(group).messages.at(-1)?.text).toBe('Retained answer');
});

it.each(['queued interleaving', '501 messages', '512 KiB'] as const)(
  'recovers an independently finalized reply despite %s and never resends',
  (history) => {
    const { delivery } = retainedPrompt();
    if (history === '501 messages')
      for (let i = 0; i < 501; i++)
        store.append('two', 'user_message', { messageId: `old-${i}`, text: 'Old prompt' });
    if (history === '512 KiB')
      for (let i = 0; i < 6; i++)
        store.append('two', 'user_message', { messageId: `old-${i}`, text: 'x'.repeat(100000) });
    finalizedAnswer(
      'Retained answer',
      history === 'queued interleaving'
        ? () => {
            store.append('two', 'user_message', { messageId: 'queued', text: 'Next prompt' });
          }
        : undefined,
    );
    expect(() => store.getDurableSessionTranscript('two')).toThrow();
    owner.reconcile(auth, group);
    const view = store.collaborationConversation.view(group);
    expect(view.messages.find((m) => m.replyToDeliveryId === delivery.deliveryId)?.text).toBe(
      'Retained answer',
    );
    owner.reconcile(auth, group);
    expect(store.collaborationConversation.view(group)).toEqual(view);
    expect(prompts).toEqual([]);
  },
);

it.each([100001, 500001, 101])(
  'refuses an oversized source (%i) while recovering later answers',
  (size) => {
    retainedPrompt();
    finalizedAnswer(
      size === 101 ? 'First block' : 'x'.repeat(size),
      size === 101
        ? (messageId) => {
            for (let i = 0; i < 100; i++) {
              const blockId = `extra-${i}`;
              store.append('two', 'block_start', { messageId, blockId, blockType: 'text' });
              store.append('two', 'block_delta', { messageId, blockId, delta: 'x' });
              store.append('two', 'block_end', { messageId, blockId });
            }
          }
        : undefined,
    );
    expect(() => owner.reconcile(auth, group)).not.toThrow();
    expect(store.collaborationConversation.view(group).messages).toHaveLength(1);
    finalizedAnswer('Later eligible answer');
    owner.reconcile(auth, group);
    expect(store.collaborationConversation.view(group).messages.at(-1)?.text).toBe(
      'Later eligible answer',
    );
    expect(prompts).toEqual([]);
  },
);

it('recovers an older prompt outside the visible page after owner restart', () => {
  const { delivery } = retainedPrompt();
  for (let i = 0; i < 60; i++)
    store.collaborationConversation.acceptMessage(group, input('one', `Later ${i}`));
  finalizedAnswer();
  expect(
    store.collaborationConversation
      .view(group)
      .messages.some((m) => m.deliveries.some((d) => d.deliveryId === delivery.deliveryId)),
  ).toBe(false);
  owner.close();
  owner = new ApplicationCollaborationMessaging(
    store,
    port(async (p) => {
      prompts.push(p);
    }),
  );
  owner.reconcile(auth, group);
  expect(
    store.collaborationConversation
      .view(group)
      .messages.find((m) => m.replyToDeliveryId === delivery.deliveryId)?.text,
  ).toBe('Retained answer');
  expect(prompts).toEqual([]);
});

it('paginates malformed source identities without hiding later eligible answers', () => {
  retainedPrompt();
  for (let i = 0; i < 55; i++)
    store.append('two', 'ordinary_reply_source', {
      version: 2,
      commandId: 'initial-two',
      messageId: i % 2 ? ' ' : 'x'.repeat(100001),
      providerThreadId: 'thread',
      providerTurnId: 'turn',
      executionFingerprint: 'fixture',
    });
  finalizedAnswer();
  expect(() => owner.reconcile(auth, group)).not.toThrow();
  expect(store.collaborationConversation.view(group).messages.at(-1)?.text).toBe('Retained answer');
  expect(prompts).toEqual([]);
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
