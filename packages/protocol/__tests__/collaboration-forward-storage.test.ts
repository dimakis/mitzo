import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventStore } from '../src/event-store.js';
import { CollaborationMessageSchema } from '../src/collaboration-conversation.js';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const binding = {
  version: 2,
  account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
  harness: { implementation: 'codex' },
  execution: { location: 'local', targetId: 'offline-mac', targetRevision: 'r1' },
} as const;
const selection = {
  version: 1,
  agent: { profileId: 'reviewer', revision: 1 },
  context: { source: 'none', revision: null },
  permission: { mode: 'ask', revision: 0 },
  model: 'offline-fixture',
  thinking: null,
} as const;
let root: string, path: string, store: EventStore, group: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-forward-storage-')));
  path = join(root, 'events.db');
  store = new EventStore(path);
  group = randomUUID();
  for (const sessionId of ['source', 'one', 'two', 'other']) {
    store.admitOrdinaryLocalCommand(
      {
        sessionId,
        selectedModel: selection.model,
        mode: 'ask',
        cwd: '/offline',
        accountBinding: { ...binding.account, accountLabel: 'Offline', model: selection.model },
        repositoryWorkspaceId: `workspace-${sessionId}`,
      },
      binding,
      {
        clientMsgId: `initial-${sessionId}`,
        requestFingerprint: `initial-${sessionId}`,
        selection,
        payload: { text: 'Offline fixture' },
      },
    );
  }
  store.setSessionCollaboration(group, {
    expectedRevision: 0,
    participantSessionIds: ['one', 'two', 'other'],
  });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const sequence = store.append('source', 'user_message', {
    messageId: 'selected',
    text: '  Exact\r\nπ selected text  ',
    privateIdentity: 'PRIVATE PROVIDER',
  });
  const source = store.openCollaborationVisibleSource('source', {
    sequence,
    messageId: 'selected',
  });
  const messages = source.readSelected(['selected']);
  const input = {
    selection: {
      requestId: randomUUID(),
      target: { collaborationId: group, expectedMembershipRevision: 1, sessionIds: ['two', 'one'] },
      sourceConversationId: 'source' as string | null,
      boundary: { sequence, messageId: 'selected' } as {
        sequence: number;
        messageId: string | null;
      } | null,
      messages: messages.map((message) => ({
        messageId: message.messageId,
        sequence: message.sequence,
        blocks: message.blocks.map(({ blockId, sha256 }) => ({ blockId, sha256 })),
      })),
      artifacts: [] as Array<{
        artifactId: string;
        revision: number;
        sha256: string;
        kind: 'retained_artifact' | 'transcript_reference';
      }>,
    },
    note: '',
  };
  const packet = {
    version: 1,
    requestId: input.selection.requestId,
    mode: 'context_only',
    target: input.selection.target,
    sourceConversationId: input.selection.sourceConversationId,
    sourceIdentity: source.sourceIdentity as string | null,
    boundary: input.selection.boundary,
    messages,
    artifacts: [] as Array<Record<string, unknown>>,
  };
  const reserve = (operatorId = 'operator') =>
    store.collaborationConversation.reserveForwardPreparation(group, { operatorId, input });
  const complete = (
    record = reserve(),
    serialized = JSON.stringify(packet),
    fence: (() => void) | undefined = () => {},
  ) =>
    store.collaborationConversation.completeForwardPreparation(
      group,
      input.selection.requestId,
      { operatorId: record.operatorId, serialized, packetSha256: hash(serialized) },
      fence!,
    );
  const prepare = () => {
    const record = reserve();
    const publicRecord = complete(record);
    return { record, publicRecord };
  };
  const confirmInput = (prepared = prepare().publicRecord) => ({
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    forward: {
      forwardId: prepared.forwardId,
      selectionFingerprint: prepared.selectionFingerprint,
      packetSha256: prepared.packetSha256!,
    },
    requestReply: false as const,
  });
  const confirm = (
    input = confirmInput(),
    fence: (() => void) | undefined = () => {},
    operatorId = 'operator',
  ) => store.collaborationConversation.confirmForward(group, { operatorId, input }, fence!);
  return { input, packet, reserve, complete, prepare, confirmInput, confirm };
}
function database<T>(read: (db: Database.Database) => T): T {
  const db = new Database(path);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

it('reserves one stable private operation with actual settings before payload reads, without effects', () => {
  const f = fixture();
  const before = store.collaborationConversation.view(group).cursor;
  const first = f.reserve();
  expect(first).toMatchObject({
    operatorId: 'operator',
    input: f.input,
    serialized: null,
    packetSha256: null,
    confirmation: null,
    settings: {
      one: { repositoryWorkspaceId: 'workspace-one', selection },
      two: { repositoryWorkspaceId: 'workspace-two', selection },
    },
  });
  expect(Object.keys(first.settings).sort()).toEqual(['one', 'two']);
  expect(first.selectionFingerprint).toBe(hash(JSON.stringify(f.input.selection)));
  expect(f.reserve()).toEqual(first);
  expect(store.collaborationConversation.view(group).cursor).toBe(before);
  expect(store.listSessions()).toHaveLength(4);
});

it.each(['actor', 'note', 'target', 'block', 'source'] as const)(
  'binds the original request to exact %s intent',
  (field) => {
    const f = fixture();
    f.reserve();
    const changed = structuredClone(f.input);
    if (field === 'note') changed.note = 'Different note';
    if (field === 'target') changed.selection.target.sessionIds = ['one'];
    if (field === 'block') changed.selection.messages[0].blocks[0].sha256 = 'a'.repeat(64);
    if (field === 'source') changed.selection.sourceConversationId = 'different-source';
    expect(() =>
      store.collaborationConversation.reserveForwardPreparation(group, {
        operatorId: field === 'actor' ? 'different-actor' : 'operator',
        input: changed,
      }),
    ).toThrow('request_conflict');
  },
);

it('retains the exact B literal and packet digest, keeping it out of public reads and events', () => {
  const f = fixture();
  const record = f.reserve();
  const { artifacts, ...rest } = f.packet;
  const serialized = JSON.stringify({ artifacts, ...rest });
  const result = f.complete(record, serialized);
  expect(result).toMatchObject({
    state: 'prepared',
    forwardId: record.forwardId,
    packetSha256: hash(serialized),
    deliveries: [],
    confirmation: null,
  });
  expect(
    store.collaborationConversation.getForwardPacket(group, {
      forwardId: record.forwardId,
      packetSha256: hash(serialized),
    }).serialized,
  ).toBe(serialized);
  expect(JSON.stringify(result)).not.toMatch(
    /serialized|operatorId|settings|Exact|PRIVATE|sourceIdentity/,
  );
  expect(JSON.stringify(store.collaborationConversation.view(group))).not.toContain('Exact');
});

it('recovers pending/prepared private records after restart before changed source or settings', () => {
  const f = fixture();
  const first = f.reserve();
  store.close();
  store = new EventStore(path);
  expect(
    store.collaborationConversation.getForwardPreparation(
      group,
      'operator',
      f.input.selection.requestId,
    ),
  ).toEqual(first);
  f.complete(first);
  const completed = store.collaborationConversation.getForwardPreparation(
    group,
    'operator',
    f.input.selection.requestId,
  );
  store.hideSession('one');
  store.hideSession('source');
  store.close();
  store = new EventStore(path);
  expect(f.reserve()).toEqual(completed);
  expect(() =>
    store.collaborationConversation.getForwardPreparation(
      group,
      'other-operator',
      f.input.selection.requestId,
    ),
  ).toThrow();
});

it.each(['missing', 'promise', 'value', 'refusal'] as const)(
  'requires a real synchronous %s completion fence before payload writes',
  (mode) => {
    const f = fixture();
    const record = f.reserve();
    const fence =
      mode === 'missing'
        ? undefined
        : mode === 'promise'
          ? () => Promise.resolve()
          : mode === 'value'
            ? () => true
            : () => {
                throw Error('scope changed');
              };
    const serialized = JSON.stringify(f.packet);
    expect(() =>
      store.collaborationConversation.completeForwardPreparation(
        group,
        f.input.selection.requestId,
        { operatorId: 'operator', serialized, packetSha256: hash(serialized) },
        fence!,
      ),
    ).toThrow();
    expect(
      store.collaborationConversation.getForwardPreparation(
        group,
        'operator',
        f.input.selection.requestId,
      ),
    ).toEqual(record);
    expect(
      database((db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM collaboration_records WHERE kind='forward-preparation'",
          )
          .get(),
      ),
    ).toEqual({ n: 1 });
  },
);

it.each([
  'actor',
  'digest',
  'target',
  'source',
  'sequence',
  'text',
  'block',
  'extra',
  'private',
  'duplicate',
] as const)('rejects corrupted %s packet identity before calling the save fence', (field) => {
  const f = fixture();
  f.reserve();
  const packet = structuredClone(f.packet);
  if (field === 'target') packet.target.sessionIds = ['other'];
  if (field === 'source') packet.sourceConversationId = 'other';
  if (field === 'sequence') packet.messages[0].sequence++;
  if (field === 'text') packet.messages[0].blocks[0].content += 'changed';
  if (field === 'block') packet.messages[0].blocks[0].blockId = 'wrong';
  if (field === 'extra') Object.assign(packet, { providerThreadId: 'PRIVATE' });
  if (field === 'private') Object.assign(packet.messages[0], { privateHistory: 'PRIVATE' });
  if (field === 'duplicate') packet.messages.push(packet.messages[0]);
  const serialized = JSON.stringify(packet),
    fence = vi.fn();
  expect(() =>
    store.collaborationConversation.completeForwardPreparation(
      group,
      f.input.selection.requestId,
      {
        operatorId: field === 'actor' ? 'wrong' : 'operator',
        serialized,
        packetSha256: field === 'digest' ? '0'.repeat(64) : hash(serialized),
      },
      fence,
    ),
  ).toThrow();
  expect(fence).not.toHaveBeenCalled();
});

it.each(['short', 'long'] as const)(
  'retains %s source-null exact artifact metadata without pretending it is model input',
  (length) => {
    const f = fixture();
    const bytes = Buffer.from([0, 1, 255]);
    const pin = {
      artifactId: 'retained',
      revision: 2,
      sha256: hash(bytes),
      kind: 'retained_artifact' as const,
    };
    f.input.selection.sourceConversationId = null;
    f.input.selection.boundary = null;
    f.input.selection.messages = [];
    f.input.selection.artifacts = [pin];
    f.packet.sourceConversationId = null;
    f.packet.sourceIdentity = null;
    f.packet.boundary = null;
    f.packet.messages = [];
    f.packet.artifacts = [
      {
        ...pin,
        retention: 'independent',
        itemId: 'work-item',
        filename: length === 'short' ? 'opaque.bin' : 'f'.repeat(300),
        title: length === 'short' ? 'Retained source' : 'Retained source '.repeat(100),
        mediaType: 'application/octet-stream',
        provenance: { sessionId: 'gone-source', sourceKind: 'user_upload', sourcePath: null },
        sizeBytes: bytes.length,
        contentBase64: bytes.toString('base64'),
      },
    ];
    const result = f.complete();
    expect(result.state).toBe('prepared');
    expect(result.deliveries).toEqual([]);
    // Root's real host/media fence owns refusal; this storage record cannot bypass it.
    expect(() =>
      f.confirm(f.confirmInput(result), () => {
        throw Error('Unsupported ordinary input');
      }),
    ).toThrow('Unsupported ordinary input');
  },
);

it.each(['nonempty-messages', 'transcript-pin', 'missing-boundary'] as const)(
  'refuses invalid source-null %s selectors',
  (mode) => {
    const f = fixture();
    f.input.selection.sourceConversationId = null;
    f.input.selection.boundary = null;
    f.input.selection.artifacts = [
      { kind: 'retained_artifact', artifactId: 'saved', revision: 1, sha256: 'a'.repeat(64) },
    ];
    if (mode !== 'nonempty-messages') f.input.selection.messages = [];
    if (mode === 'transcript-pin') f.input.selection.artifacts[0].kind = 'transcript_reference';
    if (mode === 'missing-boundary') f.input.selection.sourceConversationId = 'source';
    expect(() => f.reserve()).toThrow();
  },
);

it.each(['membership', 'settings'] as const)(
  'rechecks actual current %s before first completion and confirmation',
  (phase) => {
    const f = fixture();
    const first = f.reserve();
    if (phase === 'membership')
      store.setSessionCollaboration(group, {
        expectedRevision: 1,
        participantSessionIds: ['one', 'other'],
      });
    else {
      store.claimOrdinaryLocalCommandDispatch('initial-one');
      store.completeOrdinaryLocalCommand('initial-one');
      store.admitOrdinaryLocalContinuation(
        {
          sessionId: 'one',
          cwd: '/offline',
          repositoryWorkspaceId: 'workspace-one',
          mode: 'ask',
          selectedModel: 'different-model',
          accountBinding: { ...binding.account, accountLabel: 'Offline', model: 'different-model' },
        },
        binding,
        {
          clientMsgId: 'later-one',
          requestFingerprint: 'different-settings',
          selection: { ...selection, model: 'different-model' },
          payload: { text: 'Explicit changed model' },
        },
      );
    }
    expect(() => f.complete(first)).toThrow();
  },
);

it('confirms only explicit context recipients, ignoring default responder and reader policies', () => {
  const f = fixture();
  const prepared = f.prepare().publicRecord;
  store.collaborationConversation.setPolicy(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    expectedRevision: 0,
    sessionId: 'other',
    readsFutureDiscussion: true,
    repliesByDefault: true,
  });
  const before = store.listSessions();
  const receipt = f.confirm(f.confirmInput(prepared));
  const message = store.collaborationConversation.getMessage(group, receipt.messageId)!;
  expect(message).toMatchObject({
    author: 'operator',
    text: '',
    source: null,
    snapshot: null,
    replyToDeliveryId: null,
    responders: [],
    readers: ['two', 'one'],
    forward: { forwardId: prepared.forwardId, packetSha256: prepared.packetSha256 },
  });
  expect(
    message.deliveries.map((d) => ({
      sessionId: d.sessionId,
      purpose: d.purpose,
      status: d.status,
      commandId: d.commandId,
    })),
  ).toEqual(
    ['two', 'one'].map((sessionId) => ({
      sessionId,
      purpose: 'context',
      status: 'pending',
      commandId: null,
    })),
  );
  expect(store.listSessions()).toEqual(before);
  expect(JSON.stringify(receipt)).not.toMatch(/operatorId|settings|serialized|Exact/);
});

