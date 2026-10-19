import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import {
  OrdinaryCollaborationReplies,
  recordOrdinaryReplySource,
} from '../collaboration-ordinary-replies.js';
import { OrdinaryCollaborationDelivery } from '../collaboration-ordinary-delivery.js';

let store: EventStore, directory: string, path: string, group: string;
const binding = {
  version: 2,
  account: { accountId: 'shared-fixture', provider: 'openai-codex', profileRevision: 'r1' },
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
const participants = ['architect', 'reviewer', 'other', 'late-reader'];
function command(sessionId: string, commandId = `initial-${sessionId}`, text = 'Offline setup') {
  const existing = store.getSession(sessionId);
  if (existing) store.completeOrdinaryLocalCommand(`initial-${sessionId}`);
  const admit = existing
    ? store.admitOrdinaryLocalContinuation.bind(store)
    : store.admitOrdinaryLocalCommand.bind(store);
  admit(
    {
      sessionId,
      selectedModel: selection.model,
      mode: 'agent',
      cwd: '/fixture',
      accountBinding: {
        ...binding.account,
        accountLabel: 'Offline fixture',
        model: selection.model,
      },
      repositoryWorkspaceId: 'workspace',
    },
    binding,
    { clientMsgId: commandId, requestFingerprint: `fp-${commandId}`, selection, payload: { text } },
  );
  store.claimOrdinaryLocalCommandDispatch(commandId);
}
function policy(sessionId: string, reads: boolean) {
  const view = store.collaborationConversation.view(group);
  store.collaborationConversation.setPolicy(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: view.membershipRevision,
    expectedRevision: view.policies.find((row) => row.sessionId === sessionId)!.revision,
    sessionId,
    readsFutureDiscussion: reads,
    repliesByDefault: false,
  });
}
function prompt(responders = ['reviewer'], text = 'Inspect the original exact plan') {
  const view = store.collaborationConversation.view(group);
  return store.collaborationConversation.acceptMessage(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: view.membershipRevision,
    expectedPolicySequence: view.policySequence,
    text,
    responders: { kind: 'selected', sessionIds: responders },
    snapshot: null,
  });
}
function finalized(origin: ReturnType<typeof prompt>) {
  const delivery = origin.deliveries.find((row) => row.sessionId === 'reviewer')!;
  store.collaborationConversation.recordDelivery(group, origin.messageId, delivery.deliveryId, {
    requestId: randomUUID(),
    expectedRevision: 0,
    status: 'uncertain',
    commandId: 'initial-reviewer',
    reason: 'Offline interrupted acknowledgement',
  });
  recordOrdinaryReplySource(store, 'reviewer', {
    commandId: 'initial-reviewer',
    messageId: 'visible-review',
    providerThreadId: 'private-thread',
    providerTurnId: 'private-turn',
  });
  store.append('reviewer', 'message_start', { messageId: 'visible-review' });
  store.append('reviewer', 'block_start', {
    messageId: 'visible-review',
    blockId: 'answer',
    blockType: 'text',
  });
  store.append('reviewer', 'block_delta', {
    messageId: 'visible-review',
    blockId: 'answer',
    delta: 'Exact finalized reviewer answer',
  });
  store.append('reviewer', 'block_end', {
    messageId: 'visible-review',
    blockId: 'answer',
    blockType: 'text',
  });
  const end = store.append('reviewer', 'message_end', { messageId: 'visible-review' });
  return {
    requestId: randomUUID(),
    messageId: origin.messageId,
    deliveryId: delivery.deliveryId,
    source: {
      conversationId: 'reviewer',
      commandId: 'initial-reviewer',
      messageId: 'visible-review',
      blockIds: ['answer'],
      throughSequence: end,
    },
  };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mitzo-reader-reply-'));
  path = join(directory, 'events.db');
  store = new EventStore(path);
  group = randomUUID();
  for (const sessionId of participants) command(sessionId);
  store.setSessionCollaboration(group, {
    expectedRevision: 0,
    participantSessionIds: participants,
  });
  policy('architect', true);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

it('retains a finalized reply beside its prompt and consumes exactly three receipts only on the next explicit reader command', async () => {
  const origin = prompt();
  const input = finalized(origin);
  const originalOutcomes = store.collaborationConversation.getMessage(
    group,
    origin.messageId,
  )!.deliveries;
  const reply = new OrdinaryCollaborationReplies(store).record(group, input);
  expect(reply.readers).toEqual(['architect']);
  expect(reply.responders).toEqual([]);
  expect(reply.deliveries).toEqual([
    expect.objectContaining({
      sessionId: 'architect',
      purpose: 'context',
      status: 'pending',
      revision: 0,
      commandId: null,
      reason: null,
    }),
  ]);
  expect(reply.settings).toEqual({ architect: settings });
  expect(reply).toMatchObject({
    membershipRevision: origin.membershipRevision,
    policySequence: origin.policySequence,
    policyRevisions: origin.policyRevisions,
  });
  expect(store.collaborationConversation.getMessage(group, origin.messageId)!.deliveries).toEqual(
    originalOutcomes,
  );
  expect(store.getSessionEvents('architect')).toEqual([]);
  expect(store.getOrdinaryCommandAdmission('architect-explicit')).toBeUndefined();
  expect(JSON.stringify(reply)).not.toMatch(
    /private-thread|private-turn|providerThreadId|providerTurnId/,
  );
  store.close();
  store = new EventStore(path);
  const explicit = prompt(['architect'], 'Now critique that finalized reviewer answer');
  command('architect', 'architect-explicit', explicit.text);
  const refs = [origin, reply, explicit].map((row) => ({
    collaborationId: group,
    messageId: row.messageId,
    deliveryId: row.deliveries.find((delivery) => delivery.sessionId === 'architect')!.deliveryId,
  }));
  const authorize = vi.fn(async () => {}),
    assertBeforeDispatch = vi.fn(),
    assertProviderAccepted = vi.fn();
  const owner = new OrdinaryCollaborationDelivery(store, {
    authorize,
    assertBeforeDispatch,
    assertProviderAccepted,
  });
  owner.stage({ sessionId: 'architect', commandId: 'architect-explicit', deliveries: refs });
  const context = await owner.prepareSystemPrompt(
    'architect',
    'architect-explicit',
    'Original ordinary instructions',
    new AbortController().signal,
  );
  expect(context).toContain(origin.text);
  expect(context).toContain(reply.text);
  expect(context).toContain(explicit.text);
  expect(context!.indexOf(origin.text)).toBeLessThan(context!.indexOf(reply.text));
  expect(context!.indexOf(reply.text)).toBeLessThan(context!.indexOf(explicit.text));
  for (const row of [origin, reply, explicit])
    expect(
      store.collaborationConversation
        .getMessage(group, row.messageId)!
        .deliveries.find((delivery) => delivery.sessionId === 'architect')!.status,
    ).toBe('pending');
  const staged = store
    .getOrdinaryCollaborationDeliveryEvents('architect', 'architect-explicit')
    .find((event) => event.type === 'ordinary_collaboration_context_staged')!;
  expect((staged.payload as { deliveries: unknown[] }).deliveries).toHaveLength(3);
  owner.beforeDispatch('architect', 'architect-explicit');
  owner.accepted('architect', 'architect-explicit', 'reader-thread', 'reader-turn', context!);
  expect(assertProviderAccepted).toHaveBeenCalledWith({
    sessionId: 'architect',
    commandId: 'architect-explicit',
    providerThreadId: 'reader-thread',
    providerTurnId: 'reader-turn',
  });
  const accepted = [origin, reply, explicit].map((row) =>
    store.collaborationConversation
      .getMessage(group, row.messageId)!
      .deliveries.find((delivery) => delivery.sessionId === 'architect')!,
  );
  expect(accepted).toHaveLength(3);
  expect(
    accepted.every(
      (delivery) =>
        delivery.status === 'delivered' &&
        delivery.commandId === 'architect-explicit' &&
        delivery.revision === 1,
    ),
  ).toBe(true);
  owner.recover('architect', 'architect-explicit');
  expect(
    [origin, reply, explicit].map((row) =>
      store.collaborationConversation
        .getMessage(group, row.messageId)!
        .deliveries.find((delivery) => delivery.sessionId === 'architect')!,
    ),
  ).toEqual(accepted);
  expect(
    store.collaborationConversation
      .getMessage(group, origin.messageId)!
      .deliveries.find((delivery) => delivery.sessionId === 'reviewer')!.status,
  ).toBe('uncertain');
});

it('freezes origin readers when checkboxes change, never adds later opt-ins, and excludes the reply author', () => {
  const origin = prompt(['reviewer', 'other']);
  const input = finalized(origin);
  policy('architect', false);
  policy('late-reader', true);
  const reply = new OrdinaryCollaborationReplies(store).record(group, input);
  expect(reply.readers).toEqual(['architect', 'other']);
  expect(reply.responders).toEqual([]);
  expect(
    reply.deliveries.map((delivery) => [
      delivery.sessionId,
      delivery.purpose,
      delivery.status,
      delivery.commandId,
    ]),
  ).toEqual([
    ['architect', 'context', 'pending', null],
    ['other', 'context', 'pending', null],
  ]);
  expect(reply.settings).toEqual({ architect: settings, other: settings });
  expect(reply.policyRevisions).toEqual(origin.policyRevisions);
});

it('keeps a continuous origin reader after unrelated membership changes and a later checkbox edit', () => {
  const origin = prompt();
  const input = finalized(origin);
  store.setSessionCollaboration(group, {
    expectedRevision: 1,
    participantSessionIds: ['architect', 'reviewer', 'late-reader'],
  });
  policy('architect', false);
  expect(
    store.collaborationConversation
      .view(group)
      .policies.find((row) => row.sessionId === 'architect')!.membershipRevision,
  ).toBe(2);
  expect(new OrdinaryCollaborationReplies(store).record(group, input).readers).toEqual([
    'architect',
  ]);
});

it.each(['removed', 're-enrolled'] as const)(
  'does not project old exchange history to a %s reader',
  (change) => {
    const origin = prompt(['reviewer', 'other']);
    const input = finalized(origin);
    store.setSessionCollaboration(group, {
      expectedRevision: 1,
      participantSessionIds: ['reviewer', 'other', 'late-reader'],
    });
    if (change === 're-enrolled') {
      store.setSessionCollaboration(group, {
        expectedRevision: 2,
        participantSessionIds: participants,
      });
      policy('architect', true);
    }
    const reply = new OrdinaryCollaborationReplies(store).record(group, input);
    expect(reply.readers).toEqual(['other']);
  },
);

it('retains pending receipts for an unavailable continuous reader without changing another recipient outcome', () => {
  const origin = prompt(['reviewer', 'other']);
  const input = finalized(origin);
  const other = origin.deliveries.find((delivery) => delivery.sessionId === 'other')!;
  const outcome = store.collaborationConversation.recordDelivery(
    group,
    origin.messageId,
    other.deliveryId,
    {
      requestId: randomUUID(),
      expectedRevision: 0,
      status: 'delivered',
      commandId: 'initial-other',
      reason: null,
    },
  );
  store.hideSession('architect');
  const reply = new OrdinaryCollaborationReplies(store).record(group, input);
  expect(reply.readers).toEqual(['architect', 'other']);
  expect(
    reply.deliveries.every(
      (delivery) =>
        delivery.purpose === 'context' &&
        delivery.status === 'pending' &&
        delivery.commandId === null,
    ),
  ).toBe(true);
  expect(
    store.collaborationConversation
      .getMessage(group, origin.messageId)!
      .deliveries.find((delivery) => delivery.sessionId === 'other'),
  ).toEqual(outcome);
});

it('preserves exact request and different-callback delivery identities after restart and policy drift without resetting partial outcomes', () => {
  const origin = prompt(['reviewer', 'other']);
  const input = finalized(origin);
  const reply = new OrdinaryCollaborationReplies(store).record(group, input);
  expect(reply.deliveries).toHaveLength(2);
  const reader = reply.deliveries.find((delivery) => delivery.sessionId === 'architect')!;
  const delivered = store.collaborationConversation.recordDelivery(
    group,
    reply.messageId,
    reader.deliveryId,
    {
      requestId: randomUUID(),
      expectedRevision: 0,
      status: 'delivered',
      commandId: 'reader-explicit-outcome',
      reason: null,
    },
  );
  store.setSessionCollaboration(group, {
    expectedRevision: 1,
    participantSessionIds: ['architect', 'other', 'late-reader'],
  });
  store.hideSession('reviewer');
  store.close();
  store = new EventStore(path);
  const cursor = store.collaborationConversation.view(group).cursor;
  const owner = new OrdinaryCollaborationReplies(store);
  expect(owner.record(group, input)).toEqual(reply);
  expect(owner.record(group, { ...input, requestId: randomUUID() })).toEqual(reply);
  expect(store.collaborationConversation.view(group).cursor).toBe(cursor);
  expect(store.collaborationConversation.getMessage(group, reply.messageId)!.deliveries).toEqual(
    reply.deliveries.map((delivery) => (delivery.sessionId === 'architect' ? delivered : delivery)),
  );
});

function rejoinReader() {
  const revision = store.collaborationConversation.view(group).membershipRevision;
  store.setSessionCollaboration(group, {
    expectedRevision: revision,
    participantSessionIds: participants.filter((id) => id !== 'architect'),
  });
  store.setSessionCollaboration(group, {
    expectedRevision: revision + 1,
    participantSessionIds: participants,
  });
  policy('architect', true);
}

function readerCommand() {
  const origin = prompt(['reviewer', 'other']);
  const other = origin.deliveries.find((row) => row.sessionId === 'other')!;
  const sibling = store.collaborationConversation.recordDelivery(
    group,
    origin.messageId,
    other.deliveryId,
    {
      requestId: randomUUID(),
      expectedRevision: 0,
      status: 'delivered',
      commandId: 'initial-other',
      reason: null,
    },
  );
  const explicit = prompt(['architect'], 'Explicit reader request');
  command('architect', 'reader-explicit', explicit.text);
  const refs = [origin, explicit].map((message) => ({
    collaborationId: group,
    messageId: message.messageId,
    deliveryId: message.deliveries.find((row) => row.sessionId === 'architect')!.deliveryId,
  }));
  const authorize = vi.fn(async () => {}),
    assertBeforeDispatch = vi.fn(),
    assertProviderAccepted = vi.fn();
  const owner = new OrdinaryCollaborationDelivery(store, {
    authorize,
    assertBeforeDispatch,
    assertProviderAccepted,
  });
  return { owner, refs, origin, sibling, authorize, assertBeforeDispatch, assertProviderAccepted };
}

it.each(['stage', 'prepare', 'after-authority-await', 'before-dispatch'] as const)(
  'refuses old retained reader context after removal/re-entry at %s without resetting sibling outcomes',
  async (phase) => {
    const f = readerCommand();
    const input = { sessionId: 'architect', commandId: 'reader-explicit', deliveries: f.refs };
    if (phase === 'stage') {
      rejoinReader();
      expect(() => f.owner.stage(input)).toThrow();
    } else {
      f.owner.stage(input);
      if (phase === 'before-dispatch') {
        await f.owner.prepareSystemPrompt(
          'architect',
          'reader-explicit',
          undefined,
          new AbortController().signal,
        );
        rejoinReader();
        expect(() => f.owner.beforeDispatch('architect', 'reader-explicit')).toThrow();
      } else {
        if (phase === 'after-authority-await')
          f.authorize.mockImplementationOnce(async () => rejoinReader());
        else rejoinReader();
        await expect(
          f.owner.prepareSystemPrompt(
            'architect',
            'reader-explicit',
            undefined,
            new AbortController().signal,
          ),
        ).rejects.toThrow();
      }
    }
    expect(f.assertBeforeDispatch).not.toHaveBeenCalled();
    expect(f.assertProviderAccepted).not.toHaveBeenCalled();
    expect(
      store.collaborationConversation
        .getMessage(group, f.origin.messageId)!
        .deliveries.find((delivery) => delivery.sessionId === 'other'),
    ).toEqual(f.sibling);
    expect(
      store.collaborationConversation
        .getMessage(group, f.origin.messageId)!
        .deliveries.find((delivery) => delivery.sessionId === 'architect')!.status,
    ).toBe('pending');
  },
);

it('reconciles a valid old exact ACK after removal/re-entry without permitting another dispatch', async () => {
  const f = readerCommand();
  f.owner.stage({ sessionId: 'architect', commandId: 'reader-explicit', deliveries: f.refs });
  const context = await f.owner.prepareSystemPrompt(
    'architect',
    'reader-explicit',
    undefined,
    new AbortController().signal,
  );
  f.owner.beforeDispatch('architect', 'reader-explicit');
  rejoinReader();
  f.owner.accepted('architect', 'reader-explicit', 'exact-thread', 'exact-turn', context!);
  const outcomes = f.refs.map((ref) =>
    store.collaborationConversation
      .getMessage(group, ref.messageId)!
      .deliveries.find((delivery) => delivery.deliveryId === ref.deliveryId)!,
  );
  expect(
    outcomes.every(
      (delivery) => delivery.status === 'delivered' && delivery.commandId === 'reader-explicit',
    ),
  ).toBe(true);
  store.close();
  store = new EventStore(path);
  const authorize = vi.fn(async () => {}),
    assertBeforeDispatch = vi.fn(),
    assertProviderAccepted = vi.fn();
  const recovered = new OrdinaryCollaborationDelivery(store, {
    authorize,
    assertBeforeDispatch,
    assertProviderAccepted,
  });
  recovered.recover('architect', 'reader-explicit');
  expect(
    f.refs.map((ref) =>
      store.collaborationConversation
        .getMessage(group, ref.messageId)!
        .deliveries.find((delivery) => delivery.deliveryId === ref.deliveryId)!,
    ),
  ).toEqual(outcomes);
  await expect(
    recovered.prepareSystemPrompt(
      'architect',
      'reader-explicit',
      undefined,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(() => recovered.beforeDispatch('architect', 'reader-explicit')).toThrow();
  expect(authorize).not.toHaveBeenCalled();
  expect(assertBeforeDispatch).not.toHaveBeenCalled();
  expect(assertProviderAccepted).not.toHaveBeenCalled();
});
