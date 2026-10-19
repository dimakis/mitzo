import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storedEventToClientMessage } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { CodexConversation } from '../codex-conversation.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import type { CodexLifecycleTransport } from '../codex-app-server-client.js';
import {
  OrdinaryCollaborationDelivery,
  ordinaryCollaborationContextHooks,
} from '../collaboration-ordinary-delivery.js';

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
const authorize = vi.fn(async () => {});
const assertProviderAccepted = vi.fn();
const assertBeforeDispatch = vi.fn();
const signal = () => new AbortController().signal;
function adapter() {
  return new OrdinaryCollaborationDelivery(store, {
    authorize,
    assertBeforeDispatch,
    assertProviderAccepted,
  });
}
function command(sessionId: string, commandId = `initial-${sessionId}`) {
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
        accountLabel: 'Shared fixture',
        model: selection.model,
      },
      repositoryWorkspaceId: 'workspace',
    },
    binding,
    {
      clientMsgId: commandId,
      requestFingerprint: `fp-${commandId}`,
      selection,
      payload: { text: 'Explicit operator prompt' },
    },
  );
  store.claimOrdinaryLocalCommandDispatch(commandId);
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mitzo-ordinary-delivery-'));
  path = join(directory, 'events.db');
  store = new EventStore(path);
  group = randomUUID();
  authorize.mockReset().mockResolvedValue(undefined);
  assertProviderAccepted.mockReset();
  assertBeforeDispatch.mockReset();
  command('one');
  command('two');
  store.setSessionCollaboration(group, {
    expectedRevision: 0,
    participantSessionIds: ['one', 'two'],
  });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
function message(text = 'Read this exact shared discussion') {
  return store.collaborationConversation.acceptMessage(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    expectedPolicySequence: store.collaborationConversation.view(group).policySequence,
    text,
    responders: { kind: 'selected', sessionIds: ['two'] },
    snapshot: null,
  });
}
function ref(row: ReturnType<typeof message>, sessionId = 'two') {
  return {
    collaborationId: group,
    messageId: row.messageId,
    deliveryId: row.deliveries.find((delivery) => delivery.sessionId === sessionId)!.deliveryId,
  };
}
function read(row: ReturnType<typeof message>, sessionId = 'two') {
  return store.collaborationConversation
    .getMessage(group, row.messageId)!
    .deliveries.find((delivery) => delivery.sessionId === sessionId)!;
}
function stage(row: ReturnType<typeof message>, owner = adapter(), sessionId = 'two') {
  owner.stage({ sessionId, commandId: `initial-${sessionId}`, deliveries: [ref(row, sessionId)] });
  return owner;
}

it('stages retained context without dispatching, and delivers only the exact provider-accepted bytes', async () => {
  const row = message();
  const owner = stage(row);
  expect(read(row).status).toBe('pending');
  expect(authorize).not.toHaveBeenCalled();
  const context = await owner.prepareSystemPrompt(
    'two',
    'initial-two',
    'Original base\n',
    signal(),
  );
  expect(context).toContain('Original base\n');
  expect(context).toContain(row.text);
  expect(read(row).status).toBe('pending');
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(() =>
    owner.accepted('two', 'initial-two', 'thread', 'turn', context + 'changed'),
  ).toThrow();
  expect(read(row).status).toBe('pending');
  owner.accepted('two', 'initial-two', 'thread', 'turn', context!);
  expect(read(row)).toMatchObject({ status: 'delivered', commandId: 'initial-two' });
  expect(assertProviderAccepted).toHaveBeenCalledWith({
    sessionId: 'two',
    commandId: 'initial-two',
    providerThreadId: 'thread',
    providerTurnId: 'turn',
  });
  owner.accepted('two', 'initial-two', 'thread', 'turn', context!);
  expect(read(row).revision).toBe(1);
  expect(() => owner.accepted('two', 'initial-two', 'thread', 'another-turn', context!)).toThrow();
});

