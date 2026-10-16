import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { EventStore } from '../src/event-store.js';
import { CollaborationContractError } from '../src/collaboration-conversation.js';

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
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-conversation-')));
  path = join(directory, 'events.db');
  store = new EventStore(path);
  group = randomUUID();
  for (const sessionId of ['one', 'two', 'reader']) {
    store.admitOrdinaryLocalCommand(
      {
        sessionId,
        selectedModel: 'offline-fixture',
        mode: 'agent',
        cwd: '/fixture',
        accountBinding: { ...binding.account, accountLabel: 'Fixture', model: 'offline-fixture' },
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
  }
  store.setSessionCollaboration(group, {
    expectedRevision: 0,
    participantSessionIds: ['one', 'two', 'reader'],
  });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
function policy(
  sessionId: string,
  readsFutureDiscussion: boolean,
  repliesByDefault: boolean,
  expectedRevision = 0,
) {
  return {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    expectedRevision,
    sessionId,
    readsFutureDiscussion,
    repliesByDefault,
  };
}
function prompt() {
  return {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    expectedPolicySequence: store.collaborationConversation.view(group).policySequence,
    text: 'Review this',
    responders: { kind: 'default' },
    snapshot: null,
  } as const;
}
function snapshotDraft() {
  return {
    requestId: randomUUID(),
    sourceConversationId: 'one',
    boundary: { sequence: 7, messageId: 'm1' },
    mode: 'selected',
    purpose: 'Review the change',
    joiningBrief: 'Check edge cases',
    messages: [
      {
        conversationId: 'one',
        messageId: 'm1',
        sequence: 7,
        author: 'operator',
        source: null,
        blocks: [{ blockId: 'b1', content: 'Original source', sha256: 'ignored' }],
      },
    ],
    artifacts: [
      {
        artifactId: 'artifact',
        revision: 2,
        sha256: 'a'.repeat(64),
        sourceConversationId: 'one',
        mediaType: 'text/plain',
        sizeBytes: 100,
      },
    ],
    capacity: {
      status: 'ready',
      assessments: [
        { settings, availableTokens: 1000, estimatedTokens: 80, estimatorRevision: 'fixture-v1' },
      ],
    },
    summary: null,
  } as const;
}

it('versions each policy, guards concurrent edits and recovers old exact retries after restart', () => {
  const change = policy('two', true, true);
  const first = store.collaborationConversation.setPolicy(group, change);
  expect(first).toMatchObject({ revision: 1, effectiveFromSequence: 2 });
  store.collaborationConversation.setPolicy(group, policy('two', false, false, 1));
  expect(() =>
    store.collaborationConversation.setPolicy(group, policy('two', true, false)),
  ).toThrow('conflict');
  store.close();
  store = new EventStore(path);
  expect(store.collaborationConversation.setPolicy(group, change)).toEqual(first);
  expect(() =>
    store.collaborationConversation.setPolicy(group, { ...change, repliesByDefault: false }),
  ).toThrow('request_conflict');
  expect(store.collaborationConversation.view(group).cursor).toBe(2);
});

it('freezes policy, readers, stable identities and ordinary settings before effects; readers never reply', () => {
  store.collaborationConversation.setPolicy(group, policy('two', false, true));
  store.collaborationConversation.setPolicy(group, policy('reader', true, false));
  const input = prompt();
  const accepted = store.collaborationConversation.acceptMessage(group, input);
  expect(accepted.responders).toEqual(['two']);
  expect(accepted.readers).toEqual(['reader', 'two']);
  expect(accepted.deliveries.map((d) => [d.sessionId, d.purpose, d.status])).toEqual([
    ['reader', 'context', 'pending'],
    ['two', 'reply', 'pending'],
  ]);
  expect(accepted.settings.two.selection.model).toBe('offline-fixture');
  store.collaborationConversation.setPolicy(group, policy('two', true, false, 1));
  store.hideSession('two');
  store.close();
  store = new EventStore(path);
  expect(store.collaborationConversation.acceptMessage(group, input)).toEqual(accepted);
  expect(store.getSessionEvents('two')).toEqual([]);
  expect(store.listSessions()).toHaveLength(2);
});

it('refuses stale, unknown, unavailable and empty responders without broadcasting or partial writes', () => {
  const before = store.collaborationConversation.view(group).cursor;
  expect(() => store.collaborationConversation.acceptMessage(group, prompt())).toThrow(
    'no_responders',
  );
  for (const id of ['@alias', 'missing'])
    expect(() =>
      store.collaborationConversation.acceptMessage(group, {
        ...prompt(),
        responders: { kind: 'selected', sessionIds: [id] },
      }),
    ).toThrow('unknown_recipient');
  store.hideSession('two');
  expect(() =>
    store.collaborationConversation.acceptMessage(group, {
      ...prompt(),
      responders: { kind: 'all' },
    }),
  ).toThrow('unavailable_recipient');
  store.collaborationConversation.setPolicy(group, policy('one', false, true));
  expect(() =>
    store.collaborationConversation.acceptMessage(group, {
      ...prompt(),
      expectedPolicySequence: 0,
    }),
  ).toThrow('conflict');
  expect(store.collaborationConversation.view(group).cursor).toBe(before + 1);
});

it('retains independent partial outcomes and CAS receipts across replay without resending successes', () => {
  const accepted = store.collaborationConversation.acceptMessage(group, {
    ...prompt(),
    responders: { kind: 'selected', sessionIds: ['one', 'two'] },
  });
  const [one, two] = accepted.deliveries;
  const receipt = {
    requestId: randomUUID(),
    expectedRevision: 0,
    status: 'delivered',
    commandId: 'ordinary-command-one',
    reason: null,
  } as const;
  store.collaborationConversation.recordDelivery(
    group,
    accepted.messageId,
    one.deliveryId,
    receipt,
  );
  store.collaborationConversation.recordDelivery(group, accepted.messageId, two.deliveryId, {
    requestId: randomUUID(),
    expectedRevision: 0,
    status: 'unavailable',
    commandId: null,
    reason: 'Account revoked',
  });
  store.close();
  store = new EventStore(path);
  expect(
    store.collaborationConversation.recordDelivery(
      group,
      accepted.messageId,
      one.deliveryId,
      receipt,
    ),
  ).toMatchObject({ revision: 1, status: 'delivered' });
  expect(() =>
    store.collaborationConversation.recordDelivery(group, accepted.messageId, one.deliveryId, {
      ...receipt,
      requestId: randomUUID(),
      expectedRevision: 1,
      status: 'pending',
    }),
  ).toThrow('invalid_transition');
  const view = store.collaborationConversation.view(group);
  expect(view.messages[0].deliveries.map((d) => d.status)).toEqual(['delivered', 'unavailable']);
  expect(store.collaborationConversation.events(group, 1).events.map((e) => e.sequence)).toEqual([
    2, 3,
  ]);
});

it('pins source IDs, bytes and artifact hashes after source edits; reviewed digest is required', () => {
  const draft = JSON.parse(JSON.stringify(snapshotDraft()));
  const frozen = store.collaborationConversation.saveSnapshot(group, draft);
  draft.messages[0].blocks[0].content = 'Edited source';
  draft.artifacts[0].revision = 3;
  expect(store.collaborationConversation.getSnapshot(group, frozen.snapshotId)).toEqual(frozen);
  expect(frozen.messages[0].blocks[0].sha256).not.toBe('ignored');
  const input = {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    name: 'Reviewer',
    settings,
    snapshot: { snapshotId: frozen.snapshotId, sha256: frozen.sha256 },
  };
  expect(() =>
    store.collaborationConversation.prepareJoin(group, {
      ...input,
      snapshot: { ...input.snapshot, sha256: 'b'.repeat(64) },
    }),
  ).toThrow('snapshot_changed');
  const pending = store.collaborationConversation.prepareJoin(group, input);
  expect(pending).toMatchObject({ state: 'pending_preparation', sessionId: null });
  expect(store.listSessions()).toHaveLength(3);
});

it('keeps brief-only explicit and refuses capacity overflow or unreviewed summaries without truncation', () => {
  const frozen = store.collaborationConversation.saveSnapshot(group, {
    ...snapshotDraft(),
    messages: [],
    artifacts: [],
  });
  expect(frozen.messages).toEqual([]);
  const refused = store.collaborationConversation.saveSnapshot(group, {
    ...snapshotDraft(),
    capacity: { status: 'needs_reviewed_summary', reason: 'Over target capacity' },
  });
  expect(refused.messages[0].blocks[0].content).toBe('Original source');
  expect(() =>
    store.collaborationConversation.prepareJoin(group, {
      requestId: randomUUID(),
      expectedMembershipRevision: 1,
      name: 'Reviewer',
      settings,
      snapshot: { snapshotId: refused.snapshotId, sha256: refused.sha256 },
    }),
  ).toThrow('capacity_refused');
});

it('retains a real allocation before link conflict; recovery links the same session without allocation', () => {
  const snapshot = store.collaborationConversation.saveSnapshot(group, {
    ...snapshotDraft(),
    messages: [],
    artifacts: [],
  });
  const pending = store.collaborationConversation.prepareJoin(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    name: 'Reviewer',
    settings,
    snapshot: { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 },
  });
  store.admitOrdinaryLocalCommand(
    {
      sessionId: 'fresh-real',
      selectedModel: 'offline-fixture',
      cwd: '/fixture',
      repositoryWorkspaceId: 'workspace',
      accountBinding: { ...binding.account, accountLabel: 'Fixture', model: 'offline-fixture' },
    },
    binding,
    {
      clientMsgId: pending.allocationOperationId,
      requestFingerprint: 'fresh-fixture',
      selection,
      payload: { text: 'Offline fixture' },
    },
  );
  const allocation = {
    operationId: pending.allocationOperationId,
    sessionId: 'fresh-real',
    settings,
  };
  store.collaborationConversation.recordAllocation(group, pending.joinId, allocation);
  store.setSessionCollaboration(group, {
    expectedRevision: 1,
    participantSessionIds: ['one', 'two'],
  });
  expect(() => store.collaborationConversation.linkJoin(group, pending.joinId, 1)).toThrow(
    'conflict',
  );
  store.close();
  store = new EventStore(path);
  expect(store.collaborationConversation.getJoin(group, pending.joinId)).toMatchObject({
    state: 'allocated',
    sessionId: 'fresh-real',
  });
  expect(
    store.collaborationConversation.recordAllocation(group, pending.joinId, allocation).sessionId,
  ).toBe('fresh-real');
  expect(() =>
    store.collaborationConversation.recordAllocation(group, pending.joinId, {
      ...allocation,
      sessionId: 'replacement',
    }),
  ).toThrow('allocation_conflict');
  expect(store.collaborationConversation.linkJoin(group, pending.joinId, 2)).toMatchObject({
    state: 'linked',
    sessionId: 'fresh-real',
  });
  expect(store.getSessionCollaboration(group)?.participantSessionIds).toContain('fresh-real');
});

it('backs up the complete journal, receipts, snapshots and pending joins through EventStore', async () => {
  const input = policy('one', true, true);
  store.collaborationConversation.setPolicy(group, input);
  store.collaborationConversation.acceptMessage(group, prompt());
  const snapshot = store.collaborationConversation.saveSnapshot(group, snapshotDraft());
  const before = store.backupWatermark();
  const pending = store.collaborationConversation.prepareJoin(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    name: 'Reviewer',
    settings,
    snapshot: { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 },
  });
  expect(store.backupWatermark()).not.toBe(before);
  const destination = join(directory, 'backup.db');
  await store.backupSnapshot(destination);
  const backup = new EventStore(destination);
  try {
    expect(backup.collaborationConversation.view(group)).toEqual(
      store.collaborationConversation.view(group),
    );
    expect(backup.collaborationConversation.getJoin(group, pending.joinId)).toEqual(pending);
    expect(backup.collaborationConversation.getSnapshot(group, snapshot.snapshotId)).toEqual(
      snapshot,
    );
    expect(backup.collaborationConversation.setPolicy(group, input)).toMatchObject({ revision: 1 });
  } finally {
    backup.close();
  }
  expect(new CollaborationContractError('conflict').code).toBe('conflict');
});