it.each(['missing', 'promise', 'value', 'refusal'] as const)(
  'requires a synchronous %s first confirmation fence, with no partial writes',
  (mode) => {
    const f = fixture();
    const prepared = f.prepare().publicRecord;
    const input = f.confirmInput(prepared);
    const fence =
      mode === 'missing'
        ? undefined
        : mode === 'promise'
          ? () => Promise.resolve()
          : mode === 'value'
            ? () => true
            : () => {
                throw Error('scope changed');
              };
    const cursor = store.collaborationConversation.view(group).cursor;
    expect(() =>
      store.collaborationConversation.confirmForward(
        group,
        { operatorId: 'operator', input },
        fence!,
      ),
    ).toThrow();
    expect(store.collaborationConversation.view(group).cursor).toBe(cursor);
    expect(
      store.collaborationConversation.readForward(group, 'operator', prepared.forwardId)
        .confirmation,
    ).toBeNull();
  },
);

it('recovers immutable confirmation IDs while exact reads expose independent current outcomes', () => {
  const f = fixture();
  const prepared = f.prepare().publicRecord;
  const input = f.confirmInput(prepared);
  const receipt = f.confirm(input);
  const [first, second] = receipt.deliveries;
  store.collaborationConversation.recordDelivery(group, receipt.messageId, first.deliveryId, {
    requestId: randomUUID(),
    expectedRevision: 0,
    status: 'delivered',
    commandId: 'explicit-command',
    reason: null,
  });
  store.collaborationConversation.recordDelivery(group, receipt.messageId, second.deliveryId, {
    requestId: randomUUID(),
    expectedRevision: 0,
    status: 'unavailable',
    commandId: null,
    reason: 'Recipient unavailable',
  });
  store.setSessionCollaboration(group, { expectedRevision: 1, participantSessionIds: ['other'] });
  store.close();
  store = new EventStore(path);
  expect(
    f.confirm(input, () => {
      throw Error('must not repeat effect');
    }),
  ).toEqual(receipt);
  expect(
    store.collaborationConversation
      .readForward(group, 'operator', prepared.forwardId)
      .deliveries.map((d) => d.status),
  ).toEqual(['delivered', 'unavailable']);
  expect(() => f.confirm({ ...input, requestId: randomUUID() })).toThrow('request_conflict');
  expect(() =>
    f.confirm({ ...input, forward: { ...input.forward, packetSha256: 'a'.repeat(64) } }),
  ).toThrow('request_conflict');
});

