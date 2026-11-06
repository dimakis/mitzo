import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
import { createApplicationCollaborationJoining } from '../collaboration-application-joining.js';
import { createApplicationCollaborationMessages } from '../collaboration-application-messages.js';
import { assertCollaborationCommand } from '../collaboration-ordinary-command.js';
import {
  captureOrdinaryReplyExecution,
  recordOrdinaryReplySource,
} from '../collaboration-ordinary-replies.js';
import {
  fixture,
  cleanupApplicationReviewFixtures,
} from './fixtures/collaboration-application-review.js';

const external = vi.hoisted(() => ({ dispatch: vi.fn() }));
// Unit composition boundary only. A separate actual-app journey must exercise
// the real ordinary dispatcher/native transport; this is not native acceptance.
vi.mock('../ordinary-scoped-command.js', () => ({
  dispatchOwnedOrdinaryCommand: external.dispatch,
}));
vi.mock('../mcp-config.js', () => ({ loadMcpServers: () => ({}) }));
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>();
  return { ...os, homedir: () => process.env.SYMPOSIUM_OFFLINE_HOME ?? os.homedir() };
});
afterEach(cleanupApplicationReviewFixtures);

async function setup() {
  for (const key of [
    'CODEX_HOME',
    'MITZO_KEYCHAIN_HELPER',
    'MITZO_KEYCHAIN_CONNECTIONS_DIR',
    'MITZO_KNOWLEDGE_LIBRARY_CONFIG',
    'MITZO_WORKSPACE_RUNTIME_CONFIG',
  ])
    vi.stubEnv(key, undefined);
  const f = await fixture();
  vi.stubEnv('SYMPOSIUM_OFFLINE_HOME', join(f.root, 'home'));
  vi.stubEnv('MITZO_ORDINARY_TASK_ROOT', join(f.root, 'tasks'));
  const reviewed = await f.review();
  const joined = await createApplicationCollaborationJoining(f, f.auth).confirm(
    f.auth.id,
    f.group,
    {
      requestId: randomUUID(),
      expectedMembershipRevision: 1,
      name: 'Reviewer',
      settings: reviewed.settings,
      snapshot: { snapshotId: reviewed.snapshot.snapshotId, sha256: reviewed.snapshot.sha256 },
    },
    f.controller.signal,
  );
  const registry = new SessionRegistry();
  const owner = createApplicationCollaborationMessages({
    ...f,
    workspaces: () => f.workspaces,
    registry,
    broadcast: () => {},
  });
  const input = {
    requestId: randomUUID(),
    expectedMembershipRevision: 2,
    expectedPolicySequence: f.store.collaborationConversation.view(f.group).policySequence,
    text: 'Review this design explicitly',
    responders: { kind: 'selected' as const, sessionIds: [joined.sessionId!] },
    snapshot: null,
  };
  external.dispatch.mockReset().mockImplementation(async (dispatch) => {
    assertCollaborationCommand(f.store, joined.sessionId!, dispatch.commandId, f.auth.id);
    const meta = f.store.getSession(joined.sessionId!)!;
    f.store.admitPreparedOrdinaryCommand(
      joined.allocationOperationId,
      {
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        mode: meta.mode,
        accountBinding: meta.accountBinding!,
        selectedModel: meta.selectedModel,
        reasoningEffort: meta.reasoningEffort,
        repositoryWorkspaceId: meta.repositoryWorkspaceId!,
        agentProfile: meta.agentProfile!,
      },
      reviewed.settings.binding,
      {
        clientMsgId: dispatch.commandId,
        requestFingerprint: 'offline-command',
        selection: reviewed.settings.selection,
        payload: dispatch.command.payload,
      },
    );
    f.store.claimOrdinaryLocalCommandDispatch(dispatch.commandId);
    f.store.completeOrdinaryLocalCommand(dispatch.commandId);
    return { dispatched: true, sessionId: joined.sessionId };
  });
  const send = (request = input) =>
    owner.send(f.auth, f.connectionId, f.group, request, f.controller.signal);
  return { ...f, reviewed, joined, registry, owner, input, send };
}

