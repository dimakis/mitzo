import { afterEach, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import {
  OrdinaryCollaborationReplies,
  recordOrdinaryReplySource,
  captureOrdinaryReplyExecution,
} from '../collaboration-ordinary-replies.js';
import { ordinaryRepositoryTransition } from './fixtures/ordinary-repository-transition.js';

let store: EventStore, directory: string, path: string, group: string;
const binding = {
  version: 2,
  account: { accountId: 'shared-account', provider: 'openai-codex', profileRevision: 'r1' },
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
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mitzo-reply-source-'));
  path = join(directory, 'events.db');
  store = new EventStore(path);
  group = randomUUID();
  for (const sessionId of ['one', 'two']) {
    store.admitOrdinaryLocalCommand(
      {
        sessionId,
        selectedModel: selection.model,
        mode: 'agent',
        cwd: '/fixture',
        accountBinding: {
          ...binding.account,
          accountLabel: 'Shared fixture',
          model: selection.model,
        },
        repositoryWorkspaceId: 'workspace',
      },
      binding,
      {
        clientMsgId: `initial-${sessionId}`,
        requestFingerprint: `fp-${sessionId}`,
        selection,
        payload: { text: 'Fixture', systemPrompt: 'Offline fixture' },
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
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
function mapping(sessionId = 'two', messageId = 'visible-reply') {
  return {
    commandId: `initial-${sessionId}`,
    messageId,
    providerThreadId: `private-thread-${sessionId}`,
    providerTurnId: `private-turn-${sessionId}`,
  };
}
function recordSource(events: EventStore, sessionId: string, source: ReturnType<typeof mapping>) {
  const execution = captureOrdinaryReplyExecution(events, sessionId, source);
  recordOrdinaryReplySource(events, sessionId, source, execution);
}
function visible(messageId = 'visible-reply', sessionId = 'two') {
  store.append(sessionId, 'message_start', { messageId });
  store.append(sessionId, 'block_start', { messageId, blockId: 'text-block', blockType: 'text' });
  store.append(sessionId, 'block_delta', {
    messageId,
    blockId: 'text-block',
    delta: 'Exact visible reply',
  });
  store.append(sessionId, 'block_end', { messageId, blockId: 'text-block', blockType: 'text' });
  return store.append(sessionId, 'message_end', { messageId });
}
function input(end: number, sessionId = 'two') {
  const message = store.collaborationConversation.acceptMessage(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    expectedPolicySequence: 0,
    text: 'Review',
    responders: { kind: 'selected', sessionIds: [sessionId] },
    snapshot: null,
  });
  const deliveryId = message.deliveries[0].deliveryId;
  store.collaborationConversation.recordDelivery(group, message.messageId, deliveryId, {
    requestId: randomUUID(),
    expectedRevision: 0,
    status: 'uncertain',
    commandId: `initial-${sessionId}`,
    reason: 'Original receipt requires reconciliation',
  });
  return {
    requestId: randomUUID(),
    messageId: message.messageId,
    deliveryId,
    source: {
      conversationId: sessionId,
      commandId: `initial-${sessionId}`,
      messageId: 'visible-reply',
      blockIds: ['text-block'],
      throughSequence: end,
    },
  };
}

it('persists a private exact command mapping and reads only finalized visible text through EventStore', () => {
  recordSource(store, 'two', mapping());
  const end = visible();
  const request = input(end);
  const result = new OrdinaryCollaborationReplies(store).record(group, request);
  expect(result).toMatchObject({
    text: 'Exact visible reply',
    author: { sessionId: 'two' },
    source: request.source,
  });
  expect(JSON.stringify(result)).not.toContain('private-thread');
  expect(JSON.stringify(result)).not.toContain('private-turn');
  expect(store.getSessionEvents('one')).toEqual([]);
});

it('deduplicates driver source callbacks and never permits another session or command to claim them', () => {
  recordSource(store, 'two', mapping());
  recordSource(store, 'two', mapping());
  expect(store.getSessionEvents('two')).toHaveLength(1);
  for (const changed of [
    { ...mapping(), commandId: 'initial-one' },
    { ...mapping(), providerTurnId: 'other-turn' },
    { ...mapping(), providerThreadId: 'other-thread' },
  ])
    expect(() => recordSource(store, 'two', changed)).toThrow('reply_conflict');
  expect(() => recordSource(store, 'two', { ...mapping(), commandId: 'absent' })).toThrow(
    'reply_conflict',
  );
  expect(() => recordSource(store, 'missing', mapping())).toThrow('reply_conflict');
});

it('requires exact durable mapping, completed text blocks and the exact end watermark', () => {
  const end = visible();
  const request = input(end);
  const replies = new OrdinaryCollaborationReplies(store);
  expect(() => replies.record(group, request)).toThrow('reply_unavailable');
  recordSource(store, 'two', mapping());
  for (const source of [
    { ...request.source, throughSequence: end - 1 },
    { ...request.source, blockIds: ['not-a-text-block'] },
    { ...request.source, messageId: 'different-message' },
  ])
    expect(() => replies.record(group, { ...request, requestId: randomUUID(), source })).toThrow();
  expect(replies.record(group, request).text).toBe('Exact visible reply');
});

it('keeps independent same-account sessions separate and recovers source and projection receipts after restart', () => {
  recordSource(store, 'one', mapping('one'));
  recordSource(store, 'two', mapping());
  const one = input(visible('visible-reply', 'one'), 'one');
  const two = input(visible());
  const first = new OrdinaryCollaborationReplies(store).record(group, one);
  store.close();
  store = new EventStore(path);
  expect(store.getOrdinaryReplySourceEvents('one', 'visible-reply')).toEqual([
    { version: 2, ...mapping('one'), executionFingerprint: 'fp-one' },
  ]);
  expect(store.getOrdinaryReplySourceEvents('two', 'visible-reply')).toEqual([
    { version: 2, ...mapping(), executionFingerprint: 'fp-two' },
  ]);
  const replies = new OrdinaryCollaborationReplies(store);
  expect(replies.record(group, one)).toEqual(first);
  const second = replies.record(group, two);
  expect(second.author).toEqual({ sessionId: 'two' });
  expect(second.messageId).not.toBe(first.messageId);
  expect(second.source?.commandId).not.toBe(first.source?.commandId);
});

it('rejects a forged or conflicting durable source record instead of trusting session activity', () => {
  recordSource(store, 'two', mapping());
  const request = input(visible());
  store.append('two', 'ordinary_reply_source', {
    version: 1,
    ...mapping(),
    commandId: 'initial-one',
  });
  expect(() => new OrdinaryCollaborationReplies(store).record(group, request)).toThrow(
    'reply_conflict',
  );
  expect(store.collaborationConversation.view(group).messages).toHaveLength(1);
});

it('pins a queued command to its execution revision and reads the same evidence after another handoff', () => {
  store.completeOrdinaryLocalCommand('initial-two');
  const original = store.getSession('two')!;
  store.admitOrdinaryLocalContinuation(original, binding, {
    clientMsgId: 'held',
    requestFingerprint: 'fp-held',
    selection,
    payload: { text: 'Queued before handoff', systemPrompt: 'Offline fixture' },
  });
  store.claimOrdinaryLocalCommandDispatch('held');
  store.completeOrdinaryLocalCommand('held');
  const primary = ordinaryRepositoryTransition(store, 'two', 'initial-two', ['held']);
  expect(() => store.getOrdinaryCommandAdmission('held')).toThrow('durable session identity');
  const earlier = store.getOrdinaryCommandExecutionAdmission('held')!;
  const nextPrimary = ordinaryRepositoryTransition(store, 'two', primary, ['held'], primary);
  expect(store.readOrdinaryCommandExecutionEvidence('held', earlier.requestFingerprint)).toEqual(
    earlier,
  );
  expect(() => store.readOrdinaryCommandExecutionEvidence('held')).toThrow(
    'Exact historical execution',
  );
  const source = { ...mapping(), commandId: 'held' };
  const execution = captureOrdinaryReplyExecution(store, 'two', source);
  recordOrdinaryReplySource(store, 'two', source, execution);
  const retained = store.getOrdinaryReplySourceEvents('two', source.messageId)[0] as {
    executionFingerprint: string;
  };
  const evidence = store.readOrdinaryCommandExecutionEvidence(
    'held',
    retained.executionFingerprint,
  );
  expect(evidence?.workspace.cwd).toBe(store.getSession('two')!.cwd);
  ordinaryRepositoryTransition(store, 'two', nextPrimary, [], nextPrimary);
  expect(store.readOrdinaryCommandExecutionEvidence('held', retained.executionFingerprint)).toEqual(
    evidence,
  );
  expect(() => store.getOrdinaryCommandExecutionAdmission('held')).toThrow();
  expect(() => store.readOrdinaryCommandExecutionEvidence('held', 'forged')).toThrow();
  expect(() =>
    recordOrdinaryReplySource(store, 'two', { ...source, messageId: 'late' }, execution),
  ).toThrow();
});
it('reads a legacy reply mapping from unambiguous retained admission evidence', () => {
  store.append('two', 'ordinary_reply_source', { version: 1, ...mapping() });
  const request = input(visible());
  expect(new OrdinaryCollaborationReplies(store).record(group, request).text).toBe(
    'Exact visible reply',
  );
  store.completeOrdinaryLocalCommand('initial-two');
  ordinaryRepositoryTransition(store, 'two', 'initial-two');
  expect(store.readOrdinaryCommandExecutionEvidence('initial-two')?.workspace.cwd).toBe('/fixture');
});
it('refuses a different native turn or execution reference instead of reassigning a reply', () => {
  const source = mapping();
  const execution = captureOrdinaryReplyExecution(store, 'two', source);
  expect(() =>
    recordOrdinaryReplySource(store, 'two', { ...source, providerTurnId: 'other' }, execution),
  ).toThrow();
  expect(() =>
    recordOrdinaryReplySource(store, 'two', source, {
      ...execution,
      executionFingerprint: 'forged',
    }),
  ).toThrow();
  expect(store.getOrdinaryReplySourceEvents('two', source.messageId)).toEqual([]);
});