it('refuses stale membership and changed settings before first confirmation', () => {
  const f = fixture();
  const prepared = f.prepare().publicRecord;
  const input = f.confirmInput(prepared);
  expect(() => f.confirm({ ...input, expectedMembershipRevision: 0 })).toThrow();
  store.hideSession('one');
  expect(() => f.confirm(input)).toThrow();
});

it('rejects request-reply and public normal-prompt attempts to smuggle a forward reference', () => {
  const f = fixture();
  const prepared = f.prepare().publicRecord;
  expect(() => f.confirm({ ...f.confirmInput(prepared), requestReply: true } as never)).toThrow();
  expect(() =>
    store.collaborationConversation.acceptMessage(group, {
      requestId: randomUUID(),
      expectedMembershipRevision: 1,
      expectedPolicySequence: store.collaborationConversation.view(group).policySequence,
      text: 'Prompt',
      responders: { kind: 'selected', sessionIds: ['one'] },
      snapshot: null,
      forward: { forwardId: prepared.forwardId, packetSha256: prepared.packetSha256 },
    }),
  ).toThrow();
});

it('preserves legacy message JSON and only permits empty operator text for valid context forwarding', () => {
  const f = fixture();
  const prepared = f.prepare().publicRecord;
  const receipt = f.confirm(f.confirmInput(prepared));
  const message = store.collaborationConversation.getMessage(group, receipt.messageId)!;
  expect(CollaborationMessageSchema.parse(message)).toEqual(message);
  expect(() => CollaborationMessageSchema.parse({ ...message, forward: undefined })).toThrow();
  expect(() => CollaborationMessageSchema.parse({ ...message, responders: ['one'] })).toThrow();
  const ordinary = store.collaborationConversation.acceptMessage(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    expectedPolicySequence: store.collaborationConversation.view(group).policySequence,
    text: 'Explicit prompt',
    responders: { kind: 'selected', sessionIds: ['one'] },
    snapshot: null,
  });
  expect(JSON.stringify(CollaborationMessageSchema.parse(ordinary))).toBe(JSON.stringify(ordinary));
  expect(ordinary).not.toHaveProperty('forward');
});