it('uses the original silent preparation and ordinary dispatcher with exact reviewed content and explicit prompt', async () => {
  const f = await setup();
  expect(external.dispatch).not.toHaveBeenCalled();
  const sessions = f.store.listSessions();
  const result = await f.send();
  await expect(external.dispatch.mock.results[0].value).resolves.toMatchObject({
    dispatched: true,
  });
  expect(result.responders).toEqual([f.joined.sessionId]);
  const dispatch = external.dispatch.mock.calls[0][0];
  expect(dispatch).toMatchObject({
    sessionId: f.joined.sessionId,
    preparationOperationId: f.joined.allocationOperationId,
    continuation: false,
  });
  expect(dispatch.command.payload.text).toContain('Visible source');
  expect(dispatch.command.payload.text).toContain('Original brief');
  expect(dispatch.command.payload.text).toContain(f.input.text);
  expect(JSON.stringify(dispatch.command)).not.toContain('PRIVATE');
  expect(f.store.listSessions().map((x) => x.sessionId)).toEqual(sessions.map((x) => x.sessionId));
  expect(await f.send()).toEqual(result);
  expect(external.dispatch).toHaveBeenCalledTimes(1);
  await expect(f.send({ ...f.input, text: 'changed under the same request' })).rejects.toThrow(
    'request_conflict',
  );
});

it('retains an uncertain original delivery across errors and concurrent retries without resending', async () => {
  const f = await setup();
  external.dispatch.mockRejectedValue(new Error('Lost native response'));
  const results = await Promise.all([f.send(), f.send()]);
  expect(results[0].deliveries[0]).toMatchObject({
    status: 'uncertain',
    commandId: expect.any(String),
  });
  expect(external.dispatch).toHaveBeenCalledTimes(1);
  await f.send();
  expect(external.dispatch).toHaveBeenCalledTimes(1);
});

it('projects only finalized attributed ordinary reply text and never requests another turn', async () => {
  const f = await setup();
  const prompt = await f.send();
  const commandId = prompt.deliveries[0].commandId!;
  const source = {
    commandId,
    messageId: 'visible-answer',
    providerThreadId: 'PRIVATE-thread',
    providerTurnId: 'PRIVATE-turn',
  };
  const accepted = captureOrdinaryReplyExecution(f.store, f.joined.sessionId!, source);
  recordOrdinaryReplySource(f.store, f.joined.sessionId!, source, accepted);
  f.store.append(f.joined.sessionId!, 'message_start', { messageId: source.messageId });
  for (const [blockId, blockType, delta] of [
    ['reasoning', 'thinking', 'PRIVATE reasoning'],
    ['answer', 'text', 'Visible answer'],
  ]) {
    f.store.append(f.joined.sessionId!, 'block_start', {
      messageId: source.messageId,
      blockId,
      blockType,
    });
    f.store.append(f.joined.sessionId!, 'block_delta', {
      messageId: source.messageId,
      blockId,
      delta,
    });
    f.store.append(f.joined.sessionId!, 'block_end', { messageId: source.messageId, blockId });
  }
  expect(f.owner.view(f.group).messages).toHaveLength(1);
  f.store.append(f.joined.sessionId!, 'message_end', { messageId: source.messageId });
  const view = f.owner.view(f.group);
  expect(view.messages[1]).toMatchObject({
    text: 'Visible answer',
    author: { sessionId: f.joined.sessionId },
    replyToDeliveryId: prompt.deliveries[0].deliveryId,
    source: { commandId, messageId: source.messageId },
  });
  expect(JSON.stringify(view)).not.toContain('PRIVATE');
  expect(f.owner.view(f.group)).toEqual(view);
  expect(external.dispatch).toHaveBeenCalledTimes(1);
});

it('observes the same delivery after source or membership changes without reauthorizing another send', async () => {
  const f = await setup();
  external.dispatch.mockRejectedValue(new Error('Lost response'));
  const original = await f.send();
  f.store.hideSession('source');
  f.store.setSessionCollaboration(f.group, {
    expectedRevision: 2,
    participantSessionIds: ['source'],
  });
  expect(await f.send()).toEqual(original);
  expect(external.dispatch).toHaveBeenCalledTimes(1);
});

it.each(['source', 'recipient', 'membership', 'operator', 'orphan command'] as const)(
  'refuses %s changes at a retained native command boundary',
  async (change) => {
    const f = await setup();
    const original = await f.send();
    let commandId = original.deliveries[0].commandId!;
    let operatorId = f.auth.id;
    if (change === 'source') f.store.hideSession('source');
    if (change === 'recipient') f.store.hideSession(f.joined.sessionId!);
    if (change === 'operator') operatorId = 'another-login';
    if (change === 'orphan command') commandId = 'collaboration:' + randomUUID();
    if (change === 'membership') {
      f.store.setSessionCollaboration(f.group, {
        expectedRevision: 2,
        participantSessionIds: ['source'],
      });
      f.store.setSessionCollaboration(f.group, {
        expectedRevision: 3,
        participantSessionIds: ['source', f.joined.sessionId!],
      });
    }
    expect(() =>
      assertCollaborationCommand(f.store, f.joined.sessionId!, commandId, operatorId),
    ).toThrow();
    expect(external.dispatch).toHaveBeenCalledTimes(1);
  },
);

