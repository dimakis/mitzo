import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';

let store: EventStore, directory: string, path: string, group: string;
const binding = {
  version: 2,
  account: { accountId: 'fixture', provider: 'openai-codex', profileRevision: 'r1' },
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
const settings = { binding, selection, repositoryWorkspaceId: 'workspace' };
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mitzo-attribution-'));
  path = join(directory, 'events.db');
  store = new EventStore(path);
  group = randomUUID();
  for (const sessionId of ['one', 'two', 'reader'])
    store.admitOrdinaryLocalCommand(
      {
        sessionId,
        selectedModel: selection.model,
        mode: 'agent',
        cwd: '/fixture',
        accountBinding: { ...binding.account, accountLabel: 'Fixture', model: selection.model },
        repositoryWorkspaceId: 'workspace',
      },
      binding,
      {
        clientMsgId: `initial-${sessionId}`,
        requestFingerprint: `fp-${sessionId}`,
        selection,
        payload: { text: 'Offline fixture' },
      },
    );
  store.setSessionCollaboration(group, {
    expectedRevision: 0,
    participantSessionIds: ['one', 'two', 'reader'],
  });
  store.collaborationConversation.setPolicy(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    expectedRevision: 0,
    sessionId: 'reader',
    readsFutureDiscussion: true,
    repliesByDefault: false,
  });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
function accepted() {
  return store.collaborationConversation.acceptMessage(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    expectedPolicySequence: store.collaborationConversation.view(group).policySequence,
    text: 'Review this',
    responders: { kind: 'selected', sessionIds: ['one', 'two'] },
    snapshot: null,
  });
}
function reply(message = accepted(), sessionId = 'two') {
  const delivery = message.deliveries.find((row) => row.sessionId === sessionId)!;
  store.collaborationConversation.recordDelivery(group, message.messageId, delivery.deliveryId, {
    requestId: randomUUID(),
    expectedRevision: 0,
    status: 'uncertain',
    commandId: `reply-${sessionId}`,
    reason: 'Provider acknowledgement interrupted',
  });
  return {
    requestId: randomUUID(),
    messageId: message.messageId,
    deliveryId: delivery.deliveryId,
    source: {
      conversationId: sessionId,
      commandId: `reply-${sessionId}`,
      messageId: 'visible-reply',
      blockIds: ['text-block'],
      throughSequence: 42,
    },
  };
}
const resolve = () => ({ text: 'Exact finalized reply', settings });

it('projects an exact ordinary reply without allocating a turn or changing recipient outcomes', () => {
  const message = accepted();
  const other = message.deliveries.find((delivery) => delivery.sessionId === 'one')!;
  const successful = store.collaborationConversation.recordDelivery(
    group,
    message.messageId,
    other.deliveryId,
    {
      requestId: randomUUID(),
      expectedRevision: 0,
      status: 'delivered',
      commandId: 'reply-one',
      reason: null,
    },
  );
  message.deliveries = message.deliveries.map((delivery) =>
    delivery.deliveryId === successful.deliveryId ? successful : delivery,
  );
  const input = reply(message);
  const projected = store.collaborationConversation.recordReply(group, input, resolve);
  expect(projected).toMatchObject({
    author: { sessionId: 'two' },
    text: 'Exact finalized reply',
    source: input.source,
    replyToDeliveryId: input.deliveryId,
    responders: [],
    readers: ['one', 'reader'],
    deliveries: [
      expect.objectContaining({
        sessionId: 'one',
        purpose: 'context',
        status: 'pending',
        revision: 0,
        commandId: null,
      }),
      expect.objectContaining({
        sessionId: 'reader',
        purpose: 'context',
        status: 'pending',
        revision: 0,
        commandId: null,
      }),
    ],
    settings: { one: settings, reader: settings },
  });
  const view = store.collaborationConversation.view(group);
  expect(view.messages).toHaveLength(2);
  expect(view.messages[0].deliveries).toEqual(
    message.deliveries.map((delivery) =>
      delivery.sessionId === 'two'
        ? {
            ...delivery,
            revision: 1,
            status: 'uncertain',
            commandId: 'reply-two',
            reason: 'Provider acknowledgement interrupted',
          }
        : delivery,
    ),
  );
  expect(store.getSessionEvents('two')).toEqual([]);
});