it('binds immutable delivery batches to admitted ordinary sessions and preserves independent recipients', async () => {
  const row = message();
  const owner = stage(row);
  expect(() =>
    owner.stage({ sessionId: 'one', commandId: 'initial-two', deliveries: [ref(row)] }),
  ).toThrow();
  expect(() =>
    owner.stage({ sessionId: 'two', commandId: 'missing', deliveries: [ref(row)] }),
  ).toThrow();
  const changed = message('Another prompt');
  expect(() => stage(changed, owner)).toThrow();
  stage(row, owner);
  expect(store.getOrdinaryCollaborationDeliveryEvents('two', 'initial-two')).toHaveLength(1);
  const context = await owner.prepareSystemPrompt('two', 'initial-two', undefined, signal());
  assertProviderAccepted.mockImplementationOnce(() => {
    throw Error('Native receipt changed');
  });
  expect(() => owner.accepted('two', 'initial-two', 'thread', 'turn', context!)).toThrow();
  expect(read(row).status).toBe('pending');
  expect(store.getOrdinaryCollaborationDeliveryEvents('one', 'initial-one')).toEqual([]);
});

it('keeps reading silent until a later explicit command carries context and one reply origin', async () => {
  store.collaborationConversation.setPolicy(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    sessionId: 'one',
    expectedRevision: 0,
    readsFutureDiscussion: true,
    repliesByDefault: false,
  });
  const first = message('Discussion for a silent reader');
  expect(read(first, 'one')).toMatchObject({
    purpose: 'context',
    status: 'pending',
    commandId: null,
  });
  expect(store.getSessionEvents('one')).toEqual([]);
  const second = store.collaborationConversation.acceptMessage(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    expectedPolicySequence: store.collaborationConversation.view(group).policySequence,
    text: 'Now answer explicitly',
    responders: { kind: 'selected', sessionIds: ['one'] },
    snapshot: null,
  });
  const owner = adapter();
  owner.stage({
    sessionId: 'one',
    commandId: 'initial-one',
    deliveries: [ref(first, 'one'), ref(second, 'one')],
  });
  const context = await owner.prepareSystemPrompt('one', 'initial-one', undefined, signal());
  expect(context).toContain(first.text);
  expect(context).toContain(second.text);
  expect(context!.indexOf(first.text)).toBeLessThan(context!.indexOf(second.text));
  expect(context).toContain(`"sequence":${first.sequence}`);
  owner.accepted('one', 'initial-one', 'reader-thread', 'reader-turn', context!);
  expect(read(first, 'one').status).toBe('delivered');
  expect(read(second, 'one').status).toBe('delivered');
  expect(read(first, 'two').status).toBe('pending');
});

it('reauthorizes frozen sources at each admission barrier and never ACKs a rejected preparation', async () => {
  const row = message();
  const owner = stage(row);
  authorize.mockRejectedValueOnce(Error('Access revoked'));
  await expect(owner.prepareSystemPrompt('two', 'initial-two', 'Base', signal())).rejects.toThrow(
    'Access revoked',
  );
  expect(() => owner.accepted('two', 'initial-two', 'thread', 'turn', 'Base')).toThrow();
  const context = await owner.prepareSystemPrompt('two', 'initial-two', 'Base', signal());
  expect(authorize).toHaveBeenCalledTimes(2);
  expect(context).toContain(row.text);
  expect(read(row).status).toBe('pending');
});

it('claims each pending delivery for only one ordinary command, including after restart', () => {
  const row = message();
  stage(row);
  command('two', 'another-command');
  const input = { sessionId: 'two', commandId: 'another-command', deliveries: [ref(row)] };
  expect(() => adapter().stage(input)).toThrow();
  store.close();
  store = new EventStore(path);
  expect(() => adapter().stage(input)).toThrow();
});

it('refuses an overfull batch before hydrating later retained messages', () => {
  store.collaborationConversation.setPolicy(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    sessionId: 'one',
    expectedRevision: 0,
    readsFutureDiscussion: true,
    repliesByDefault: false,
  });
  const rows = Array.from({ length: 7 }, () => message('x'.repeat(100_000)));
  const readMessage = vi.spyOn(store.collaborationConversation, 'getMessage');
  expect(() =>
    adapter().stage({
      sessionId: 'one',
      commandId: 'initial-one',
      deliveries: rows.map((row) => ref(row, 'one')),
    }),
  ).toThrow('capacity_refused');
  expect(readMessage).toHaveBeenCalledTimes(6);
  expect(store.getOrdinaryCollaborationDeliveryEvents('one', 'initial-one')).toEqual([]);
});