it('keeps context refusal after removal and reentry while retaining original observed outcome IDs', () => {
  const f = fixture();
  const receipt = f.confirm();
  store.setSessionCollaboration(group, { expectedRevision: 1, participantSessionIds: ['other'] });
  store.setSessionCollaboration(group, {
    expectedRevision: 2,
    participantSessionIds: ['one', 'two', 'other'],
  });
  expect(() =>
    store.collaborationConversation.assertCurrentDeliveryRecipient(
      group,
      receipt.messageId,
      receipt.deliveries[0].deliveryId,
      'two',
    ),
  ).toThrow('reply_conflict');
});

it.each(['complete', 'confirm'] as const)(
  'rolls back reentrant %s mutations instead of duplicating a forward',
  (phase) => {
    const f = fixture();
    if (phase === 'complete') {
      const record = f.reserve();
      expect(() =>
        f.complete(record, JSON.stringify(f.packet), () => {
          f.complete(record);
        }),
      ).toThrow('conflict');
      expect(
        store.collaborationConversation.getForwardPreparation(
          group,
          'operator',
          f.input.selection.requestId,
        )?.serialized,
      ).toBeNull();
    } else {
      const prepared = f.prepare().publicRecord,
        input = f.confirmInput(prepared);
      expect(() =>
        f.confirm(input, () => {
          f.confirm({ ...input, requestId: randomUUID() });
        }),
      ).toThrow('conflict');
      expect(
        store.collaborationConversation.readForward(group, 'operator', prepared.forwardId)
          .confirmation,
      ).toBeNull();
      expect(store.collaborationConversation.view(group).messages).toEqual([]);
    }
  },
);