it('projects membership atomically and does not restore old reader policy on re-enrollment', () => {
  store.collaborationConversation.setPolicy(group, policy('two', true, true));
  const before = store.collaborationConversation.view(group).cursor;
  store.setSessionCollaboration(group, {
    expectedRevision: 1,
    participantSessionIds: ['one', 'reader'],
  });
  expect(store.collaborationConversation.events(group, before).events[0].change).toMatchObject({
    kind: 'membership',
    membership: { revision: 2, participantSessionIds: ['one', 'reader'] },
  });
  store.setSessionCollaboration(group, {
    expectedRevision: 2,
    participantSessionIds: ['one', 'two', 'reader'],
  });
  expect(
    store.collaborationConversation.view(group).policies.find((p) => p.sessionId === 'two'),
  ).toMatchObject({
    revision: 2,
    membershipRevision: 3,
    effectiveFromSequence: store.collaborationConversation.view(group).cursor + 1,
    readsFutureDiscussion: false,
    repliesByDefault: false,
  });
});

it('serializes competing connections and keeps keyed message retries immutable after later messages', () => {
  const second = new EventStore(path);
  try {
    store.collaborationConversation.setPolicy(group, policy('one', false, true));
    expect(() =>
      second.collaborationConversation.setPolicy(group, policy('one', true, true)),
    ).toThrow('conflict');
    const input = prompt();
    const accepted = store.collaborationConversation.acceptMessage(group, input);
    second.collaborationConversation.acceptMessage(group, prompt());
    expect(second.collaborationConversation.acceptMessage(group, input)).toEqual(accepted);
    expect(() =>
      second.collaborationConversation.acceptMessage(group, {
        ...input,
        text: 'Different request',
      }),
    ).toThrow('request_conflict');
    expect(second.collaborationConversation.view(group).messages).toHaveLength(2);
  } finally {
    second.close();
  }
});

