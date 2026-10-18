import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createS9Fixture, cleanupS9Fixtures } from './fixture.js';
import { TelosWorkStore } from '../../../server/telos-work-store.js';
import { OrdinaryCollaborationDelivery } from '../../../server/collaboration-ordinary-delivery.js';
import {
  recordOrdinaryReplySource,
  OrdinaryCollaborationReplies,
} from '../../../server/collaboration-ordinary-replies.js';
import { CodexConversation } from '../../../server/codex-conversation.js';
import { CodexConversationStore } from '../../../server/codex-conversation-store.js';
import type { CodexLifecycleTransport } from '../../../server/codex-app-server-client.js';

afterEach(cleanupS9Fixtures);

async function enrolledPair() {
  const f = await createS9Fixture();
  const contextSelection = await f.api.roleContext({
    itemId: 'outcome',
    role: 'lead',
    sourceSnapshotIds: [],
    artifactRefs: [],
  });
  const input = {
    itemId: 'outcome',
    role: 'lead' as const,
    requestId: 'lead',
    expectedRevision: contextSelection.brief.revision,
    expectedAssignmentRevision: 0,
    settings: f.ordinary.input.settings,
    contextSelection,
  };
  const receipt = await f.api.setupRole(input);
  const leadId = receipt.work.assignments[0].conversation.conversationId;
  const work = new TelosWorkStore(f.dbPath, {
    ordinaryConversation: (id) => !!f.events.getSession(id),
  });
  let operationId: string;
  try {
    operationId = work.prepareRoleSetup(input, { kind: 'operator', id: 's9-offline-operator' })
      .setup.allocationOperationId;
  } finally {
    work.close();
  }
  const settings = await f.independentSettings();
  const joined = await f.ordinary
    .owner()
    .confirm('operator', f.ordinary.group, f.joiningInput(settings), f.ordinary.signal);
  const memberId = joined.sessionId!;
  for (const [sessionId, allocation, selected] of [
    [leadId, operationId, input.settings],
    [memberId, joined.allocationOperationId, settings],
  ] as const) {
    const session = f.events.getSession(sessionId)!;
    const metadata = {
      sessionId,
      repositoryWorkspaceId: session.repositoryWorkspaceId,
      cwd: session.cwd,
      accountBinding: session.accountBinding,
      agentProfile: session.agentProfile,
      agentContext: session.agentContext,
      selectedModel: session.selectedModel,
      reasoningEffort: session.reasoningEffort,
      mode: session.mode,
    };
    f.events.admitPreparedOrdinaryCommand(allocation, metadata, selected.binding, {
      clientMsgId: `command-${sessionId}`,
      requestFingerprint: `fingerprint-${sessionId}`,
      selection: selected.selection,
      payload: { text: 'Explicit synthetic operator command' },
    });
    expect(f.events.claimOrdinaryLocalCommandDispatch(`command-${sessionId}`)).toBe(true);
  }
  return { f, leadId, memberId, receipt };
}

function visible(f: Awaited<ReturnType<typeof createS9Fixture>>, sessionId: string, text: string) {
  // Deliberately identical renderer IDs across sessions exercise namespace collisions.
  f.events.append(sessionId, 'message_start', { messageId: 'same-message' });
  f.events.append(sessionId, 'block_start', {
    messageId: 'same-message',
    blockId: 'same-block',
    blockType: 'text',
  });
  f.events.append(sessionId, 'block_delta', {
    messageId: 'same-message',
    blockId: 'same-block',
    delta: text,
  });
  f.events.append(sessionId, 'block_end', {
    messageId: 'same-message',
    blockId: 'same-block',
    blockType: 'text',
  });
  return f.events.append(sessionId, 'message_end', { messageId: 'same-message' });
}