it('durably records provider acceptance before effects and recovers exact partial outcomes after restart', async () => {
  const first = message('First context');
  store.collaborationConversation.recordDelivery(group, first.messageId, ref(first).deliveryId, {
    requestId: randomUUID(),
    expectedRevision: 0,
    status: 'uncertain',
    commandId: 'initial-two',
    reason: 'Lost response',
  });
  const owner = stage(first);
  const context = await owner.prepareSystemPrompt('two', 'initial-two', undefined, signal());
  const original = store.collaborationConversation.recordDelivery.bind(
    store.collaborationConversation,
  );
  const write = vi
    .spyOn(store.collaborationConversation, 'recordDelivery')
    .mockImplementationOnce(() => {
      throw Error('Disk busy after ACK');
    });
  expect(() => owner.accepted('two', 'initial-two', 'thread', 'turn', context!)).toThrow(
    'Disk busy after ACK',
  );
  expect(store.getOrdinaryCollaborationDeliveryEvents('two', 'initial-two').at(-1)!.type).toBe(
    'ordinary_collaboration_context_accepted',
  );
  write.mockRestore();
  expect(read(first).status).toBe('uncertain');
  store.close();
  store = new EventStore(path);
  authorize.mockRejectedValue(Error('Sources no longer readable'));
  adapter().recover('two', 'initial-two');
  expect(read(first)).toMatchObject({ status: 'delivered', commandId: 'initial-two', revision: 2 });
  adapter().recover('two', 'initial-two');
  expect(read(first).revision).toBe(2);
  expect(original).toBeTypeOf('function');
});

it('does not recover uncertain dispatch without an exact durable provider ACK', async () => {
  const row = message();
  const owner = stage(row);
  await owner.prepareSystemPrompt('two', 'initial-two', undefined, signal());
  store.close();
  store = new EventStore(path);
  adapter().recover('two', 'initial-two');
  expect(read(row).status).toBe('pending');
  expect(() => adapter().accepted('two', 'initial-one', 'thread', 'turn', 'anything')).toThrow();
});

it('recovers each ACKed receipt independently when an earlier receipt became terminal', async () => {
  store.collaborationConversation.setPolicy(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    sessionId: 'one',
    expectedRevision: 0,
    readsFutureDiscussion: true,
    repliesByDefault: false,
  });
  const first = message('Earlier context');
  const second = store.collaborationConversation.acceptMessage(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    expectedPolicySequence: store.collaborationConversation.view(group).policySequence,
    text: 'Explicit reply',
    responders: { kind: 'selected', sessionIds: ['one'] },
    snapshot: null,
  });
  const rows = [first, second].sort((a, b) =>
    ref(a, 'one').deliveryId.localeCompare(ref(b, 'one').deliveryId),
  );
  const owner = adapter();
  owner.stage({
    sessionId: 'one',
    commandId: 'initial-one',
    deliveries: rows.map((row) => ref(row, 'one')),
  });
  const context = await owner.prepareSystemPrompt('one', 'initial-one', undefined, signal());
  store.collaborationConversation.recordDelivery(
    group,
    rows[0].messageId,
    ref(rows[0], 'one').deliveryId,
    {
      requestId: randomUUID(),
      expectedRevision: 0,
      status: 'failed',
      commandId: 'initial-one',
      reason: 'Retained terminal refusal',
    },
  );
  expect(() => owner.accepted('one', 'initial-one', 'thread', 'turn', context!)).toThrow();
  expect(read(rows[0], 'one').status).toBe('failed');
  expect(read(rows[1], 'one').status).toBe('delivered');
  store.close();
  store = new EventStore(path);
  expect(() => adapter().recover('one', 'initial-one')).toThrow();
  expect(read(rows[0], 'one').status).toBe('failed');
  expect(read(rows[1], 'one').revision).toBe(1);
});