it.each(['whitespace', 'duplicate-key', 'packet-bytes', 'combined-note-bytes'] as const)(
  'rejects unsupported %s packet custody before the fence',
  (mode) => {
    const f = fixture();
    if (mode === 'combined-note-bytes') f.input.note = 'π'.repeat(20_000);
    const record = f.reserve();
    let serialized = JSON.stringify(f.packet);
    if (mode === 'whitespace') serialized = ' ' + serialized;
    if (mode === 'duplicate-key')
      serialized = serialized.replace('"version":1', '"version":1,"version":1');
    // A valid string value keeps the byte-bound check independent of structural parsing.
    if (mode === 'packet-bytes' || mode === 'combined-note-bytes') {
      const limit = mode === 'packet-bytes' ? 512 * 1024 : 500 * 1024;
      serialized = JSON.stringify({ ...f.packet, padding: 'a'.repeat(limit - serialized.length) });
    }
    const fence = vi.fn();
    expect(() => f.complete(record, serialized, fence)).toThrow(
      mode === 'packet-bytes' || mode === 'combined-note-bytes'
        ? 'capacity_refused'
        : 'snapshot_changed',
    );
    expect(fence).not.toHaveBeenCalled();
    expect(
      store.collaborationConversation.getForwardPreparation(
        group,
        'operator',
        f.input.selection.requestId,
      ),
    ).toEqual(record);
  },
);

