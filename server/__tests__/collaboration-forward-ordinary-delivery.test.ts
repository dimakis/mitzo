import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { EventStore } from '../event-store.js';
import { OrdinaryCollaborationDelivery } from '../collaboration-ordinary-delivery.js';
import { prepareCollaborationForward } from '../collaboration-forwarding.js';
import { createCollaborationContextSource } from '../collaboration-context-source.js';

const settings = {
  binding: {
    version: 2,
    account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'mac', targetRevision: 'r1' },
  },
  selection: {
    version: 1,
    agent: { profileId: 'default-mitzo', revision: 1, kind: 'builtin' },
    context: { source: 'none', revision: null },
    permission: { mode: 'ask', revision: 0 },
    model: 'offline-fixture',
    thinking: null,
  },
} as const;
const fullContent = 'The complete forwarded block must reach the recipient, not only the note.';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const signal = () => new AbortController().signal;
let store: EventStore, group: string;
const authorize = vi.fn(async () => {});
const assertBeforeDispatch = vi.fn();
const assertProviderAccepted = vi.fn();
beforeEach(() => {
  store = new EventStore(':memory:');
  group = randomUUID();
  for (const sessionId of ['source', 'recipient']) {
    store.admitOrdinaryLocalCommand(
      {
        sessionId,
        accountBinding: {
          ...settings.binding.account,
          accountLabel: 'Offline',
          model: settings.selection.model,
        },
        repositoryWorkspaceId: 'workspace',
        cwd: '/offline',
        selectedModel: settings.selection.model,
        mode: 'ask',
      },
      settings.binding,
      {
        clientMsgId: `command-${sessionId}`,
        requestFingerprint: `fingerprint-${sessionId}`,
        selection: settings.selection,
        payload: { text: 'Explicit ordinary command' },
      },
    );
    store.claimOrdinaryLocalCommandDispatch(`command-${sessionId}`);
  }
  store.setSessionCollaboration(group, {
    expectedRevision: 0,
    participantSessionIds: ['source', 'recipient'],
  });
  authorize.mockClear();
  assertBeforeDispatch.mockClear();
  assertProviderAccepted.mockClear();
});
afterEach(() => store.close());

async function confirmedForward(note: string) {
  const sequence = store.append('source', 'user_message', {
    messageId: 'original',
    text: fullContent,
  });
  const selection = {
    requestId: randomUUID(),
    target: { collaborationId: group, expectedMembershipRevision: 1, sessionIds: ['recipient'] },
    sourceConversationId: 'source',
    boundary: { sequence, messageId: 'original' },
    messages: [
      {
        messageId: 'original',
        sequence,
        blocks: [{ blockId: 'user-original', sha256: hash(fullContent) }],
      },
    ],
    artifacts: [],
  };
  const reserved = store.collaborationConversation.reserveForwardPreparation(group, {
    operatorId: 'operator',
    input: { selection, note },
  });
  const source = createCollaborationContextSource({
    store,
    authorizeConversation: async () => {},
    assertConversationCurrent: () => {},
  });
  const packet = await prepareCollaborationForward(selection, {
    source,
    authorizeTarget: async () => {},
  });
  const assertCurrent = () => {
    source.assertCurrentAtSave();
    packet.assertLocalMaterialCurrent();
  };
  const prepared = store.collaborationConversation.completeForwardPreparation(
    group,
    selection.requestId,
    {
      operatorId: 'operator',
      serialized: packet.serialized,
      packetSha256: packet.sha256,
    },
    assertCurrent,
  );
  const confirmation = store.collaborationConversation.confirmForward(
    group,
    {
      operatorId: 'operator',
      input: {
        requestId: randomUUID(),
        expectedMembershipRevision: 1,
        forward: {
          forwardId: reserved.forwardId,
          packetSha256: prepared.packetSha256!,
          selectionFingerprint: prepared.selectionFingerprint,
        },
        requestReply: false,
      },
    },
    assertCurrent,
  );
  const delivery = confirmation.deliveries[0];
  const ref = {
    collaborationId: group,
    messageId: confirmation.messageId,
    deliveryId: delivery.deliveryId,
  };
  const owner = new OrdinaryCollaborationDelivery(store, {
    authorize,
    assertBeforeDispatch,
    assertProviderAccepted,
  });
  const current = () =>
    store.collaborationConversation.getMessage(group, confirmation.messageId)!.deliveries[0];
  return { owner, ref, current };
}

it.each(['Operator note', ''])(
  'refuses unsupported forwarded content before staging or a note-only ACK (%j)',
  async (note) => {
    const f = await confirmedForward(note);
    let refusal: unknown;
    try {
      f.owner.stage({
        sessionId: 'recipient',
        commandId: 'command-recipient',
        deliveries: [f.ref],
      });
    } catch (error) {
      refusal = error;
    }
    if (!refusal) {
      // Exercise the actual pre-fix defect: retained full bytes disappear, but the
      // existing exact-context ACK path can still mark their receipt delivered.
      const omitted = await f.owner.prepareSystemPrompt(
        'recipient',
        'command-recipient',
        undefined,
        signal(),
      );
      expect(omitted).not.toContain(fullContent);
      f.owner.beforeDispatch('recipient', 'command-recipient');
      f.owner.accepted('recipient', 'command-recipient', 'thread', 'turn', omitted!);
      expect(f.current().status).toBe('delivered');
    }
    expect(refusal).toMatchObject({ code: 'execution_unavailable' });
    expect(store.getOrdinaryCollaborationDeliveryEvents('recipient', 'command-recipient')).toEqual(
      [],
    );
    expect(f.current()).toMatchObject({
      status: 'pending',
      commandId: null,
      revision: 0,
      purpose: 'context',
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(assertBeforeDispatch).not.toHaveBeenCalled();
    expect(assertProviderAccepted).not.toHaveBeenCalled();
  },
);

it('preserves existing command and recipient error precedence', async () => {
  const f = await confirmedForward('Note');
  expect(() =>
    f.owner.stage({ sessionId: 'recipient', commandId: 'missing', deliveries: [f.ref] }),
  ).toThrow('reply_conflict');
  expect(() =>
    f.owner.stage({ sessionId: 'source', commandId: 'command-source', deliveries: [f.ref] }),
  ).toThrow('reply_conflict');
  expect(f.current().status).toBe('pending');
  expect(store.getOrdinaryCollaborationDeliveryEvents('recipient', 'command-recipient')).toEqual(
    [],
  );
});

it('keeps an unstaged ACK observational and cannot mark an unsupported forward delivered', async () => {
  const f = await confirmedForward('Note');
  expect(() =>
    f.owner.stage({ sessionId: 'recipient', commandId: 'command-recipient', deliveries: [f.ref] }),
  ).toThrow('execution_unavailable');
  const observeExisting = vi.fn();
  f.owner.accepted('recipient', 'command-recipient', 'thread', 'turn', 'Note', observeExisting);
  expect(observeExisting).toHaveBeenCalledOnce();
  expect(assertProviderAccepted).not.toHaveBeenCalled();
  expect(f.current()).toMatchObject({ status: 'pending', commandId: null });
  expect(store.getOrdinaryCollaborationDeliveryEvents('recipient', 'command-recipient')).toEqual(
    [],
  );
});