it('supports explicit one/several/all responders and isolates groups sharing ordinary members', () => {
  const other = randomUUID();
  store.setSessionCollaboration(other, {
    expectedRevision: 0,
    participantSessionIds: ['one', 'two'],
  });
  store.collaborationConversation.setPolicy(group, policy('reader', true, false));
  const selected = store.collaborationConversation.acceptMessage(group, {
    ...prompt(),
    responders: { kind: 'selected', sessionIds: ['two'] },
  });
  expect(selected.responders).toEqual(['two']);
  const all = store.collaborationConversation.acceptMessage(group, {
    ...prompt(),
    responders: { kind: 'all' },
  });
  expect(all.responders).toEqual(['one', 'reader', 'two']);
  expect(store.collaborationConversation.view(other).messages).toEqual([]);
  expect(store.getSessionEvents('one')).toEqual([]);
});

it('keeps source edits, boot instructions, and artifact revision updates outside a saved snapshot', () => {
  store.append('one', 'user_message', { messageId: 'm1', text: 'Original source' });
  const snapshot = store.collaborationConversation.saveSnapshot(group, snapshotDraft());
  store.append('one', 'user_message', { messageId: 'm1', text: 'Source edited after review' });
  store.upsertSession({ sessionId: 'one', bootContext: 'Independent boot instructions' });
  expect(store.collaborationConversation.getSnapshot(group, snapshot.snapshotId)).toMatchObject({
    messages: [{ messageId: 'm1', blocks: [{ blockId: 'b1', content: 'Original source' }] }],
    artifacts: [{ revision: 2, sha256: 'a'.repeat(64) }],
  });
  expect(() =>
    store.collaborationConversation.saveSnapshot(group, {
      ...snapshotDraft(),
      bootContext: 'Injected',
    }),
  ).toThrow();
});