it('CT18 partial: ordinary admission, delivery ACKs, reply mappings and output references cannot cross Telos/Symposium sessions', async () => {
  const { f, leadId, memberId, receipt } = await enrolledPair();
  const group = f.ordinary.group;
  const message = f.events.collaborationConversation.acceptMessage(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 2,
    expectedPolicySequence: f.events.collaborationConversation.view(group).policySequence,
    text: 'Only the fresh Symposium agent receives this context',
    responders: { kind: 'selected', sessionIds: [memberId] },
    snapshot: null,
  });
  const deliveryId = message.deliveries.find((row) => row.sessionId === memberId)!.deliveryId;
  const ref = { collaborationId: group, messageId: message.messageId, deliveryId };
  const commandId = `command-${memberId}`;
  const owner = () =>
    new OrdinaryCollaborationDelivery(f.events, {
      authorize: async () => {},
      assertBeforeDispatch: () => {},
      assertProviderAccepted: () => {},
    });
  expect(() => owner().stage({ sessionId: leadId, commandId, deliveries: [ref] })).toThrow();
  expect(() =>
    owner().stage({ sessionId: leadId, commandId: `command-${leadId}`, deliveries: [ref] }),
  ).toThrow();
  owner().stage({ sessionId: memberId, commandId, deliveries: [ref] });
  const context = await owner().prepareSystemPrompt(
    memberId,
    commandId,
    'Symposium boot',
    new AbortController().signal,
  );
  expect(context).toContain(message.text);
  expect(f.events.getOrdinaryCollaborationDeliveryEvents(leadId, `command-${leadId}`)).toEqual([]);
  f.restart();
  owner().recover(memberId, commandId);
  expect(
    f.events.collaborationConversation.getMessage(group, message.messageId)!.deliveries[0].status,
  ).toBe('pending');
  expect(() => owner().accepted(leadId, commandId, 'thread', 'turn', context!)).toThrow();
  owner().accepted(memberId, commandId, 'thread', 'turn', context!);
  owner().accepted(memberId, commandId, 'thread', 'turn', context!);
  expect(
    f.events.collaborationConversation.getMessage(group, message.messageId)!.deliveries[0],
  ).toMatchObject({ status: 'delivered', revision: 1, commandId });
  const end = visible(f, memberId, 'Symposium result');
  visible(f, leadId, 'Telos lead notes');
  const mapping = {
    commandId,
    messageId: 'same-message',
    providerThreadId: 'private-thread',
    providerTurnId: 'private-turn',
  };
  expect(() => recordOrdinaryReplySource(f.events, leadId, mapping)).toThrow();
  recordOrdinaryReplySource(f.events, memberId, mapping);
  const replyInput = {
    requestId: randomUUID(),
    messageId: message.messageId,
    deliveryId,
    source: {
      conversationId: memberId,
      commandId,
      messageId: 'same-message',
      blockIds: ['same-block'],
      throughSequence: end,
    },
  };
  const reply = new OrdinaryCollaborationReplies(f.events).record(group, replyInput);
  expect(reply).toMatchObject({ text: 'Symposium result', author: { sessionId: memberId } });
  expect(JSON.stringify(reply)).not.toContain('private-thread');
  const outputs = [leadId, memberId].map((sessionId) =>
    f.events.registerSessionOutput(sessionId, {
      requestId: 'same-output-request',
      title: 'Result',
      source: f.events.listSessionOutputCandidates(sessionId)[0].source,
    }),
  );
  expect(outputs[0].outputId).not.toBe(outputs[1].outputId);
  expect(outputs[1].durability).toBe('reference_registered');
  expect(f.events.getSessionOutput(leadId, outputs[1].outputId)).toBeNull();
  expect(f.events.getSessionOutput(memberId, outputs[0].outputId)).toBeNull();
  f.restart();
  expect(f.events.readSessionOutput(leadId, outputs[0].outputId).content).toBe('Telos lead notes');
  expect(f.events.readSessionOutput(memberId, outputs[1].outputId).content).toBe(
    'Symposium result',
  );
  expect(new OrdinaryCollaborationReplies(f.events).record(group, replyInput)).toEqual(reply);
  expect((await f.api.read('outcome')).assignments).toEqual(receipt.work.assignments);
  expect(f.canonicalStatus('outcome')).toBe('active');
});