it('preserves original hook references when no delivery owner is installed', () => {
  const existing = {
    prepareSystemPrompt: vi.fn(),
    onApplicationContextAccepted: vi.fn(),
    onProviderDispatch: vi.fn(),
  };
  const hooks = ordinaryCollaborationContextHooks('two', undefined, existing);
  expect(hooks.prepareSystemPrompt).toBe(existing.prepareSystemPrompt);
  expect(hooks.onApplicationContextAccepted).toBe(existing.onApplicationContextAccepted);
  expect(hooks.onProviderDispatch).toBe(existing.onProviderDispatch);
});

it('keeps private stage/preparation/ACK payloads off client event and replay projections', async () => {
  const row = message('Private delivery context');
  const owner = stage(row);
  const context = await owner.prepareSystemPrompt('two', 'initial-two', undefined, signal());
  owner.accepted('two', 'initial-two', 'private-thread', 'private-turn', context!);
  const events = store.getSessionEvents('two');
  expect(events).toHaveLength(3);
  for (const event of events) {
    const wire = storedEventToClientMessage({ ...event, prevSessionSeq: event.seq - 1 });
    expect(wire).toEqual({
      type: event.type,
      sessionId: 'two',
      seq: event.seq,
      prevSessionSeq: event.seq - 1,
    });
    expect(JSON.stringify(wire)).not.toContain('initial-two');
    expect(JSON.stringify(wire)).not.toContain(row.text);
  }
});

it('leaves unstaged ordinary commands and their context unchanged', async () => {
  expect(await adapter().prepareSystemPrompt('two', 'initial-two', 'Base\n', signal())).toBe(
    'Base\n',
  );
  expect(
    await adapter().prepareSystemPrompt('two', 'initial-two', undefined, signal()),
  ).toBeUndefined();
  adapter().accepted('two', 'initial-two', 'thread', 'turn', 'Base\n');
  expect(authorize).not.toHaveBeenCalled();
  expect(store.getSessionEvents('two')).toEqual([]);
});

