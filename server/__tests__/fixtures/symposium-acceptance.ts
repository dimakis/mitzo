import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollaborationMessage, CollaborationSettings } from '@mitzo/protocol';
import { EventStore } from '../../event-store.js';
import { CodexConversation } from '../../codex-conversation.js';
import { CodexConversationStore } from '../../codex-conversation-store.js';
import {
  OrdinaryCollaborationDelivery,
  ordinaryCollaborationContextHooks,
} from '../../collaboration-ordinary-delivery.js';
import {
  OrdinaryCollaborationReplies,
  recordOrdinaryReplySource,
} from '../../collaboration-ordinary-replies.js';
import {
  retainTelosWorkRoleContext,
  resolveTelosWorkSystemPrompt,
} from '../../telos-work-role-context.js';

const cleanups: Array<() => void> = [];
export function cleanupAcceptanceFixtures() {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
}

/** Canonical SQLite owners; only the external native RPC/account boundary is simulated.
 * No production account files, provider, server process or hand-written schema.
 * This composes internal owners, not app.ts or a native capacity implementation.
 */
export function createAcceptanceFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'symposium-acceptance-'));
  const path = join(directory, 'events.db');
  let store = new EventStore(path);
  const native = new CodexConversationStore(join(directory, 'native.db'));
  const drivers: CodexConversation[] = [];
  cleanups.push(() => {
    for (const driver of drivers) driver.close();
    native.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const group = randomUUID();
  const binding = {
    version: 2,
    account: {
      accountId: 'shared-offline-account',
      provider: 'openai-codex',
      profileRevision: 'r1',
    },
    harness: { implementation: 'codex' },
    execution: { location: 'local', targetId: 'offline-mac', targetRevision: 'r1' },
  } as const;
  const account = { ...binding.account, accountLabel: 'Offline only', model: 'offline-fixture' };
  const selection = {
    version: 1,
    agent: { profileId: 'default-mitzo', revision: 1, kind: 'builtin' },
    context: { source: 'none', revision: null },
    permission: { mode: 'agent', revision: 0 },
    model: account.model,
    thinking: null,
  } as const;
  const settings: CollaborationSettings = {
    binding,
    selection,
    repositoryWorkspaceId: 'workspace',
  };
  for (const sessionId of ['architect', 'reviewer']) {
    store.admitOrdinaryLocalCommand(
      {
        sessionId,
        selectedModel: account.model,
        mode: 'agent',
        cwd: directory,
        accountBinding: account,
        repositoryWorkspaceId: 'workspace',
      },
      binding,
      {
        clientMsgId: `initial-${sessionId}`,
        requestFingerprint: `fp-${sessionId}`,
        selection,
        payload: { text: 'Explicit fixture command' },
      },
    );
    store.claimOrdinaryLocalCommandDispatch(`initial-${sessionId}`);
  }
  store.setSessionCollaboration(group, {
    expectedRevision: 0,
    participantSessionIds: ['architect', 'reviewer'],
  });
  type Ref = { collaborationId: string; messageId: string; deliveryId: string };
  type Recording = { method: string; params: unknown };
  const requests: Recording[] = [];
  const authority = {
    authorize: async () => {},
    assertBeforeDispatch: () => {},
    assertProviderAccepted: () => {},
  };
  const delivery = () => new OrdinaryCollaborationDelivery(store, authority);
  const ref = (row: CollaborationMessage, sessionId: string): Ref => ({
    collaborationId: group,
    messageId: row.messageId,
    deliveryId: row.deliveries.find((entry) => entry.sessionId === sessionId)!.deliveryId,
  });
  return {
    group,
    account,
    binding,
    settings,
    directory,
    get store() {
      return store;
    },
    delivery,
    ref,
    samplingRequests: () => requests.filter((row) => row.method === 'turn/start'),
    reopen() {
      store.close();
      store = new EventStore(path);
    },
    role(sessionId: string, role: 'lead' | 'worker') {
      const text = `${sessionId} private brief`;
      retainTelosWorkRoleContext(store, sessionId, account, {
        version: 1,
        itemId: `item-${sessionId}`,
        role,
        brief: { revision: 'r1', text, sha256: createHash('sha256').update(text).digest('hex') },
        parentCriteria: [],
        overallGoal: { itemId: 'goal', revision: 'r1', text: 'Offline goal' },
        sources: [],
        artifacts: [],
        ...(role === 'worker'
          ? { executionTaskId: `task-${sessionId}`, leadConversationId: 'architect' }
          : {}),
      });
    },
    policy(sessionId: string, readsFutureDiscussion: boolean, repliesByDefault: boolean) {
      const view = store.collaborationConversation.view(group);
      return store.collaborationConversation.setPolicy(group, {
        requestId: randomUUID(),
        expectedMembershipRevision: view.membershipRevision,
        sessionId,
        expectedRevision: view.policies.find((p) => p.sessionId === sessionId)?.revision ?? 0,
        readsFutureDiscussion,
        repliesByDefault,
      });
    },
    message(text: string, sessionIds?: string[]) {
      const view = store.collaborationConversation.view(group);
      return store.collaborationConversation.acceptMessage(group, {
        requestId: randomUUID(),
        expectedMembershipRevision: view.membershipRevision,
        expectedPolicySequence: view.policySequence,
        text,
        responders: sessionIds ? { kind: 'selected', sessionIds } : { kind: 'default' },
        snapshot: null,
      });
    },
    finalizedReply(origin: CollaborationMessage, sessionId = 'reviewer') {
      const commandId = `initial-${sessionId}`;
      const messageId = 'finalized-reply';
      const receipt = origin.deliveries.find((entry) => entry.sessionId === sessionId)!;
      store.collaborationConversation.recordDelivery(group, origin.messageId, receipt.deliveryId, {
        requestId: randomUUID(),
        expectedRevision: receipt.revision,
        status: 'delivered',
        commandId,
        reason: null,
      });
      recordOrdinaryReplySource(store, sessionId, {
        commandId,
        messageId,
        providerThreadId: `private-thread-${sessionId}`,
        providerTurnId: `private-turn-${sessionId}`,
      });
      store.append(sessionId, 'message_start', { messageId });
      store.append(sessionId, 'block_start', { messageId, blockId: 'text', blockType: 'text' });
      store.append(sessionId, 'block_delta', {
        messageId,
        blockId: 'text',
        delta: 'Reviewed answer',
      });
      store.append(sessionId, 'block_end', { messageId, blockId: 'text', blockType: 'text' });
      const end = store.append(sessionId, 'message_end', { messageId });
      return new OrdinaryCollaborationReplies(store).record(group, {
        requestId: randomUUID(),
        messageId: origin.messageId,
        deliveryId: receipt.deliveryId,
        source: {
          conversationId: sessionId,
          commandId,
          messageId,
          blockIds: ['text'],
          throughSequence: end,
        },
      });
    },
    runtime(
      sessionId: string,
      refs: Ref[] = [],
      baseContext = 'Ordinary application context',
      beforeDispatch?: () => Promise<void>,
    ) {
      const commandId = `initial-${sessionId}`;
      const owner = delivery();
      if (refs.length) owner.stage({ sessionId, commandId, deliveries: refs });
      const ownRequests: Recording[] = [];
      const driver = new CodexConversation({
        conversationId: sessionId,
        cwd: directory,
        store: native,
        profile: {
          accountId: account.accountId,
          accountLabel: account.accountLabel,
          credentialRef: join(directory, 'never-read-credentials'),
          email: 'offline@example.invalid',
          planType: 'test',
          model: account.model,
        },
        systemPrompt: 'Ordinary boot guidance',
        enableCapacityRecovery: false,
        tools: [
          {
            name: `${sessionId}_read`,
            description: 'Offline tool',
            input_schema: { type: 'object', properties: {} },
          },
        ],
        emit: () => {},
        executeTool: async () => {
          throw Error('No tool execution authorized by fixture');
        },
        ...ordinaryCollaborationContextHooks(sessionId, owner, {
          prepareSystemPrompt: async () =>
            resolveTelosWorkSystemPrompt(store, sessionId, account, baseContext),
        }),
        prepareTurn: beforeDispatch,
        createClient: () => ({
          initialize: async () => {},
          close: () => {},
          request: async (method, params) => {
            const row = { method, params: structuredClone(params) };
            requests.push(row);
            ownRequests.push(row);
            if (method === 'config/read') return { config: {} };
            if (method === 'account/read')
              return {
                account: { type: 'chatgpt', email: 'offline@example.invalid', planType: 'test' },
              };
            if (method === 'thread/start')
              return {
                thread: { id: `private-thread-${sessionId}` },
                model: account.model,
                modelProvider: 'openai',
              };
            if (method === 'turn/start') return { turn: { id: `private-turn-${sessionId}` } };
            return {};
          },
        }),
      });
      drivers.push(driver);
      return { driver, requests: ownRequests };
    },
  };
}