it('requires a new review for a bounded attributed summary and preserves exact original source pins', () => {
  const original = store.collaborationConversation.saveSnapshot(group, {
    ...snapshotDraft(),
    capacity: { status: 'needs_reviewed_summary', reason: 'Original is too large' },
  });
  const summary = store.collaborationConversation.saveSnapshot(group, {
    ...snapshotDraft(),
    summary: {
      sourceSnapshotId: original.snapshotId,
      sourceSha256: original.sha256,
      content: 'Reviewed edge-case summary',
      author: 'operator',
    },
  });
  expect(summary.sha256).not.toBe(original.sha256);
  expect(summary.messages).toEqual(original.messages);
  expect(summary.artifacts).toEqual(original.artifacts);
  expect(summary.summary?.author).toBe('operator');
  expect(() =>
    store.collaborationConversation.saveSnapshot(group, {
      ...snapshotDraft(),
      summary: { ...summary.summary, sourceSha256: '0'.repeat(64) },
    }),
  ).toThrow('snapshot_changed');
  expect(() =>
    store.collaborationConversation.saveSnapshot(group, {
      ...snapshotDraft(),
      capacity: {
        status: 'ready',
        assessments: [
          { settings, availableTokens: 10, estimatedTokens: 11, estimatorRevision: 'fixture' },
        ],
      },
    }),
  ).toThrow();
});