it.each([
  {
    lostAck: false,
    base: 'Preserved native application context',
    revoke: false,
    observerFails: false,
  },
  {
    lostAck: true,
    base: 'Preserved native application context',
    revoke: false,
    observerFails: false,
  },
  { lostAck: false, base: undefined, revoke: false, observerFails: false },
  {
    lostAck: false,
    base: 'Preserved native application context',
    revoke: true,
    observerFails: false,
  },
  {
    lostAck: false,
    base: 'Preserved native application context',
    revoke: false,
    observerFails: true,
  },
])(
  'composes through the real ordinary native driver: %j',
  async ({ lostAck, base, revoke, observerFails }) => {
    const row = message();
    const owner = stage(row);
    const privateStore = new CodexConversationStore(join(directory, 'native.db'));
    const requests: Array<{ method: string; params: unknown }> = [];
    const previousAccepted = vi.fn();
    const completed = vi.fn();
    if (observerFails)
      previousAccepted.mockImplementation(() => {
        throw Error('Legacy adoption store unavailable');
      });
    let lifecycle!: CodexLifecycleTransport;
    let acknowledge!: (response: unknown) => void;
    const originalHooks = {
      prepareSystemPrompt: async () => base,
      onApplicationContextAccepted: previousAccepted,
    };
    // Production assigns composed callbacks back onto the same options object.
    Object.assign(originalHooks, ordinaryCollaborationContextHooks('two', owner, originalHooks));
    const runtime = new CodexConversation({
      conversationId: 'two',
      cwd: '/fixture',
      store: privateStore,
      profile: {
        accountId: 'shared-account',
        accountLabel: 'Offline fixture',
        credentialRef: '/offline',
        email: 'fixture@example.com',
        planType: 'test',
        model: 'offline-fixture',
      },
      systemPrompt: 'Existing boot guidance',
      enableCapacityRecovery: false,
      tools: [],
      emit: () => {},
      executeTool: async () => ({ content: '', isError: false }),
      ...originalHooks,
      onProviderComplete: completed,
      prepareTurn: async () => {
        if (revoke)
          assertBeforeDispatch.mockImplementation(() => {
            throw Error('Access changed after preparation');
          });
      },
      createClient: (callbacks) => {
        lifecycle = callbacks;
        return {
          initialize: async () => {},
          close: () => {},
          request: async (method, params) => {
            requests.push({ method, params });
            if (method === 'config/read') return { config: {} };
            if (method === 'account/read')
              return {
                account: { type: 'chatgpt', email: 'fixture@example.com', planType: 'test' },
              };
            if (method === 'thread/start')
              return {
                thread: { id: 'private-thread' },
                model: 'offline-fixture',
                modelProvider: 'openai',
              };
            if (method === 'turn/start')
              return new Promise((resolve) => {
                acknowledge = resolve;
              });
            return {};
          },
        };
      },
    });
    try {
      await runtime.initialize();
      expect(requests.filter((entry) => entry.method === 'turn/start')).toEqual([]);
      const pending = runtime.send({ id: 'initial-two', prompt: 'Explicit operator prompt' });
      if (revoke) {
        await pending.catch(() => {});
        expect(requests.filter((entry) => entry.method === 'turn/start')).toEqual([]);
        expect(read(row).status).toBe('pending');
        expect(previousAccepted).not.toHaveBeenCalled();
        return;
      }
      await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
      expect(read(row).status).toBe('pending');
      const projection = observerFails
        ? vi.spyOn(store.collaborationConversation, 'recordDelivery').mockImplementationOnce(() => {
            throw Error('Projection unavailable after native ACK');
          })
        : undefined;
      if (lostAck) lifecycle.onClose(Error('Lost ACK'));
      acknowledge({ turn: { id: 'private-turn' } });
      await pending.catch(() => {});
      if (observerFails) {
        expect(
          store.getOrdinaryCollaborationDeliveryEvents('two', 'initial-two').at(-1)!.type,
        ).toBe('ordinary_collaboration_context_accepted');
        expect(runtime.queue()).toMatchObject([{ id: 'initial-two', status: 'interrupted' }]);
        expect(completed).toHaveBeenCalledWith('initial-two', 'interrupted');
        projection!.mockRestore();
        store.close();
        store = new EventStore(path);
        authorize.mockRejectedValue(Error('Source access unavailable after restart'));
        adapter().recover('two', 'initial-two');
        expect(read(row).status).toBe('delivered');
        expect(requests.filter((entry) => entry.method === 'turn/start')).toHaveLength(1);
        return;
      }
      expect(read(row).status).toBe(lostAck ? 'pending' : 'delivered');
      expect(previousAccepted).toHaveBeenCalledTimes(lostAck || base === undefined ? 0 : 1);
      if (!lostAck && base !== undefined)
        expect(previousAccepted).toHaveBeenCalledExactlyOnceWith(
          'initial-two',
          'private-thread',
          'private-turn',
          base,
        );
      const request = requests.find((entry) => entry.method === 'turn/start')!.params;
      if (base !== undefined) expect(JSON.stringify(request)).toContain(base);
      expect(JSON.stringify(request)).toContain(row.text);
      expect(requests.filter((entry) => entry.method === 'turn/start')).toHaveLength(1);
    } finally {
      runtime.close();
      privateStore.close();
    }
  },
);

