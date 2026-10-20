import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollaborationContractError } from '@mitzo/protocol';
import { EventStore } from '../event-store.js';
import { createCollaborationContextSource } from '../collaboration-context-source.js';
import { prepareCollaborationForward } from '../collaboration-forwarding.js';

const literal = '  Exact\r\nπ selected answer  ';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const binding = {
  version: 2,
  account: { accountId: 'offline', provider: 'openai-codex', profileRevision: 'r1' },
  harness: { implementation: 'codex' },
  execution: { location: 'local', targetId: 'offline-mac', targetRevision: 'r1' },
} as const;
const ordinarySelection = {
  version: 1,
  agent: { profileId: 'default-mitzo', revision: 1, kind: 'builtin' },
  context: { source: 'none', revision: null },
  permission: { mode: 'ask', revision: 0 },
  model: 'offline-fixture',
  thinking: null,
} as const;
let root: string, path: string, store: EventStore, group: string;
let operatorCurrent: boolean;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-forward-save-fence-')));
  path = join(root, 'events.db');
  store = new EventStore(path);
  operatorCurrent = true;
  group = randomUUID();
  for (const sessionId of ['source', 'recipient', 'observer']) {
    store.admitOrdinaryLocalCommand(
      {
        sessionId,
        selectedModel: ordinarySelection.model,
        mode: 'ask',
        cwd: '/offline',
        accountBinding: { ...binding.account, accountLabel: 'Offline', model: 'offline-fixture' },
        repositoryWorkspaceId: `workspace-${sessionId}`,
      },
      binding,
      {
        clientMsgId: `initial-${sessionId}`,
        requestFingerprint: `initial-${sessionId}`,
        selection: ordinarySelection,
        payload: { text: 'Explicit ordinary command' },
      },
    );
  }
  store.setSessionCollaboration(group, {
    expectedRevision: 0,
    participantSessionIds: ['recipient', 'observer'],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  store.append('source', 'message_start', { messageId: 'answer' });
  for (const [blockId, blockType, text] of [
    ['reasoning', 'thinking', 'PRIVATE REASONING'],
    ['chosen', 'text', literal],
    ['other', 'text', 'UNSELECTED BLOCK'],
  ]) {
    store.append('source', 'block_start', { messageId: 'answer', blockId, blockType });
    store.append('source', 'block_delta', { messageId: 'answer', blockId, delta: text });
    store.append('source', 'block_end', { messageId: 'answer', blockId, blockType });
  }
  const sequence = store.append('source', 'message_end', { messageId: 'answer' });
  const selection = {
    requestId: randomUUID(),
    target: { collaborationId: group, expectedMembershipRevision: 1, sessionIds: ['recipient'] },
    sourceConversationId: 'source',
    boundary: { sequence, messageId: 'answer' },
    messages: [
      {
        messageId: 'answer',
        sequence,
        blocks: [{ blockId: 'chosen', sha256: hash(literal) }],
      },
    ],
    artifacts: [],
  };
  const reserved = store.collaborationConversation.reserveForwardPreparation(group, {
    operatorId: 'operator',
    input: { selection, note: 'Explicit context only' },
  });
  const opened = vi.spyOn(store, 'openCollaborationVisibleSource');
  const source = createCollaborationContextSource({
    store,
    authorizeConversation: async () => {
      if (!operatorCurrent) throw new CollaborationContractError('snapshot_changed');
    },
    assertConversationCurrent(sessionId) {
      if (sessionId !== 'source' || !operatorCurrent)
        throw new CollaborationContractError('snapshot_changed');
    },
  });
  const renewal = vi.spyOn(source, 'assertCurrentAtSave');
  const packet = await prepareCollaborationForward(selection, {
    source,
    authorizeTarget: async () => {},
  });
  // The producer's original private capability is the only source save fence.
  // Reopening the source here would lose the observations whose freshness matters.
  const complete = (fence = packet.assertLocalMaterialCurrent) =>
    store.collaborationConversation.completeForwardPreparation(
      group,
      selection.requestId,
      { operatorId: 'operator', serialized: packet.serialized, packetSha256: packet.sha256 },
      fence,
    );
  const confirm = (fence = packet.assertLocalMaterialCurrent) =>
    store.collaborationConversation.confirmForward(
      group,
      {
        operatorId: 'operator',
        input: {
          requestId: randomUUID(),
          expectedMembershipRevision: 1,
          forward: {
            forwardId: reserved.forwardId,
            selectionFingerprint: reserved.selectionFingerprint,
            packetSha256: packet.sha256,
          },
          requestReply: false,
        },
      },
      fence,
    );
  const snapshot = () => ({
    preparation: store.collaborationConversation.getForwardPreparation(
      group,
      'operator',
      selection.requestId,
    ),
    view: store.collaborationConversation.view(group),
    events: store.collaborationConversation.events(group),
    deliveryEvents: store.getOrdinaryCollaborationDeliveryEvents('recipient', 'initial-recipient'),
  });
  return { packet, reserved, opened, renewal, complete, confirm, snapshot };
}

const phases = ['complete', 'confirm'] as const;
const changes = ['canonical-source metadata', 'privacy', 'operator'] as const;
type Change = (typeof changes)[number];
function changeSource(change: Change) {
  // Public EventStore mutations use the same connection as its private save transaction.
  if (change === 'canonical-source metadata')
    store.upsertSession({ sessionId: 'source', initialPrompt: 'Changed canonical source' });
  else if (change === 'privacy') store.hideSession('source');
  else operatorCurrent = false;
}
function expectRefusal(run: () => unknown, code: string) {
  let refusal: unknown;
  try {
    run();
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toMatchObject({ code });
}

it.each(
  phases.flatMap((phase) =>
    changes.flatMap((change) =>
      (['after preparation', 'inside save callback'] as const).map((timing) => ({
        phase,
        change,
        timing,
      })),
    ),
  ),
)(
  'renews the original message-only source for $phase after $change changes $timing',
  async ({ phase, change, timing }) => {
    const f = await fixture();
    if (phase === 'confirm') f.complete();
    const before = f.snapshot();
    const renewals = f.renewal.mock.calls.length;
    const originalSession = store.getSession('source');
    const fence = vi.fn(() => {
      if (timing === 'inside save callback') changeSource(change);
      f.packet.assertLocalMaterialCurrent();
    });
    if (timing === 'after preparation') changeSource(change);
    expectRefusal(
      () => f[phase](fence),
      change === 'privacy' ? 'unavailable_recipient' : 'snapshot_changed',
    );
    expect(fence).toHaveBeenCalledOnce();
    expect(f.renewal.mock.calls.length).toBeGreaterThan(renewals);
    expect(f.snapshot()).toEqual(before);
    expect(f.opened).toHaveBeenCalledOnce();
    if (timing === 'inside save callback')
      expect(store.getSession('source')).toEqual(originalSession);
  },
);

it.each(phases)(
  'refuses %s after selected source bytes change without replacing the original witness',
  async (phase) => {
    const f = await fixture();
    if (phase === 'confirm') f.complete();
    const before = f.snapshot();
    const fault = new Database(path);
    try {
      expect(
        fault
          .prepare(
            "UPDATE events SET payload=json_set(payload,'$.delta',?) WHERE session_id=? AND type='block_delta' AND json_extract(payload,'$.blockId')=?",
          )
          .run('CHANGED SELECTED BYTES', 'source', 'chosen').changes,
      ).toBe(1);
    } finally {
      fault.close();
    }
    expectRefusal(() => f[phase](), 'snapshot_changed');
    expect(f.snapshot()).toEqual(before);
    expect(f.opened).toHaveBeenCalledOnce();
  },
);

it('retains exact valid literal bytes and custody through both private transactions without a send', async () => {
  const f = await fixture();
  const sessions = store.listSessions();
  const prepared = f.complete();
  const confirmed = f.confirm();
  expect(f.opened).toHaveBeenCalledOnce();
  expect(f.packet.packet.messages[0].blocks).toEqual([
    { blockId: 'chosen', content: literal, sha256: hash(literal) },
  ]);
  expect(f.packet.packet.artifacts).toEqual([]);
  expect(f.packet.serialized).not.toMatch(/PRIVATE|UNSELECTED/);
  const retained = store.collaborationConversation.getForwardPacket(group, {
    forwardId: f.reserved.forwardId,
    packetSha256: prepared.packetSha256,
  });
  expect(retained.serialized).toBe(f.packet.serialized);
  expect(hash(retained.serialized)).toBe(f.packet.sha256);
  expect(confirmed.deliveries).toEqual([
    expect.objectContaining({
      sessionId: 'recipient',
      purpose: 'context',
      status: 'pending',
      commandId: null,
      revision: 0,
    }),
  ]);
  expect(store.collaborationConversation.getMessage(group, confirmed.messageId)).toMatchObject({
    forward: { forwardId: f.reserved.forwardId, packetSha256: f.packet.sha256 },
    responders: [],
  });
  expect(store.getOrdinaryCollaborationDeliveryEvents('recipient', 'initial-recipient')).toEqual(
    [],
  );
  expect(store.listSessions()).toEqual(sessions);
});