it('refuses actual target model drift before a first confirmation without changing its preparation', () => {
  const f = fixture(),
    prepared = f.prepare().publicRecord;
  store.claimOrdinaryLocalCommandDispatch('initial-one');
  store.completeOrdinaryLocalCommand('initial-one');
  store.admitOrdinaryLocalContinuation(
    {
      sessionId: 'one',
      cwd: '/offline',
      repositoryWorkspaceId: 'workspace-one',
      mode: 'ask',
      selectedModel: 'different-model',
      accountBinding: { ...binding.account, accountLabel: 'Offline', model: 'different-model' },
    },
    binding,
    {
      clientMsgId: 'later-one',
      requestFingerprint: 'different-settings',
      selection: { ...selection, model: 'different-model' },
      payload: { text: 'Explicit changed model' },
    },
  );
  const fence = vi.fn();
  expect(() => f.confirm(f.confirmInput(prepared), fence)).toThrow('unavailable_recipient');
  expect(fence).not.toHaveBeenCalled();
  expect(
    store.collaborationConversation.readForward(group, 'operator', prepared.forwardId),
  ).toEqual(prepared);
});

it.each(['__proto__', 'constructor'] as const)(
  'handles %s recipient IDs without corrupting a durable settings reservation',
  (specialId) => {
    for (const sessionId of [specialId]) {
      store.admitOrdinaryLocalCommand(
        {
          sessionId,
          selectedModel: selection.model,
          mode: 'ask',
          cwd: '/offline',
          accountBinding: { ...binding.account, accountLabel: 'Offline', model: selection.model },
          repositoryWorkspaceId: `workspace-${sessionId}`,
        },
        binding,
        {
          clientMsgId: `initial-${sessionId}`,
          requestFingerprint: `initial-${sessionId}`,
          selection,
          payload: { text: 'Offline fixture' },
        },
      );
    }
    store.setSessionCollaboration(group, {
      expectedRevision: 1,
      participantSessionIds: [specialId],
    });
    const f = fixture();
    f.input.selection.target.sessionIds = [specialId];
    f.input.selection.target.expectedMembershipRevision = 2;
    if (specialId === '__proto__') {
      expect(() => f.reserve()).toThrow();
      expect(
        store.collaborationConversation.getForwardPreparation(
          group,
          'operator',
          f.input.selection.requestId,
        ),
      ).toBeNull();
      expect(
        database((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM collaboration_records WHERE kind='forward-preparation'",
            )
            .get(),
        ),
      ).toEqual({ n: 0 });
      return;
    }
    const record = f.reserve();
    expect(Object.hasOwn(record.settings, specialId)).toBe(true);
    const prepared = f.complete(record);
    const receipt = f.confirm({ ...f.confirmInput(prepared), expectedMembershipRevision: 2 });
    const message = store.collaborationConversation.getMessage(group, receipt.messageId)!;
    expect(Object.keys(message.settings)).toEqual([specialId]);
    expect(message.deliveries.map((d) => d.sessionId)).toEqual([specialId]);
  },
);