it('fails closed on corrupt saved content, capacity bounds and foreign source boundaries', () => {
  const snapshot = store.collaborationConversation.saveSnapshot(group, snapshotDraft());
  const db = new Database(path);
  try {
    db.prepare(
      "UPDATE collaboration_records SET body=json_set(body,'$.messages[0].blocks[0].content','corrupt') WHERE kind='snapshot'",
    ).run();
  } finally {
    db.close();
  }
  expect(() => store.collaborationConversation.getSnapshot(group, snapshot.snapshotId)).toThrow(
    'snapshot_changed',
  );
  expect(() =>
    store.collaborationConversation.saveSnapshot(group, {
      ...snapshotDraft(),
      sourceConversationId: 'other',
    }),
  ).toThrow('snapshot_changed');
  expect(() =>
    store.collaborationConversation.saveSnapshot(group, {
      ...snapshotDraft(),
      boundary: { sequence: 6, messageId: null },
    }),
  ).toThrow('snapshot_changed');
  expect(() =>
    store.collaborationConversation.saveSnapshot(group, {
      ...snapshotDraft(),
      messages: [snapshotDraft().messages[0], snapshotDraft().messages[0]],
    }),
  ).toThrow('snapshot_changed');
});

it('refuses fabricated allocation receipts and preserves pending preparation without placeholder sessions', () => {
  const snapshot = store.collaborationConversation.saveSnapshot(group, {
    ...snapshotDraft(),
    messages: [],
    artifacts: [],
  });
  const pending = store.collaborationConversation.prepareJoin(group, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    name: 'Reviewer',
    settings,
    snapshot: { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 },
  });
  expect(() =>
    store.collaborationConversation.recordAllocation(group, pending.joinId, {
      operationId: pending.allocationOperationId,
      sessionId: 'one',
      settings,
    }),
  ).toThrow('allocation_conflict');
  expect(() => store.collaborationConversation.linkJoin(group, pending.joinId, 1)).toThrow(
    'invalid_transition',
  );
  expect(store.collaborationConversation.getJoin(group, pending.joinId)).toEqual(pending);
  expect(store.listSessions()).toHaveLength(3);
});

it('paginates replay with a stable high watermark and does not silently omit events', () => {
  for (let index = 0; index < 51; index++)
    store.collaborationConversation.setPolicy(group, policy('one', false, index % 2 === 0, index));
  const first = store.collaborationConversation.events(group);
  expect(first).toMatchObject({ cursor: 50, highWatermark: 51, hasMore: true });
  const second = store.collaborationConversation.events(group, first.cursor);
  expect(second).toMatchObject({ cursor: 51, highWatermark: 51, hasMore: false });
  expect(second.events).toHaveLength(1);
  expect(store.collaborationConversation.events(group, 51).events).toEqual([]);
});