it('recovers exact retries before source or current membership checks, including after restart', () => {
  const input = reply();
  const result = store.collaborationConversation.recordReply(group, input, resolve);
  store.setSessionCollaboration(group, {
    expectedRevision: 1,
    participantSessionIds: ['one', 'reader'],
  });
  store.hideSession('two');
  store.close();
  store = new EventStore(path);
  const unavailable = vi.fn(() => {
    throw Error('Source no longer readable');
  });
  expect(store.collaborationConversation.recordReply(group, input, unavailable)).toEqual(result);
  expect(unavailable).not.toHaveBeenCalled();
  expect(() =>
    store.collaborationConversation.recordReply(
      group,
      { ...input, source: { ...input.source, commandId: 'different' } },
      unavailable,
    ),
  ).toThrow('request_conflict');
});

it('deduplicates the exact finalized message across distinct callbacks and refuses changed source pins', () => {
  const input = reply();
  const first = store.collaborationConversation.recordReply(group, input, resolve);
  expect(
    store.collaborationConversation.recordReply(
      group,
      { ...input, requestId: randomUUID() },
      resolve,
    ),
  ).toEqual(first);
  for (const source of [
    { ...input.source, blockIds: ['other-block'] },
    { ...input.source, throughSequence: 43 },
  ])
    expect(() =>
      store.collaborationConversation.recordReply(
        group,
        { ...input, requestId: randomUUID(), source },
        resolve,
      ),
    ).toThrow('reply_conflict');
  expect(store.collaborationConversation.view(group).messages).toHaveLength(2);
});

it('refuses unmapped commands, mismatched settings and context-only recipients without projection', () => {
  const message = accepted();
  const input = reply(message);
  for (const source of [
    { ...input.source, conversationId: 'one' },
    { ...input.source, commandId: 'other-command' },
  ])
    expect(() =>
      store.collaborationConversation.recordReply(
        group,
        { ...input, requestId: randomUUID(), source },
        resolve,
      ),
    ).toThrow('reply_conflict');
  expect(() => store.collaborationConversation.recordReply(group, input, () => undefined)).toThrow(
    'reply_unavailable',
  );
  expect(() =>
    store.collaborationConversation.recordReply(group, input, () => ({
      text: 'wrong settings',
      settings: { ...settings, repositoryWorkspaceId: 'other' },
    })),
  ).toThrow('reply_conflict');
  const reader = reply(message, 'reader');
  expect(() => store.collaborationConversation.recordReply(group, reader, resolve)).toThrow(
    'reply_conflict',
  );
  expect(store.collaborationConversation.view(group).messages).toHaveLength(1);
});

it('refuses empty or repeated text blocks and public text claims', () => {
  const input = reply();
  for (const blockIds of [[], ['text-block', 'text-block']])
    expect(() =>
      store.collaborationConversation.recordReply(
        group,
        { ...input, source: { ...input.source, blockIds } },
        resolve,
      ),
    ).toThrow();
  expect(() =>
    store.collaborationConversation.recordReply(
      group,
      { ...input, text: 'Caller supplied content' },
      resolve,
    ),
  ).toThrow();
});