it.each(['images', 'sourceSnapshots', 'replyToMessageId', 'extra'] as const)(
  'rejects an additional %s input under an existing delivery identity',
  async (field) => {
    const f = await setup();
    const dispatch = external.dispatch.getMockImplementation()!;
    external.dispatch.mockImplementation(async (input) => {
      input.command.payload[field] = field === 'replyToMessageId' ? 'foreign-reply' : [];
      return dispatch(input);
    });
    const message = await f.send();
    expect(() =>
      assertCollaborationCommand(
        f.store,
        f.joined.sessionId!,
        message.deliveries[0].commandId!,
        f.auth.id,
      ),
    ).toThrow();
  },
);

function completeReply(
  f: Awaited<ReturnType<typeof setup>>,
  commandId: string,
  text = 'Retained answer',
  beforeEnd?: (messageId: string) => void,
) {
  const source = {
    commandId,
    messageId: randomUUID(),
    providerThreadId: 'offline-thread',
    providerTurnId: 'offline-turn',
  };
  recordOrdinaryReplySource(
    f.store,
    f.joined.sessionId!,
    source,
    captureOrdinaryReplyExecution(f.store, f.joined.sessionId!, source),
  );
  const sessionId = f.joined.sessionId!;
  f.store.append(sessionId, 'message_start', { messageId: source.messageId });
  f.store.append(sessionId, 'block_start', {
    messageId: source.messageId,
    blockId: 'answer',
    blockType: 'text',
  });
  f.store.append(sessionId, 'block_delta', {
    messageId: source.messageId,
    blockId: 'answer',
    delta: text,
  });
  f.store.append(sessionId, 'block_end', { messageId: source.messageId, blockId: 'answer' });
  beforeEnd?.(source.messageId);
  f.store.append(sessionId, 'message_end', { messageId: source.messageId });
}

it.each(['queued prompt', 'message count', 'history bytes'] as const)(
  'recovers an exact finalized answer despite unrelated %s history',
  async (history) => {
    const f = await setup();
    const prompt = await f.send();
    const appendPrompt = (text: string) =>
      f.store.append(f.joined.sessionId!, 'user_message', { messageId: randomUUID(), text });
    if (history === 'message count')
      for (let i = 0; i < 501; i++) appendPrompt(`Earlier prompt ${i}`);
    if (history === 'history bytes') for (let i = 0; i < 6; i++) appendPrompt('x'.repeat(100_000));
    completeReply(
      f,
      prompt.deliveries[0].commandId!,
      'Retained answer',
      history === 'queued prompt' ? () => appendPrompt('Queued next prompt') : undefined,
    );
    // These histories are deliberately ineligible for a whole-context snapshot.
    expect(() => f.store.getDurableSessionTranscript(f.joined.sessionId!)).toThrow();
    const view = f.owner.view(f.group);
    expect(view.messages.find((row) => row.replyToDeliveryId)).toMatchObject({
      text: 'Retained answer',
      replyToDeliveryId: prompt.deliveries[0].deliveryId,
    });
    expect(f.owner.view(f.group)).toEqual(view);
    expect(external.dispatch).toHaveBeenCalledTimes(1);
  },
);

it.each([100_001, 500_001])(
  'keeps reads available for a %i-character answer exceeding projection limits',
  async (size) => {
    const f = await setup();
    const prompt = await f.send();
    completeReply(f, prompt.deliveries[0].commandId!, 'x'.repeat(size));
    expect(() => f.owner.view(f.group)).not.toThrow();
    expect(f.owner.view(f.group).messages).toHaveLength(1);
    completeReply(f, prompt.deliveries[0].commandId!, 'Later eligible answer');
    const view = f.owner.view(f.group);
    expect(view.messages.find((row) => row.replyToDeliveryId)?.text).toBe('Later eligible answer');
    expect(f.owner.view(f.group)).toEqual(view);
    expect(external.dispatch).toHaveBeenCalledTimes(1);
  },
);