it('CT18 partial: native queue interrupt and terminal callbacks affect only their owning Telos/Symposium conversation', async () => {
  const { f, leadId, memberId } = await enrolledPair();
  const privateStore = new CodexConversationStore(join(dirname(f.dbPath), 'fake-native.db'));
  const runtimes: CodexConversation[] = [];
  try {
    const create = async (sessionId: string) => {
      let callbacks!: CodexLifecycleTransport;
      const calls: { method: string; params: Record<string, unknown> }[] = [];
      const runtime = new CodexConversation({
        conversationId: sessionId,
        cwd: f.events.getSession(sessionId)!.cwd!,
        store: privateStore,
        profile: {
          accountId: 'offline',
          accountLabel: 'Synthetic',
          credentialRef: '/synthetic-never-read',
          email: 'offline@example.invalid',
          planType: 'test',
          model: 'offline-fixture',
        },
        systemPrompt: 'Synthetic boot',
        enableCapacityRecovery: false,
        tools: [],
        emit: () => {},
        executeTool: async () => ({ content: '', isError: false }),
        createClient: (lifecycle) => {
          callbacks = lifecycle;
          return {
            initialize: async () => {},
            close: () => {},
            request: async (method, params) => {
              calls.push({ method, params });
              if (method === 'config/read') return { config: {} };
              if (method === 'account/read')
                return {
                  account: { type: 'chatgpt', email: 'offline@example.invalid', planType: 'test' },
                };
              if (method === 'thread/start')
                return {
                  thread: { id: `thread-${sessionId}` },
                  model: 'offline-fixture',
                  modelProvider: 'openai',
                };
              if (method === 'turn/start') return { turn: { id: `turn-${sessionId}` } };
              return {};
            },
          };
        },
      });
      runtimes.push(runtime);
      await runtime.initialize();
      await runtime.send({ id: `command-${sessionId}`, prompt: 'Explicit synthetic command' });
      return {
        runtime,
        calls,
        get callbacks() {
          return callbacks;
        },
      };
    };
    const telos = await create(leadId);
    const symposium = await create(memberId);
    await symposium.runtime.interrupt();
    expect(symposium.calls.filter((call) => call.method === 'turn/interrupt')).toEqual([
      {
        method: 'turn/interrupt',
        params: { threadId: `thread-${memberId}`, turnId: `turn-${memberId}` },
      },
    ]);
    expect(telos.calls.some((call) => call.method === 'turn/interrupt')).toBe(false);
    expect(symposium.runtime.queue()[0].status).toBe('running');
    symposium.callbacks.onNotification('turn/completed', {
      threadId: `thread-${leadId}`,
      turn: { id: `turn-${leadId}`, status: 'interrupted' },
    });
    expect(symposium.runtime.queue()[0].status).toBe('running');
    symposium.callbacks.onNotification('turn/completed', {
      threadId: `thread-${memberId}`,
      turn: { id: `turn-${memberId}`, status: 'interrupted' },
    });
    await vi.waitFor(() => expect(symposium.runtime.queue()[0].status).toBe('interrupted'));
    expect(telos.runtime.queue()[0].status).toBe('running');
    telos.callbacks.onNotification('turn/completed', {
      threadId: `thread-${leadId}`,
      turn: { id: `turn-${leadId}`, status: 'completed' },
    });
    await vi.waitFor(() => expect(telos.runtime.queue()[0].status).toBe('completed'));
    expect(f.canonicalStatus('outcome')).toBe('active');
  } finally {
    runtimes.forEach((runtime) => runtime.close());
    privateStore.close();
  }
});