it('binds an ordinary command to one reply-origin delivery across messages and collaborations', () => {
  const first = accepted();
  reply(first);
  const anotherGroup = randomUUID();
  store.setSessionCollaboration(anotherGroup, {
    expectedRevision: 0,
    participantSessionIds: ['one', 'two'],
  });
  for (const collaboration of [group, anotherGroup]) {
    const message = store.collaborationConversation.acceptMessage(collaboration, {
      requestId: randomUUID(),
      expectedMembershipRevision: 1,
      expectedPolicySequence: store.collaborationConversation.view(collaboration).policySequence,
      text: 'Another request',
      responders: { kind: 'selected', sessionIds: ['two'] },
      snapshot: null,
    });
    const delivery = message.deliveries.find((row) => row.sessionId === 'two')!;
    expect(() =>
      store.collaborationConversation.recordDelivery(
        collaboration,
        message.messageId,
        delivery.deliveryId,
        {
          requestId: randomUUID(),
          expectedRevision: 0,
          status: 'queued',
          commandId: 'reply-two',
          reason: null,
        },
      ),
    ).toThrow('reply_conflict');
    expect(
      store.collaborationConversation
        .view(collaboration)
        .messages.at(-1)
        ?.deliveries.find((row) => row.sessionId === 'two')?.status,
    ).toBe('pending');
  }
});

it.each(['context-first', 'reply-first'] as const)(
  'allows multiple context receipts beside one reply origin on the same ordinary command (%s)',
  (order) => {
    const contexts = [accepted(), accepted()];
    const response = store.collaborationConversation.acceptMessage(group, {
      requestId: randomUUID(),
      expectedMembershipRevision: 1,
      expectedPolicySequence: store.collaborationConversation.view(group).policySequence,
      text: 'Now please respond',
      responders: { kind: 'selected', sessionIds: ['reader'] },
      snapshot: null,
    });
    const contextTargets = contexts.map((message) => ({
      message,
      delivery: message.deliveries.find((delivery) => delivery.sessionId === 'reader')!,
    }));
    const responseTarget = {
      message: response,
      delivery: response.deliveries.find((delivery) => delivery.sessionId === 'reader')!,
    };
    const targets =
      order === 'context-first'
        ? [...contextTargets, responseTarget]
        : [responseTarget, ...contextTargets];
    const receipts = targets.map(({ message, delivery }) => {
      const input = {
        requestId: randomUUID(),
        expectedRevision: 0,
        status: 'queued' as const,
        commandId: 'ordinary-reader-turn',
        reason: null,
      };
      const receipt = store.collaborationConversation.recordDelivery(
        group,
        message.messageId,
        delivery.deliveryId,
        input,
      );
      expect(receipt).toMatchObject({
        commandId: 'ordinary-reader-turn',
        status: 'queued',
        purpose: delivery.purpose,
      });
      return { message, delivery, input, receipt };
    });
    for (const { message, delivery, input, receipt } of receipts) {
      store.collaborationConversation.recordDelivery(
        group,
        message.messageId,
        delivery.deliveryId,
        {
          requestId: randomUUID(),
          expectedRevision: 1,
          status: 'delivered',
          commandId: 'ordinary-reader-turn',
          reason: null,
        },
      );
      expect(
        store.collaborationConversation.recordDelivery(
          group,
          message.messageId,
          delivery.deliveryId,
          input,
        ),
      ).toEqual(receipt);
    }
    const source = {
      conversationId: 'reader',
      commandId: 'ordinary-reader-turn',
      messageId: 'reader-response',
      blockIds: ['text-block'],
      throughSequence: 42,
    };
    for (const { message, delivery } of contextTargets)
      expect(() =>
        store.collaborationConversation.recordReply(
          group,
          {
            requestId: randomUUID(),
            messageId: message.messageId,
            deliveryId: delivery.deliveryId,
            source,
          },
          resolve,
        ),
      ).toThrow('reply_conflict');
    expect(
      store.collaborationConversation.recordReply(
        group,
        {
          requestId: randomUUID(),
          messageId: response.messageId,
          deliveryId: responseTarget.delivery.deliveryId,
          source,
        },
        resolve,
      ),
    ).toMatchObject({
      author: { sessionId: 'reader' },
      replyToDeliveryId: responseTarget.delivery.deliveryId,
    });
    expect(store.getSessionEvents('reader')).toEqual([]);
  },
);