it('keeps the retained view readable when one source exceeds the visible block limit', async () => {
  const f = await setup();
  const prompt = await f.send();
  completeReply(f, prompt.deliveries[0].commandId!, 'First block', (messageId) => {
    for (let i = 0; i < 100; i++) {
      const blockId = `extra-${i}`;
      f.store.append(f.joined.sessionId!, 'block_start', { messageId, blockId, blockType: 'text' });
      f.store.append(f.joined.sessionId!, 'block_delta', { messageId, blockId, delta: 'x' });
      f.store.append(f.joined.sessionId!, 'block_end', { messageId, blockId });
    }
  });
  expect(() => f.owner.view(f.group)).not.toThrow();
  expect(f.owner.view(f.group).messages).toHaveLength(1);
  completeReply(f, prompt.deliveries[0].commandId!, 'Eligible answer after block refusal');
  expect(f.owner.view(f.group).messages.find((row) => row.replyToDeliveryId)?.text).toBe(
    'Eligible answer after block refusal',
  );
});

it('skips a malformed retained source identifier without suppressing eligible answers', async () => {
  const f = await setup();
  const prompt = await f.send();
  const commandId = prompt.deliveries[0].commandId!;
  f.store.append(f.joined.sessionId!, 'ordinary_reply_source', {
    version: 2,
    commandId,
    messageId: ' ',
    providerThreadId: 'fixture-thread',
    providerTurnId: 'fixture-turn',
    executionFingerprint: 'fixture',
  });
  completeReply(f, commandId);
  expect(f.owner.view(f.group).messages.find((row) => row.replyToDeliveryId)?.text).toBe(
    'Retained answer',
  );
});

it.each(['removed', 'hidden'] as const)(
  'keeps the retained view readable after a responder is %s before reply projection',
  async (change) => {
    const f = await setup();
    const prompt = await f.send();
    completeReply(f, prompt.deliveries[0].commandId!);
    if (change === 'removed')
      f.store.setSessionCollaboration(f.group, {
        expectedRevision: 2,
        participantSessionIds: ['source'],
      });
    else f.store.hideSession(f.joined.sessionId!);
    expect(() => f.owner.view(f.group)).not.toThrow();
  },
);

it('keeps a retained view readable when ordinary failure prevents reply projection', async () => {
  const f = await setup();
  const prompt = await f.send();
  const commandId = prompt.deliveries[0].commandId!;
  completeReply(f, commandId);
  f.store.failSendCommand(commandId, 'Retained ordinary failure');
  expect(() => f.owner.view(f.group)).not.toThrow();
  expect(f.owner.view(f.group).messages.some((row) => row.replyToDeliveryId)).toBe(false);
});

it('recovers a finalized reply even after its prompt leaves the recent fifty-message page', async () => {
  const f = await setup();
  const prompt = await f.send();
  for (let i = 0; i < 55; i++)
    f.store.collaborationConversation.acceptMessage(f.group, {
      ...f.input,
      requestId: randomUUID(),
      text: `Later prompt ${i}`,
    });
  completeReply(f, prompt.deliveries[0].commandId!);
  expect(
    f.owner
      .view(f.group)
      .messages.some((row) => row.replyToDeliveryId === prompt.deliveries[0].deliveryId),
  ).toBe(true);
  expect(external.dispatch).toHaveBeenCalledTimes(1);
});

it('refuses additional policy readers before accepting a message in this single-recipient increment', async () => {
  const f = await setup();
  f.store.admitOrdinaryLocalCommand(
    {
      sessionId: 'reader',
      accountBinding: f.binding,
      selectedModel: 'fixture-model',
      mode: 'ask',
      cwd: f.root,
      repositoryWorkspaceId: randomUUID(),
    },
    f.reviewed.settings.binding,
    {
      clientMsgId: 'offline-reader',
      requestFingerprint: 'offline-reader',
      selection: f.reviewed.settings.selection,
      payload: { text: 'Offline reader fixture' },
    },
  );
  f.store.setSessionCollaboration(f.group, {
    expectedRevision: 2,
    participantSessionIds: ['source', f.joined.sessionId!, 'reader'],
  });
  const before = f.store.collaborationConversation.view(f.group);
  f.store.collaborationConversation.setPolicy(f.group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 3,
    expectedRevision: before.policies.find((row) => row.sessionId === 'reader')?.revision ?? 0,
    sessionId: 'reader',
    readsFutureDiscussion: true,
    repliesByDefault: false,
  });
  const current = f.store.collaborationConversation.view(f.group);
  await expect(
    f.send({
      ...f.input,
      expectedMembershipRevision: 3,
      expectedPolicySequence: current.policySequence,
    }),
  ).rejects.toThrow('execution_unavailable');
  expect(f.store.collaborationConversation.view(f.group).messages).toEqual([]);
  expect(external.dispatch).not.toHaveBeenCalled();
});