it('binds reviewed capacity evidence to the exact joining execution selection', () => {
  const snapshot = store.collaborationConversation.saveSnapshot(group, snapshotDraft());
  expect(() =>
    store.collaborationConversation.prepareJoin(group, {
      requestId: randomUUID(),
      expectedMembershipRevision: 1,
      name: 'Reviewer',
      settings: { ...settings, selection: { ...selection, model: 'different-model' } },
      snapshot: { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 },
    }),
  ).toThrow('capacity_refused');
});

it('prepares the first Add agent from one ordinary chat without a placeholder second session', () => {
  const freshGroup = randomUUID(),
    requestId = randomUUID();
  store.upsertSession({ sessionId: 'solo', conversationSource: 'mitzo' });
  const prepared = store.collaborationConversation.begin(freshGroup, {
    requestId,
    sessionId: 'solo',
  });
  expect(prepared).toMatchObject({ revision: 1, participantSessionIds: ['solo'] });
  expect(
    store.collaborationConversation.begin(freshGroup, { requestId, sessionId: 'solo' }),
  ).toEqual(prepared);
  const snapshot = store.collaborationConversation.saveSnapshot(freshGroup, {
    ...snapshotDraft(),
    sourceConversationId: 'solo',
    messages: [],
    artifacts: [],
  });
  const pending = store.collaborationConversation.prepareJoin(freshGroup, {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    name: 'Reviewer',
    settings,
    snapshot: { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 },
  });
  expect(pending.sessionId).toBeNull();
  expect(store.getSessionCollaboration(freshGroup)?.participantSessionIds).toEqual(['solo']);
  expect(store.listSessions()).toHaveLength(4);
  expect(() =>
    store.collaborationConversation.begin(randomUUID(), {
      requestId: randomUUID(),
      sessionId: 'solo',
    }),
  ).toThrow('conflict');
  expect(() =>
    store.setSessionCollaboration(randomUUID(), {
      expectedRevision: 0,
      participantSessionIds: ['solo'],
    }),
  ).toThrow();
});

it('rolls membership back if its projection cannot commit', () => {
  const before = store.getSessionCollaboration(group);
  vi.spyOn(store.collaborationConversation, 'membershipChanged').mockImplementationOnce(() => {
    throw new Error('Injected journal failure');
  });
  expect(() =>
    store.setSessionCollaboration(group, {
      expectedRevision: 1,
      participantSessionIds: ['one', 'two'],
    }),
  ).toThrow('Injected journal failure');
  expect(store.getSessionCollaboration(group)).toEqual(before);
  expect(store.collaborationConversation.view(group).cursor).toBe(0);
});

it('bounds the initial message view and refuses oversized UTF-8 context without truncating it', () => {
  store.collaborationConversation.setPolicy(group, policy('one', false, true));
  for (let index = 0; index < 51; index++)
    store.collaborationConversation.acceptMessage(group, { ...prompt(), text: `Message ${index}` });
  const view = store.collaborationConversation.view(group);
  expect(view.messages).toHaveLength(50);
  expect(view.hasEarlierMessages).toBe(true);
  expect(view.messages[0].text).toBe('Message 1');
  expect(view.messages.at(-1)?.text).toBe('Message 50');
  const before = view.cursor;
  expect(() =>
    store.collaborationConversation.saveSnapshot(group, {
      ...snapshotDraft(),
      messages: [
        {
          ...snapshotDraft().messages[0],
          blocks: [{ blockId: 'large', content: 'é'.repeat(300_000), sha256: 'ignored' }],
        },
      ],
    }),
  ).toThrow('capacity_refused');
  expect(store.collaborationConversation.view(group).cursor).toBe(before);
});