it.each([
  { projectionFails: false, failure: 'error' },
  { projectionFails: true, failure: 'error' },
  { projectionFails: false, failure: 'null' },
  { projectionFails: true, failure: 'null' },
  { projectionFails: false, failure: 'undefined' },
  { projectionFails: true, failure: 'undefined' },
  { projectionFails: true, failure: 'context-only' },
])(
  'retains exact context ACK and original observer error precedence: %j',
  async ({ projectionFails, failure }) => {
    const row = message();
    const owner = stage(row);
    const native = new CodexConversationStore(join(directory, 'observer-native.db'));
    const providerFailure =
      failure === 'null'
        ? null
        : failure === 'undefined'
          ? undefined
          : Error('Ordinary turn lifecycle adoption failed');
    const contextFailure = Error('Context projection temporarily unavailable');
    const providerAccepted = vi.fn(() => {
      if (failure !== 'context-only') throw providerFailure;
    });
    const previousContextAccepted = vi.fn();
    const completed = vi.fn();
    const requests: Array<{ method: string; params: unknown }> = [];
    let acknowledge!: (response: unknown) => void;
    const runtime = new CodexConversation({
      conversationId: 'two',
      cwd: '/fixture',
      store: native,
      profile: {
        accountId: 'shared-account',
        accountLabel: 'Offline fixture',
        credentialRef: '/offline',
        email: 'fixture@example.com',
        planType: 'test',
        model: 'offline-fixture',
      },
      systemPrompt: 'Existing boot guidance',
      tools: [],
      enableCapacityRecovery: false,
      emit: () => {},
      executeTool: async () => ({ content: '', isError: false }),
      ...ordinaryCollaborationContextHooks('two', owner, {
        prepareSystemPrompt: async () => 'Original base context',
        onApplicationContextAccepted: previousContextAccepted,
      }),
      onProviderAccepted: providerAccepted,
      onProviderComplete: completed,
      createClient: () => ({
        initialize: async () => {},
        close: () => {},
        request: async (method, params) => {
          requests.push({ method, params });
          if (method === 'config/read') return { config: {} };
          if (method === 'account/read')
            return { account: { type: 'chatgpt', email: 'fixture@example.com', planType: 'test' } };
          if (method === 'thread/start')
            return {
              thread: { id: 'private-thread' },
              model: 'offline-fixture',
              modelProvider: 'openai',
            };
          if (method === 'turn/start')
            return new Promise((resolve) => {
              acknowledge = resolve;
            });
          return {};
        },
      }),
    });
    let restoreProjection: (() => void) | undefined;
    try {
      await runtime.initialize();
      const outcome = runtime
        .send({ id: 'initial-two', prompt: 'Explicit operator prompt' })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
      expect(read(row).status).toBe('pending');
      if (projectionFails) {
        const projection = vi
          .spyOn(store.collaborationConversation, 'recordDelivery')
          .mockImplementationOnce(() => {
            throw contextFailure;
          });
        restoreProjection = () => {
          projection.mockRestore();
        };
      }
      acknowledge({ turn: { id: 'private-turn' } });
      expect(await outcome).toBe(failure === 'context-only' ? contextFailure : providerFailure);
      expect(providerAccepted).toHaveBeenCalledExactlyOnceWith(
        'initial-two',
        'private-thread',
        'private-turn',
      );
      const turn = requests.find((request) => request.method === 'turn/start')!.params as {
        additionalContext: Record<string, { value: string }>;
      };
      const exactContext = Object.values(turn.additionalContext)
        .map((fragment) => fragment.value)
        .join('');
      expect(
        store.getOrdinaryCollaborationDeliveryEvents('two', 'initial-two').at(-1),
      ).toMatchObject({
        type: 'ordinary_collaboration_context_accepted',
        payload: {
          commandId: 'initial-two',
          providerThreadId: 'private-thread',
          providerTurnId: 'private-turn',
          contextSha256: createHash('sha256').update(exactContext).digest('hex'),
        },
      });
      expect(previousContextAccepted).toHaveBeenCalledExactlyOnceWith(
        'initial-two',
        'private-thread',
        'private-turn',
        'Original base context',
      );
      expect(runtime.queue()).toMatchObject([{ id: 'initial-two', status: 'interrupted' }]);
      expect(completed).toHaveBeenCalledExactlyOnceWith('initial-two', 'interrupted');
      expect(read(row).status).toBe(projectionFails ? 'pending' : 'delivered');
      restoreProjection?.();
      restoreProjection = undefined;
      runtime.close();
      store.close();
      store = new EventStore(path);
      authorize.mockClear().mockRejectedValue(Error('Source access unavailable after restart'));
      adapter().recover('two', 'initial-two');
      expect(read(row).status).toBe('delivered');
      expect(authorize).not.toHaveBeenCalled();
      expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    } finally {
      restoreProjection?.();
      runtime.close();
      native.close();
    }
  },
);
